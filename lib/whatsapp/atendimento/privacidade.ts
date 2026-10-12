import { randomBytes } from 'node:crypto';
import { db, withTransaction } from '../../db/postgres.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import type { SessaoParaTenant } from '../../saas/provar-tenant.ts';
import { ambienteAtendimento } from './configuracao.ts';
import { acessoAtendimento, tem082 } from './service.ts';

/**
 * Privacidade do atendimento (D2 e D3; registro em whatsapp_atendimento_privacidade, da 082, sem conteúdo nem contato).
 *
 * D2 — exclusão de uma conversa (a pedido, pela gestão da empresa, ou por retenção): numa transação, sob a trava da
 * conversa, apaga TODAS as mensagens (texto, mídia, fonte), os status do provedor delas, desliga a auditoria da conversa
 * (a ação continua registrada, sem o vínculo) e apaga a conversa — com o nome de perfil, a memória do Wall-e (contexto),
 * o resumo da passagem (ultimaMensagem) e o interesse. Tarefa em andamento (PROCESSANDO/ENVIANDO) recusa: o worker
 * segura a mensagem fora da trava da conversa e gravaria depois; tenta-se de novo quando ela terminar. Pendentes saem
 * junto (nada mais é enviado). Contato com PARAR (nao_contatar): a conversa fica só com o número e a marca, para o
 * pedido de não contatar continuar valendo (decisão de produto pendente: ver docs/PRIVACIDADE_ATENDIMENTO_D1_D4.md).
 *
 * Retenção: SEM prazo padrão. WHATSAPP_ATENDIMENTO_RETENCAO_DIAS (inteiro 1–3650) liga a exclusão automática das
 * conversas sem atividade há mais do que o prazo; ausente ou inválido, nada é apagado e o resultado diz PRAZO_NAO_DEFINIDO.
 *
 * D3 — arquivos da biblioteca: revogar apaga o conteúdo, troca o link (o antigo para de servir na hora), arquiva as
 * mensagens prontas que usam o arquivo e cancela as saídas dele ainda na fila; é irreversível. Trocar o link só invalida
 * links já compartilhados. A expiração (expira_em) para de servir o arquivo depois da data. Limite real: cópias que o
 * provedor ou o cliente já baixaram (inclusive a mídia guardada pelo WhatsApp) NÃO são apagadas por nada disto.
 */
export type OrigemPrivacidade = 'PEDIDO' | 'RETENCAO';
export type ResultadoExclusao =
  | { estado: 'EXCLUIDA'; mensagens: number; pendentesCanceladas: number; manteveNaoContatar: boolean }
  | { estado: 'EM_PROCESSAMENTO' | 'NAO_ENCONTRADA' };

