import { withTransaction, db } from '../../db/postgres.ts';
import { ambienteAtendimento, atendimentoAtivo, contatoPermitido, empresaPiloto, origemMidia } from './configuracao.ts';
import { MENSAGEM_ENCAMINHAMENTO, comandoDireto, semAutomatico, dataDeInteresse, hojeOperacao, janelaAberta, responder, type ConfiguracaoAtendimento, type Interpretacao } from './core.ts';
import { configuracao, correlacionarStatus, limparStatusExpirados, recuperarTrabalhosInterrompidos, tem078, type Conversa, type Mensagem } from './service.ts';
import { conteudoDaMensagem, type ConteudoSaida } from './transporte.ts';
import { urlPublicaArquivo } from './arquivos.ts';
import type { Passagem, ResultadoWallE } from './walle/tipos.ts';
import type { DbExecutor } from '../../db/contracts.ts';

/**
 * Porta do Wall-e (078), montada na composition root: entende a mensagem (modelo revalidado ou regras locais) e
 * resolve com as fontes oficiais da empresa, só lendo. O worker grava o resultado sob a trava da conversa.
 */
export type PortaWallE = { responder(entrada: { empresa: string; ambiente: string; contato: string; texto: string; historico: string[]; contexto: unknown; config: ConfiguracaoAtendimento; hoje: string; agora: string }): Promise<ResultadoWallE> };
export type DependenciasWorker = { interpretar(empresa: string, texto: string, config: ConfiguracaoAtendimento): Promise<Interpretacao>; enviar(contato: string, conteudo: ConteudoSaida): Promise<string>; wallE?: PortaWallE };
/**
 * Saída parada na fila além deste prazo (automação, chave da IA ou empresa desligadas e religadas depois) não sai mais:
 * uma resposta de horas atrás chegaria fora de contexto. O atendente vê "Não enviada" e pode responder de novo.
 */
