import { withTransaction, db } from '../../db/postgres.ts';
import { ambienteAtendimento, atendimentoAtivo, contatoPermitido, empresaPiloto } from './configuracao.ts';
import { MENSAGEM_ENCAMINHAMENTO, comandoDireto, dataDeInteresse, hojeOperacao, janelaAberta, responder, type ConfiguracaoAtendimento, type Interpretacao } from './core.ts';
import { configuracao, correlacionarStatus, limparStatusExpirados, recuperarTrabalhosInterrompidos, type Conversa, type Mensagem } from './service.ts';

export type DependenciasWorker = { interpretar(empresa: string, texto: string, config: ConfiguracaoAtendimento): Promise<Interpretacao>; enviar(contato: string, texto: string): Promise<string> };
/**
 * Saída parada na fila além deste prazo (automação, chave da IA ou empresa desligadas e religadas depois) não sai mais:
 * uma resposta de horas atrás chegaria fora de contexto. O atendente vê "Não enviada" e pode responder de novo.
 */
export const PRAZO_SAIDA_MS = 15 * 60 * 1000;
export function mensagemAindaValida(mensagem: Mensagem, conversa: Conversa, agora = new Date()) {
  if (conversa.nao_contatar || !janelaAberta(new Date(conversa.ultima_entrada_em), agora)) return false;
  if (mensagem.direcao === 'SAIDA' && agora.getTime() - new Date(mensagem.criada_em).getTime() > PRAZO_SAIDA_MS) return false;
  if (mensagem.autor_usuario_id) return janelaAberta(new Date(mensagem.criada_em),agora) && mensagem.direcao === 'SAIDA' && conversa.estado === 'HUMANO' && conversa.responsavel_id === mensagem.autor_usuario_id;
  return Number(mensagem.versao_conversa) === Number(conversa.versao) && (mensagem.direcao === 'ENTRADA' ? conversa.estado === 'IA' : ['IA','AGUARDANDO_HUMANO'].includes(conversa.estado));
}
/**
 * Uma resposta automática custa duas tarefas (interpretar a entrada e enviar a saída). Por isso cada chamada do
 * processador esvazia a fila em lote, até `maxTarefas` ou `prazoMs` (o prazo fica abaixo do timeout de 60 s do
 * worker externo, contando a pior tarefa: 15 s de modelo ou 10 s de envio). Vários workers podem rodar em paralelo:
 * a reserva usa SKIP LOCKED e cada conversa tem no máximo uma tarefa ativa.
 */