async function temNomePerfil(tx: DbExecutor) {
  return (await tx.query<{ existe: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.whatsapp_atendimento_conversas'::regclass AND attname='nome_perfil' AND NOT attisdropped) AS existe")).rows[0]?.existe === true;
}

/** Núcleo da exclusão (D2), dentro da transação de quem chama. Exige a 082 (registro de privacidade). */
export async function excluirDadosConversa(tx: DbExecutor, alvo: { empresa: string; ambiente: string; conversaId: string; origem: OrigemPrivacidade; usuarioId: string | null; prazoDias?: number | null }): Promise<ResultadoExclusao> {
  if (!(await tem082(tx))) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
  const conversa = (await tx.query<{ id: string; nao_contatar: boolean }>('SELECT id,nao_contatar FROM whatsapp_atendimento_conversas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 FOR UPDATE',
    [alvo.conversaId, alvo.empresa, alvo.ambiente])).rows[0];
  if (!conversa) return { estado: 'NAO_ENCONTRADA' };
  // NOWAIT: a linha que o worker segura agora (reserva) não é esperada nem apagada por baixo dele.
  try {
    await tx.query("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND (estado IN ('PROCESSANDO','ENVIANDO') OR estado='PENDENTE') FOR UPDATE NOWAIT", [conversa.id]);
  } catch (erro) {
    if ((erro as { code?: string }).code === '55P03') return { estado: 'EM_PROCESSAMENTO' };
    throw erro;
  }
  if ((await tx.query("SELECT 1 FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND estado IN ('PROCESSANDO','ENVIANDO') LIMIT 1", [conversa.id])).rows.length) return { estado: 'EM_PROCESSAMENTO' };
  const pendentes = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND estado='PENDENTE'", [conversa.id])).rows[0]?.n ?? 0);
  const provedores = (await tx.query<{ provedor_id: string }>('SELECT provedor_id FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND provedor_id IS NOT NULL', [conversa.id])).rows.map((r) => r.provedor_id);
  if (provedores.length) await tx.query('DELETE FROM whatsapp_atendimento_status WHERE empresa_id=$1 AND ambiente=$2 AND provedor_id = ANY($3::text[])', [alvo.empresa, alvo.ambiente, provedores]);
  // Uma instrução só: as referências entre mensagens da mesma conversa (origem, grupo) saem juntas.
  const mensagens = (await tx.query('DELETE FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND empresa_id=$2 AND ambiente=$3 RETURNING id', [conversa.id, alvo.empresa, alvo.ambiente])).rows.length;
  await tx.query('UPDATE whatsapp_atendimento_auditoria SET conversa_id=NULL WHERE conversa_id=$1 AND empresa_id=$2 AND ambiente=$3', [conversa.id, alvo.empresa, alvo.ambiente]);
  if (conversa.nao_contatar) {
    const nome = (await temNomePerfil(tx)) ? ',nome_perfil=NULL,nome_perfil_em=NULL' : '';
    await tx.query(`UPDATE whatsapp_atendimento_conversas SET estado='ENCERRADA',responsavel_id=NULL,interesse='{"data":null,"convidados":null}'::jsonb,contexto='{}'::jsonb,passagem=NULL${nome},versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1`, [conversa.id]);
  } else {
    await tx.query('DELETE FROM whatsapp_atendimento_conversas WHERE id=$1', [conversa.id]);
  }
  await tx.query(`INSERT INTO whatsapp_atendimento_privacidade(empresa_id,ambiente,acao,origem,usuario_id,conversa_id,mensagens_removidas,saidas_canceladas,manteve_nao_contatar,prazo_dias)
    VALUES($1,$2,'CONVERSA_EXCLUIDA',$3,$4,$5,$6,$7,$8,$9)`, [alvo.empresa, alvo.ambiente, alvo.origem, alvo.usuarioId, conversa.id, mensagens, pendentes, conversa.nao_contatar, alvo.origem === 'RETENCAO' ? alvo.prazoDias ?? null : null]);
  return { estado: 'EXCLUIDA', mensagens, pendentesCanceladas: pendentes, manteveNaoContatar: conversa.nao_contatar };
}

const representante = (papel: string) => { if (papel !== 'REPRESENTANTE_AUTORIZADO') throw new Error('ATENDIMENTO_ACESSO_NEGADO'); };

/** Exclusão a pedido (titular ou empresa): só a gestão (representante) da empresa comprovada pela sessão. */
export async function excluirConversaAPedido(sessao: SessaoParaTenant, pedido: { conversaId: string }) {
  return acessoAtendimento(sessao, async (tx, empresa, papel) => {
    representante(papel);
    const r = await excluirDadosConversa(tx, { empresa, ambiente: ambienteAtendimento(), conversaId: pedido.conversaId, origem: 'PEDIDO', usuarioId: sessao.usuario_id });
    if (r.estado === 'NAO_ENCONTRADA') throw new Error('ATENDIMENTO_NAO_ENCONTRADO');
    if (r.estado === 'EM_PROCESSAMENTO') throw new Error('ATENDIMENTO_ENVIO_EM_ANDAMENTO');
    return r;
  });
}

/** Prazo de retenção do ambiente. Sem padrão: ausente, vazio ou fora de 1–3650 ⇒ null (nada é apagado). */
export function prazoRetencaoDias(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = env.WHATSAPP_ATENDIMENTO_RETENCAO_DIAS?.trim();
  if (!v || !/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 3650 ? n : null;
}

/**
 * Retenção (D2): conversas de TODAS as empresas do ambiente sem atividade há mais de `prazo` dias (última entrada e última
 * atualização), sem tarefa ativa, em lotes de `limite`, uma transação por conversa. A conversa só com a marca de PARAR
 * (já limpa) não é selecionada de novo.
 */
export async function aplicarRetencao(opcoes: { env?: NodeJS.ProcessEnv; limite?: number } = {}) {
  const prazo = prazoRetencaoDias(opcoes.env ?? process.env);
  if (prazo === null) return { estado: 'PRAZO_NAO_DEFINIDO' as const, excluidas: 0, adiadas: 0 };
  if (!(await tem082(db()))) return { estado: 'SEM_082' as const, excluidas: 0, adiadas: 0 };
  const ambiente = ambienteAtendimento();
  const candidatas = (await db().query<{ id: string; empresa_id: string }>(`SELECT c.id,c.empresa_id FROM whatsapp_atendimento_conversas c
    WHERE c.ambiente=$1 AND c.ultima_entrada_em < clock_timestamp()-make_interval(days => $2) AND c.atualizada_em < clock_timestamp()-make_interval(days => $2)
      AND NOT EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens m WHERE m.conversa_id=c.id AND m.estado IN ('PENDENTE','PROCESSANDO','ENVIANDO'))
      AND NOT (c.nao_contatar AND c.contexto='{}'::jsonb AND c.passagem IS NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens m WHERE m.conversa_id=c.id))
    ORDER BY c.atualizada_em LIMIT $3`, [ambiente, prazo, opcoes.limite ?? 50])).rows;
  let excluidas = 0, adiadas = 0;
  for (const c of candidatas) {
    const r = await withTransaction((tx) => excluirDadosConversa(tx, { empresa: c.empresa_id, ambiente, conversaId: c.id, origem: 'RETENCAO', usuarioId: null, prazoDias: prazo }));
    if (r.estado === 'EXCLUIDA') excluidas++; else adiadas++;
  }
  return { estado: 'APLICADA' as const, prazoDias: prazo, excluidas, adiadas };
}

/**
 * D3 — revogação de um arquivo da biblioteca (só o representante, só da empresa comprovada): conteúdo apagado e link
 * trocado (o banco garante: gatilho e restrições da 082), prontas que o usam arquivadas, saídas dele na fila canceladas.
 * Com envio em andamento (ENVIANDO) recusa: o provedor pode estar baixando o arquivo agora.
 */
export async function revogarArquivo(sessao: SessaoParaTenant, pedido: { arquivoId: string }) {
  return acessoAtendimento(sessao, async (tx, empresa, papel) => {
    representante(papel);
    if (!(await tem082(tx))) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
    const ambiente = ambienteAtendimento();
    const arquivo = (await tx.query('SELECT id FROM whatsapp_atendimento_arquivos WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND revogado_em IS NULL FOR UPDATE', [pedido.arquivoId, empresa, ambiente])).rows[0];
    if (!arquivo) throw new Error('ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO');
    if ((await tx.query("SELECT 1 FROM whatsapp_atendimento_mensagens WHERE midia_arquivo_id=$1 AND empresa_id=$2 AND ambiente=$3 AND estado='ENVIANDO' LIMIT 1", [pedido.arquivoId, empresa, ambiente])).rows.length) throw new Error('ATENDIMENTO_ENVIO_EM_ANDAMENTO');
    const canceladas = (await tx.query(`UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE id IN (
      SELECT id FROM whatsapp_atendimento_mensagens WHERE midia_arquivo_id=$1 AND empresa_id=$2 AND ambiente=$3 AND estado IN ('PENDENTE','PROCESSANDO') FOR UPDATE SKIP LOCKED) RETURNING id`, [pedido.arquivoId, empresa, ambiente])).rows.length;
    const prontas = (await tx.query(`UPDATE whatsapp_atendimento_mensagens_prontas SET ativa=false,atalho=NULL,estado='ARQUIVADA',atualizada_por=$4,versao=versao+1,atualizada_em=clock_timestamp()
      WHERE arquivo_id=$1 AND empresa_id=$2 AND ambiente=$3 AND ativa RETURNING id`, [pedido.arquivoId, empresa, ambiente, sessao.usuario_id])).rows.length;
    await tx.query("UPDATE whatsapp_atendimento_arquivos SET revogado_em=clock_timestamp(),revogado_por=$2,conteudo=''::bytea,token=$3 WHERE id=$1", [pedido.arquivoId, sessao.usuario_id, randomBytes(32).toString('base64url')]);
    await tx.query(`INSERT INTO whatsapp_atendimento_privacidade(empresa_id,ambiente,acao,origem,usuario_id,arquivo_id,saidas_canceladas) VALUES($1,$2,'ARQUIVO_REVOGADO','PEDIDO',$3,$4,$5)`,
      [empresa, ambiente, sessao.usuario_id, pedido.arquivoId, canceladas]);
    return { prontasArquivadas: prontas, saidasCanceladas: canceladas };
  });
}

/** D3 — troca do link de um arquivo (o anterior deixa de servir; o arquivo continua em uso nas prontas). */
export async function trocarLinkArquivo(sessao: SessaoParaTenant, pedido: { arquivoId: string }) {
  return acessoAtendimento(sessao, async (tx, empresa, papel) => {
    representante(papel);
    if (!(await tem082(tx))) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
    const ambiente = ambienteAtendimento();
    const r = await tx.query('UPDATE whatsapp_atendimento_arquivos SET token=$4,token_trocado_em=clock_timestamp() WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND revogado_em IS NULL RETURNING id',
      [pedido.arquivoId, empresa, ambiente, randomBytes(32).toString('base64url')]);
    if (!r.rows.length) throw new Error('ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO');
    await tx.query(`INSERT INTO whatsapp_atendimento_privacidade(empresa_id,ambiente,acao,origem,usuario_id,arquivo_id) VALUES($1,$2,'ARQUIVO_LINK_TROCADO','PEDIDO',$3,$4)`, [empresa, ambiente, sessao.usuario_id, pedido.arquivoId]);
  });
}

/** D3 — expiração do arquivo (null = sem expiração). Depois dela o arquivo não é servido nem enviado. */
export async function definirExpiracaoArquivo(sessao: SessaoParaTenant, pedido: { arquivoId: string; expiraEm: string | null }) {
  return acessoAtendimento(sessao, async (tx, empresa, papel) => {
    representante(papel);
    if (!(await tem082(tx))) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
    const r = await tx.query('UPDATE whatsapp_atendimento_arquivos SET expira_em=$4::timestamptz WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND revogado_em IS NULL RETURNING id',
      [pedido.arquivoId, empresa, ambienteAtendimento(), pedido.expiraEm]);
    if (!r.rows.length) throw new Error('ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO');
  });
}