export const PRAZO_SAIDA_MS = 15 * 60 * 1000;
export function mensagemAindaValida(mensagem: Mensagem, conversa: Conversa, agora = new Date()) {
  if (conversa.nao_contatar || !janelaAberta(new Date(conversa.ultima_entrada_em), agora)) return false;
  if (mensagem.direcao === 'SAIDA' && agora.getTime() - new Date(mensagem.criada_em).getTime() > PRAZO_SAIDA_MS) return false;
  if (mensagem.autor_usuario_id) return janelaAberta(new Date(mensagem.criada_em),agora) && mensagem.direcao === 'SAIDA' && conversa.estado === 'HUMANO' && conversa.responsavel_id === mensagem.autor_usuario_id;
  // Rodada 22: depois de um pedido de parar (mesmo sem bloqueio), nada automático: nem entrada processada, nem saída.
  if (semAutomatico(conversa)) return false;
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
      // Com a 078 uma resposta pode ter várias saídas (texto + PDF): o limite conta respostas (grupos), não linhas.
      const r078 = await tem078(db());
      const respondidas = Number((await db().query<{ n: string }>(`SELECT count(${r078 ? 'DISTINCT COALESCE(origem_grupo_id,id)' : '*'}) AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND empresa_id=$2 AND direcao='SAIDA' AND autor_usuario_id IS NULL AND estado<>'CANCELADA' AND criada_em > clock_timestamp()-interval '24 hours'`, [conversa.id, empresa])).rows[0]?.n ?? 0);
      if (respondidas >= config.limites.respostasPor24h) return await encaminharSemModelo(mensagem, 'PROCESSADA');
      // Wall-e: só com a 078, a porta montada e a configuração ligada. PARAR continua no caminho fixo (encerra e não contata).
      if (deps.wallE && r078 && config.wallE?.ativo && comandoDireto(atual)?.intencao !== 'PARAR') return await responderWallE(deps.wallE, mensagem, conversa, atual, historico.map(m => m.texto));
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
      const revogada = !mensagem.autor_usuario_id && mensagem.texto !== MENSAGEM_ENCAMINHAMENTO && ((await tx.query("SELECT 1 FROM whatsapp_atendimento_config c JOIN whatsapp_atendimento_mensagens m ON m.empresa_id=c.empresa_id AND m.ambiente=c.ambiente WHERE m.id=$1 AND c.empresa_id=$2 AND c.ambiente=$3 AND c.atualizada_em > m.criada_em", [mensagem.id, empresa, ambiente])).rows.length > 0
        || !(await materialAindaAutorizado(tx, mensagem, empresa, ambiente)));
      const valida = mensagemAindaValida(mensagem,atual);
      const ok = empresaAtiva && autorAtivo && !revogada && contatoPermitido(atual.contato) && valida && atendimentoAtivo() && vigente?.ativo;
      await tx.query('UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1', [mensagem.id, ok ? 'ENVIANDO' : 'CANCELADA']);
      // Revogada quando ainda seria enviada, com a IA conduzindo: o cliente ficaria sem resposta, então a conversa vai
      // para a equipe. Estado humano (AGUARDANDO_HUMANO, HUMANO, ENCERRADA) e responsável não mudam.
      if (revogada && valida && atual.estado === 'IA') await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1 AND estado='IA'", [atual.id]);
      if (!ok) return null;
      // Arquivo próprio (078): URL pública com o token do arquivo, na origem https configurada; sem ela, nada sai (FALHOU).
      const arquivo = mensagem.midia_arquivo_id ? (await tx.query<{ token: string; nome: string }>('SELECT token,nome FROM whatsapp_atendimento_arquivos WHERE id=$1 AND empresa_id=$2 AND ambiente=$3', [mensagem.midia_arquivo_id, empresa, ambiente])).rows[0] : null;
      return { contato: atual.contato, urlArquivo: arquivo ? urlPublicaArquivo(origemMidia() ?? undefined, mensagem.midia_arquivo_id!, arquivo.token, arquivo.nome) : null };
    });
    if (!destino) return 'CANCELADA';
    // Daqui em diante não há transação nem trava abertas (rede). Assumir durante ENVIANDO é recusado pela API até o
    // resultado; alteração da configuração neste intervalo não cancela o envio já marcado.
    // Foto/vídeo (077): tipo e URL vêm da própria linha (copiados da mensagem pronta no servidor); o texto é a legenda.
    const provedorId = await deps.enviar(destino.contato, conteudoDaMensagem({ ...mensagem, url_arquivo: destino.urlArquivo }));
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
/** Saídas ainda na fila da conversa viram CANCELADA. SKIP LOCKED (como no encerramento): a linha que outro worker
 *  segura agora é cancelada por ele mesmo ao revalidar sob a trava da conversa (nao_contatar ou versão nova). */
async function cancelarSaidasNaFila(tx: DbExecutor, conversaId: string, empresa: string, ambiente: string) {
  await tx.query(`UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE id IN (SELECT id FROM whatsapp_atendimento_mensagens
    WHERE conversa_id=$1 AND empresa_id=$2 AND ambiente=$3 AND direcao='SAIDA' AND estado='PENDENTE' FOR UPDATE SKIP LOCKED)`, [conversaId, empresa, ambiente]);
}
/**
 * Pedido de parar reconhecido no worker: o MESMO bloqueio definitivo da recepção (ENCERRADA + nao_contatar, versão
 * nova), a entrada fica PROCESSADA e as saídas na fila são canceladas. Vale mesmo que a conversa tenha mudado nesse meio
 * tempo: o pedido do cliente é respeitado sempre. Nada depois desfaz o bloqueio: a recepção não reabre conversa com
 * nao_contatar, o worker não processa entradas dela e a equipe não envia (ATENDIMENTO_CONTATO_BLOQUEADO).
 */