export async function processarLote(deps: DependenciasWorker, opcoes: { maxTarefas?: number; prazoMs?: number; relogio?: () => number } = {}) {
  const max = opcoes.maxTarefas ?? 20, prazo = opcoes.prazoMs ?? 30000, relogio = opcoes.relogio ?? Date.now;
  if (!atendimentoAtivo()) return { estado: 'DESLIGADO' as const, tarefas: 0 };
  await limparStatusExpirados();
  const inicio = relogio();
  let tarefas = 0;
  while (tarefas < max && relogio() - inicio < prazo) {
    const resultado = await processarAtendimento(deps);
    if (resultado === 'DESLIGADO' || resultado === 'SEM_TAREFA') return { estado: resultado, tarefas };
    tarefas++;
  }
  return { estado: 'LIMITE' as const, tarefas };
}
export async function processarAtendimento(deps: DependenciasWorker) {
  if (!atendimentoAtivo()) return 'DESLIGADO';
  await recuperarTrabalhosInterrompidos();
  const empresa = empresaPiloto(), ambiente = ambienteAtendimento();
  const tarefa = await withTransaction(async tx => {
    const config = await configuracao(tx, empresa);
    if (!config?.ativo || !(await tx.query("SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR SHARE", [empresa])).rows.length) return null;
    // Uma única tarefa por conversa; não mantém transação aberta durante chamada de IA.
    const mensagem = (await tx.query<Mensagem>(`SELECT m.* FROM whatsapp_atendimento_mensagens m
      WHERE m.empresa_id=$1 AND m.ambiente=$2 AND m.estado='PENDENTE'
      AND NOT EXISTS(SELECT 1 FROM whatsapp_atendimento_mensagens ativa WHERE ativa.conversa_id=m.conversa_id AND ativa.estado IN ('PROCESSANDO','ENVIANDO'))
      ORDER BY m.criada_em,m.id FOR UPDATE OF m SKIP LOCKED LIMIT 1`, [empresa, ambiente])).rows[0];
    if (!mensagem) return null;
    const conversa = (await tx.query<Conversa>('SELECT * FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE', [mensagem.conversa_id])).rows[0];
    // Revalidação após lock da conversa evita dois workers gerarem respostas simultâneas.
    // Perdeu a corrida para outro worker nesta conversa: não é fila vazia, o lote segue para as demais conversas.
    if ((await tx.query("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND estado IN ('PROCESSANDO','ENVIANDO')", [conversa.id])).rows.length) return 'OCUPADA' as const;
    const valido = mensagemAindaValida(mensagem,conversa);
    await tx.query('UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1', [mensagem.id, valido ? 'PROCESSANDO' : 'CANCELADA']);
    return valido ? { mensagem, conversa, config } : 'CANCELADA' as const;
  });
  if (!tarefa) return 'SEM_TAREFA';
  // Mensagem obsoleta cancelada na reserva: conta como tarefa; o lote segue para a próxima da fila.
  if (tarefa === 'CANCELADA' || tarefa === 'OCUPADA') return tarefa;
  const { mensagem, conversa, config } = tarefa;
  try {
    if (mensagem.direcao === 'ENTRADA') {
      // Ordem lógica: as entradas seguem o horário do evento, não a ordem de chegada. A tarefa válida é a da versão
      // atual (a última a chegar), mas a resposta considera a entrada mais recente e as anteriores, em ordem.
      // Entrada antiga que chegou atrasada (ex.: retry do provedor) depois de uma mais recente já tratada: vira só
      // histórico. Responder agora repetiria a resposta à mensagem mais recente.
      if ((await db().query("SELECT 1 FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND empresa_id=$2 AND direcao='ENTRADA' AND criada_em>$3 AND estado IN ('PROCESSADA','FALHOU') LIMIT 1", [conversa.id, empresa, mensagem.criada_em])).rows.length) {
        await db().query("UPDATE whatsapp_atendimento_mensagens SET estado='PROCESSADA' WHERE id=$1 AND estado='PROCESSANDO'", [mensagem.id]);
        return 'PROCESSADA';
      }
      // Só a sessão atual (24 h antes da última entrada) vai ao modelo: conversas antigas do contato ficam de fora.
      const historico = (await db().query<{ texto: string }>("SELECT texto FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND empresa_id=$2 AND direcao='ENTRADA' AND texto IS NOT NULL AND criada_em > $3::timestamptz - interval '24 hours' ORDER BY criada_em DESC,id DESC LIMIT 8", [conversa.id, empresa, conversa.ultima_entrada_em])).rows.reverse();
      const atual = historico.at(-1)?.texto ?? mensagem.texto ?? '';
      const respondidas = Number((await db().query<{ n: string }>("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND empresa_id=$2 AND direcao='SAIDA' AND autor_usuario_id IS NULL AND estado<>'CANCELADA' AND criada_em > clock_timestamp()-interval '24 hours'", [conversa.id, empresa])).rows[0]?.n ?? 0);
      if (respondidas >= config.limites.respostasPor24h) return await encaminharSemModelo(mensagem, 'PROCESSADA');
      let plano: Interpretacao;
      try { plano = comandoDireto(atual) ?? await deps.interpretar(empresa, JSON.stringify({ mensagens: historico.map(m => m.texto), mensagemAtual: atual, interesseAnterior: conversa.interesse }), config); }
      catch { return await encaminharSemModelo(mensagem, 'FALHOU'); }
      const hoje = hojeOperacao();
      // Data passada ou inexistente não substitui nem conserva interesse: uma data anterior já vencida também é descartada.
      const interesse = { data: dataDeInteresse(plano.data, hoje) ?? dataDeInteresse(conversa.interesse.data, hoje), convidados: plano.convidados ?? conversa.interesse.convidados };
      await withTransaction(async tx => {
        const empresaAtiva = (await tx.query("SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR SHARE", [empresa])).rows.length;
        const atual = (await tx.query<Conversa>('SELECT * FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE', [conversa.id])).rows[0];
        // Configuração VIGENTE, travada até gravar a saída: resposta publicada removida ou corrigida durante a chamada
        // ao modelo não sai com o texto antigo. A classificação vale; o texto vem da versão atual.
        const vigente = await configuracao(tx, empresa, true);
        if (!empresaAtiva || !mensagemAindaValida(mensagem,atual) || !atendimentoAtivo() || !vigente?.ativo) {
          await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE id=$1", [mensagem.id]); return;
        }
        const resposta = responder(vigente, plano, interesse, hoje);
        await tx.query('UPDATE whatsapp_atendimento_conversas SET interesse=$2::jsonb,estado=$3,nao_contatar=nao_contatar OR $4,atualizada_em=clock_timestamp() WHERE id=$1', [conversa.id, JSON.stringify(interesse), resposta.encerrada ? 'ENCERRADA' : resposta.humano ? 'AGUARDANDO_HUMANO' : 'IA',resposta.encerrada]);
        await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='PROCESSADA' WHERE id=$1", [mensagem.id]);
        if (resposta.texto) await tx.query(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,origem_id,direcao,texto,estado,versao_conversa) VALUES($1,$2,$3,$4,'SAIDA',$5,'PENDENTE',$6) ON CONFLICT(origem_id) DO NOTHING`, [conversa.id, empresa, ambiente, mensagem.id, resposta.texto, atual.versao]);
      });
      return 'PROCESSADA';
    }
    // Marca envio antes de chamar o provedor. Em queda/timeout, não reenviar automaticamente.
    const destino = await withTransaction(async tx => {
      const empresaAtiva = (await tx.query("SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR SHARE", [empresa])).rows.length;
      const atual = (await tx.query<Conversa>('SELECT * FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE', [conversa.id])).rows[0];
      const autorAtivo = !mensagem.autor_usuario_id || (await tx.query("SELECT u.id FROM usuarios_administrativos u JOIN memberships m ON m.usuario_id=u.id WHERE u.id=$1 AND u.ativo=true AND m.empresa_id=$2 AND m.status='ATIVA' AND m.papel IN ('ADMINISTRATIVO','REPRESENTANTE_AUTORIZADO')", [mensagem.autor_usuario_id,empresa])).rows.length > 0;
      // Resposta automática gerada antes da última alteração da configuração (resposta publicada removida, corrigida,
      // nome ou limites mudados) não sai: pode carregar texto revogado. Comparação no banco, com precisão total. A
      // mensagem fixa de encaminhamento e as mensagens humanas não dependem das respostas publicadas.
      // Alcance da trava: o FOR SHARE dura só até o COMMIT desta transação, que marca ENVIANDO. O POST ao provedor
      // acontece depois, fora dela. Um salvamento que chega antes do COMMIT espera e grava `atualizada_em` depois; um
      // salvamento depois do COMMIT NÃO retém o envio já iniciado: o texto lido aqui sai (ou termina INCERTO).
      const vigente = await configuracao(tx, empresa, true);
      const revogada = !mensagem.autor_usuario_id && mensagem.texto !== MENSAGEM_ENCAMINHAMENTO && (await tx.query("SELECT 1 FROM whatsapp_atendimento_config c JOIN whatsapp_atendimento_mensagens m ON m.empresa_id=c.empresa_id AND m.ambiente=c.ambiente WHERE m.id=$1 AND c.empresa_id=$2 AND c.ambiente=$3 AND c.atualizada_em > m.criada_em", [mensagem.id, empresa, ambiente])).rows.length > 0;
      const valida = mensagemAindaValida(mensagem,atual);
      const ok = empresaAtiva && autorAtivo && !revogada && contatoPermitido(atual.contato) && valida && atendimentoAtivo() && vigente?.ativo;
      await tx.query('UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1', [mensagem.id, ok ? 'ENVIANDO' : 'CANCELADA']);
      // Revogada quando ainda seria enviada, com a IA conduzindo: o cliente ficaria sem resposta, então a conversa vai
      // para a equipe. Estado humano (AGUARDANDO_HUMANO, HUMANO, ENCERRADA) e responsável não mudam.
      if (revogada && valida && atual.estado === 'IA') await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1 AND estado='IA'", [atual.id]);
      return ok ? atual.contato : null;
    });
    if (!destino) return 'CANCELADA';
    // Daqui em diante não há transação nem trava abertas (rede). Assumir durante ENVIANDO é recusado pela API até o
    // resultado; alteração da configuração neste intervalo não cancela o envio já marcado.
    const provedorId = await deps.enviar(destino, mensagem.texto ?? '');
    await withTransaction(async tx => {
      await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='SUBMETIDA',provedor_id=$2 WHERE id=$1 AND estado='ENVIANDO'", [mensagem.id, provedorId]);
      // Status que chegou antes do retorno do envio é aplicado agora e sai da tabela.
      await correlacionarStatus(tx, empresa, ambiente, provedorId);
    });
    return 'SUBMETIDA';
  } catch (erro) {
    // Recusa do provedor ou transporte sem configuração: nada saiu, termina FALHOU. Demais falhas no envio: INCERTO.
    const naoEnviada = erro instanceof Error && ['ATENDIMENTO_ENVIO_RECUSADO', 'ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO'].includes(erro.message);
    await withTransaction(async tx => {
      await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado=CASE WHEN estado='ENVIANDO' AND NOT $2::boolean THEN 'INCERTO' ELSE 'FALHOU' END WHERE id=$1 AND estado IN ('PROCESSANDO','ENVIANDO')", [mensagem.id, naoEnviada]);
      await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1 AND estado='IA'", [conversa.id]);
    });
    return 'ENCAMINHADA';
  }
}

/**
 * Modelo indisponível, orçamento recusado ou limite de respostas atingido: a conversa vai para a equipe e o contato
 * recebe só o texto fixo de encaminhamento. Revalida tudo sob a trava da conversa: se um atendente assumiu ou chegou
 * entrada nova durante a chamada, nada é criado (a entrada é cancelada).
 */
async function encaminharSemModelo(mensagem: Mensagem, estadoEntrada: 'FALHOU' | 'PROCESSADA') {
  const empresa = empresaPiloto(), ambiente = ambienteAtendimento();
  await withTransaction(async tx => {
    const empresaAtiva = (await tx.query("SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR SHARE", [empresa])).rows.length;
    const atual = (await tx.query<Conversa>('SELECT * FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE', [mensagem.conversa_id])).rows[0];
    const valido = Boolean(empresaAtiva && atual && mensagemAindaValida(mensagem, atual) && atendimentoAtivo() && (await configuracao(tx, empresa))?.ativo);
    await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado=$2 WHERE id=$1 AND estado='PROCESSANDO'", [mensagem.id, valido ? estadoEntrada : 'CANCELADA']);
    if (!valido) return;
    const versao = Number(atual.versao) + 1;
    await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',versao=$2,atualizada_em=clock_timestamp() WHERE id=$1", [atual.id, versao]);
    await tx.query(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,origem_id,direcao,texto,estado,versao_conversa) VALUES($1,$2,$3,$4,'SAIDA',$5,'PENDENTE',$6) ON CONFLICT(origem_id) DO NOTHING`, [atual.id, empresa, ambiente, mensagem.id, MENSAGEM_ENCAMINHAMENTO, versao]);
  });
  return 'ENCAMINHADA' as const;
}
