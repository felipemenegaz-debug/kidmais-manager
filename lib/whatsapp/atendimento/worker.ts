import { withTransaction, db } from '../../db/postgres.ts';
import { ambienteAtendimento, atendimentoAtivo, contatoPermitido, empresaPiloto } from './configuracao.ts';
import { comandoDireto, dataDeInteresse, hojeOperacao, janelaAberta, responder, type ConfiguracaoAtendimento, type Interpretacao } from './core.ts';
import { configuracao, correlacionarStatus, limparStatusExpirados, recuperarTrabalhosInterrompidos, type Conversa, type Mensagem } from './service.ts';

export type DependenciasWorker = { interpretar(empresa: string, texto: string, config: ConfiguracaoAtendimento): Promise<Interpretacao>; enviar(contato: string, texto: string): Promise<string> };
export function mensagemAindaValida(mensagem: Mensagem, conversa: Conversa, agora = new Date()) {
  if (conversa.nao_contatar || !janelaAberta(new Date(conversa.ultima_entrada_em), agora)) return false;
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
    if ((await tx.query("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND estado IN ('PROCESSANDO','ENVIANDO')", [conversa.id])).rows.length) return null;
    const valido = mensagemAindaValida(mensagem,conversa);
    await tx.query('UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1', [mensagem.id, valido ? 'PROCESSANDO' : 'CANCELADA']);
    return valido ? { mensagem, conversa, config } : 'CANCELADA' as const;
  });
  if (!tarefa) return 'SEM_TAREFA';
  // Mensagem obsoleta cancelada na reserva: conta como tarefa; o lote segue para a próxima da fila.
  if (tarefa === 'CANCELADA') return 'CANCELADA';
  const { mensagem, conversa, config } = tarefa;
  try {
    if (mensagem.direcao === 'ENTRADA') {
      const historico = (await db().query<{ texto: string }>("SELECT texto FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND empresa_id=$2 AND direcao='ENTRADA' AND criada_em<=$3 AND texto IS NOT NULL ORDER BY criada_em DESC,id DESC LIMIT 8", [conversa.id, empresa, mensagem.criada_em])).rows.reverse();
      const plano = comandoDireto(mensagem.texto ?? '') ?? await deps.interpretar(empresa, JSON.stringify({ mensagens: historico.map(m => m.texto), mensagemAtual: mensagem.texto, interesseAnterior: conversa.interesse }), config);
      const hoje = hojeOperacao();
      // Data passada ou inexistente não substitui nem conserva interesse: uma data anterior já vencida também é descartada.
      const interesse = { data: dataDeInteresse(plano.data, hoje) ?? dataDeInteresse(conversa.interesse.data, hoje), convidados: plano.convidados ?? conversa.interesse.convidados };
      const resposta = responder(config, plano, interesse, hoje);
      await withTransaction(async tx => {
        const empresaAtiva = (await tx.query("SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR SHARE", [empresa])).rows.length;
        const atual = (await tx.query<Conversa>('SELECT * FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE', [conversa.id])).rows[0];
        if (!empresaAtiva || !mensagemAindaValida(mensagem,atual) || !atendimentoAtivo() || !(await configuracao(tx, empresa))?.ativo) {
          await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE id=$1", [mensagem.id]); return;
        }
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
      const ok = empresaAtiva && autorAtivo && contatoPermitido(atual.contato) && mensagemAindaValida(mensagem,atual) && atendimentoAtivo() && (await configuracao(tx, empresa))?.ativo;
      await tx.query('UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1', [mensagem.id, ok ? 'ENVIANDO' : 'CANCELADA']);
      return ok ? atual.contato : null;
    });
    if (!destino) return 'CANCELADA';
    // Não há transação aberta em rede. Assumir durante ENVIANDO é recusado pela API até o resultado.
    const provedorId = await deps.enviar(destino, mensagem.texto ?? '');
    await withTransaction(async tx => {
      await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado='SUBMETIDA',provedor_id=$2 WHERE id=$1 AND estado='ENVIANDO'", [mensagem.id, provedorId]);
      // Status que chegou antes do retorno do envio é aplicado agora e sai da tabela.
      await correlacionarStatus(tx, empresa, ambiente, provedorId);
    });
    return 'SUBMETIDA';
  } catch {
    await withTransaction(async tx => {
      await tx.query("UPDATE whatsapp_atendimento_mensagens SET estado=CASE WHEN estado='ENVIANDO' THEN 'INCERTO' ELSE 'FALHOU' END WHERE id=$1 AND estado IN ('PROCESSANDO','ENVIANDO')", [mensagem.id]);
      await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1 AND estado='IA'", [conversa.id]);
    });
    return 'ENCAMINHADA';
  }
}