async function bloquearPorPedido(mensagem: Mensagem, registro: Passagem | null = null) {
  const empresa = empresaPiloto(), ambiente = ambienteAtendimento();
  await withTransaction(async tx => {
    // Rodada 18: reclamação junto do pedido de parar fica na fila da equipe (AGUARDANDO_HUMANO + passagem), com o mesmo
    // bloqueio (nao_contatar): nada é enviado e a equipe não consegue assumir nem responder (ATENDIMENTO_CONTATO_BLOQUEADO).
    if (registro) await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',nao_contatar=true,passagem=$3::jsonb,versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1 AND empresa_id=$2", [mensagem.conversa_id, empresa, JSON.stringify(registro)]);
    else await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='ENCERRADA',nao_contatar=true,versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1 AND empresa_id=$2", [mensagem.conversa_id, empresa]);
    await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='PROCESSADA' WHERE id=$1 AND estado='PROCESSANDO'", [mensagem.id]);
    await cancelarSaidasNaFila(tx, mensagem.conversa_id, empresa, ambiente);
  });
  return 'PROCESSADA' as const;
}
/** Pedido de parar AMBÍGUO: nada é enviado (nem o texto fixo de encaminhamento); a equipe recebe a conversa com o resumo,
 *  sem o bloqueio definitivo, e decide. */
async function passarEmSilencio(mensagem: Mensagem, passagem: Passagem) {
  const empresa = empresaPiloto(), ambiente = ambienteAtendimento();
  await withTransaction(async tx => {
    const atual = (await tx.query<Conversa>('SELECT * FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE', [mensagem.conversa_id])).rows[0];
    if (!atual || !mensagemAindaValida(mensagem, atual)) { await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE id=$1 AND estado='PROCESSANDO'", [mensagem.id]); return; }
    // Rodada 22: pedido de parar sem bloqueio definitivo marca a conversa: nenhum envio automático depois (só a equipe).
    const marca = passagem.motivos.includes('PARAR_A_CONFIRMAR') ? { semAutomatico: { motivo: 'PARAR_A_CONFIRMAR', em: passagem.em } } : {};
    await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',passagem=$2::jsonb,contexto=contexto||$3::jsonb,versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1", [atual.id, JSON.stringify(passagem), JSON.stringify(marca)]);
    await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='PROCESSADA' WHERE id=$1 AND estado='PROCESSANDO'", [mensagem.id]);
    await cancelarSaidasNaFila(tx, atual.id, empresa, ambiente);
  });
  return 'PROCESSADA' as const;
}
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

/**
 * Saída automática do Wall-e que usa material da biblioteca: no envio, cada material citado na fonte precisa continuar
 * PUBLICADO, com envio automático autorizado e na MESMA versão (FOR SHARE até marcar ENVIANDO). Editado, arquivado ou
 * desautorizado depois da resposta: a saída não sai (revogada). Linhas sem fonte do Wall-e não dependem disto.
 */
async function materialAindaAutorizado(tx: DbExecutor, mensagem: Mensagem, empresa: string, ambiente: string) {
  const fonte = mensagem.fonte as { tipo?: string; fontes?: { tipo?: string; id?: string; versao?: number }[] } | null | undefined;
  if (mensagem.autor_usuario_id || fonte?.tipo !== 'WALLE') return true;
  const prontas = new Map<string, number>();
  for (const f of fonte.fontes ?? []) if (f.tipo === 'PRONTA' && typeof f.id === 'string' && Number.isInteger(f.versao)) prontas.set(f.id, f.versao!);
  if (!prontas.size) return true;
  const r = await tx.query<{ id: string }>(`SELECT p.id FROM whatsapp_atendimento_mensagens_prontas p JOIN unnest($3::uuid[],$4::bigint[]) AS f(id,versao) ON p.id=f.id AND p.versao=f.versao
    WHERE p.empresa_id=$1 AND p.ambiente=$2 AND p.ativa AND p.estado='PUBLICADA' AND p.envio_automatico FOR SHARE OF p`, [empresa, ambiente, [...prontas.keys()], [...prontas.values()]]);
  return r.rows.length === prontas.size;
}

/**
 * Wall-e (078). Entender e resolver (modelo e leituras) ficam FORA de transação; a gravação revalida tudo sob a trava
 * da conversa: atendente assumiu, entrada nova, empresa/automação/Wall-e desligados ⇒ nada é criado (entrada cancelada).
 * Grava a memória e a passagem e cria as saídas da mesma entrada em ordem (texto, depois anexos), num grupo único
 * (origem_grupo_id + ordem): retry não duplica e uma entrada nova cancela as saídas ainda na fila (versão da conversa).
 * Falha ao entender/consultar: o caminho fixo de encaminhamento, sem inventar resposta.
 */
async function responderWallE(porta: PortaWallE, mensagem: Mensagem, conversa: Conversa, texto: string, historico: string[]) {
  const empresa = empresaPiloto(), ambiente = ambienteAtendimento();
  const hoje = hojeOperacao();
  let resultado: ResultadoWallE;
  try {
    const config = await configuracao(db(), empresa);
    if (!config) throw new Error('ATENDIMENTO_CONFIGURACAO_INVALIDA');
    resultado = await porta.responder({ empresa, ambiente, contato: conversa.contato, texto, historico, contexto: conversa.contexto ?? {}, config, hoje, agora: new Date().toISOString() });
  } catch { return await encaminharSemModelo(mensagem, 'FALHOU'); }
  // Pedido de parar entendido pelo Wall-e (paráfrase que a recepção não bloqueou, com o trecho validado sem modelo).
  if (resultado.parar) return await bloquearPorPedido(mensagem, resultado.passagem);
  if (resultado.silencio && resultado.passagem) return await passarEmSilencio(mensagem, resultado.passagem);
  if (!resultado.saidas.length) return await encaminharSemModelo(mensagem, 'FALHOU');
  await withTransaction(async tx => {
    const empresaAtiva = (await tx.query("SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR SHARE", [empresa])).rows.length;
    const atual = (await tx.query<Conversa>('SELECT * FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE', [conversa.id])).rows[0];
    const vigente = await configuracao(tx, empresa, true);
    if (!empresaAtiva || !mensagemAindaValida(mensagem, atual) || !atendimentoAtivo() || !vigente?.ativo || !vigente.wallE?.ativo) {
      await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE id=$1", [mensagem.id]); return;
    }
    // Memória sem o último entendimento (trechos do texto do cliente): só os dados da festa, enviados e correções.
    const contexto = { ...resultado.contexto };
    delete contexto.ultimoEntendimento;
    const interesse = { data: dataDeInteresse(contexto.data ?? null, hoje), convidados: contexto.convidados ?? null };
    // A marca de "sem automático" (rodada 22) nunca é apagada pela memória nova do Wall-e.
    await tx.query("UPDATE whatsapp_atendimento_conversas SET interesse=$2::jsonb,contexto=CASE WHEN contexto ? 'semAutomatico' THEN $3::jsonb || jsonb_build_object('semAutomatico', contexto->'semAutomatico') ELSE $3::jsonb END,passagem=COALESCE($4::jsonb,passagem),estado=$5,atualizada_em=clock_timestamp() WHERE id=$1",
      [atual.id, JSON.stringify(interesse), JSON.stringify(contexto), resultado.passagem ? JSON.stringify(resultado.passagem) : null, resultado.passagem ? 'AGUARDANDO_HUMANO' : 'IA']);
    await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='PROCESSADA' WHERE id=$1", [mensagem.id]);
    const base = (await tx.query<{ t: string }>('SELECT clock_timestamp()::text AS t')).rows[0].t;
    for (const [ordem, s] of resultado.saidas.slice(0, 10).entries()) {
      const a = s.anexo;
      await tx.query(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,origem_id,origem_grupo_id,ordem,direcao,texto,estado,versao_conversa,midia_tipo,midia_url,midia_arquivo_id,midia_nome,midia_pronta_id,midia_pronta_versao,fonte,criada_em)
        VALUES($1,$2,$3,$4,$5,$6,'SAIDA',$7,'PENDENTE',$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::timestamptz + $17::interval) ON CONFLICT DO NOTHING`,
      [atual.id, empresa, ambiente, ordem === 0 ? mensagem.id : null, mensagem.id, ordem, a ? a.legenda : s.texto, atual.versao, a?.tipo ?? null, a && !a.arquivoId ? a.midiaUrl : null, a?.arquivoId ?? null, a?.arquivoId ? a.nome : null, a?.prontaId ?? null, a?.versao ?? null,
        JSON.stringify({ tipo: 'WALLE', fontes: s.fontes }), base, `${ordem} milliseconds`]);
    }
  });
  return 'PROCESSADA' as const;
}
