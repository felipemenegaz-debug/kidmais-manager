import { randomBytes } from 'node:crypto';
import { db, withTransaction } from '../../db/postgres.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import { withTenantTransaction, type SessaoParaTenant } from '../../saas/provar-tenant.ts';
import { reautenticacaoPerfilRecente } from '../../perfil/reautenticacao.ts';
import { ambienteAtendimento } from './configuracao.ts';
import { semAutomatico } from './core.ts';
import { ARQUIVO_DISPONIVEL_SQL, caminhoPublicoArquivo } from './arquivos.ts';

/**
 * Privacidade do atendimento (D2 e D3), revisada em 12/10/2026. Tudo grava em whatsapp_atendimento_privacidade (082), sem
 * conteúdo nem contato.
 *
 * AUTORIZAÇÃO: a empresa é a ATIVA da sessão, comprovada pelo Tenant Context (withTenantTransaction), e NÃO a empresa
 * piloto do bot: uma empresa que deixou de ser piloto continua podendo excluir, revogar e configurar a retenção dos
 * próprios dados. Só a Gestão (REPRESENTANTE_AUTORIZADO), com senha confirmada há no máximo 5 minutos nas escritas.
 *
 * EXCLUSÃO de conversa (a pedido ou por retenção), numa transação sob a trava da conversa: apaga todas as mensagens
 * (texto, mídia, fonte), os status do provedor delas, o nome de perfil, a memória do Wall-e, a passagem, o interesse e a
 * conversa; a auditoria fica sem o vínculo. Tarefa em processamento ou envio (ou a linha que o worker segura) ADIA, sem
 * apagar nada. O que precisa continuar valendo fica em whatsapp_atendimento_controles_contato, separado do conteúdo: PARAR
 * (nao_contatar), pausa pedida (sem_automatico) e conversa com a equipe (com_equipe) — uma conversa nova do mesmo número
 * herda esses controles (service.ts: receberEntrada) e nunca volta sozinha ao bot. Os ids das mensagens recebidas viram
 * SHA-256 em whatsapp_atendimento_eventos_excluidos: uma reentrega do provedor não recria o conteúdo (RETENCAO_DEDUP_DIAS).
 * Arquivos da biblioteca usados nas respostas são conteúdo da empresa e NÃO são apagados pela exclusão da conversa.
 *
 * RETENÇÃO: sem prazo padrão. Cada empresa define o próprio prazo (dias sem atividade) ou nenhum. A rotina
 * (executarRetencao) é independente das chaves do canal e da IA, processa uma conversa por transação, registra cada
 * execução (whatsapp_atendimento_retencao_execucoes) e os erros (só códigos). Entradas pendentes de uma conversa sem
 * atividade além do prazo (no mínimo 1 dia) já estão fora da janela de 24 h e do prazo de saída: não podem mais ser
 * respondidas; saem com a conversa e são contadas (pendentes_removidas). Tarefas em processamento/envio adiam a conversa.
 *
 * ARQUIVOS: revogar apaga o conteúdo e troca o link (o gatilho da 082 impede desfazer pela aplicação), arquiva as prontas
 * e cancela a fila (com as irmãs do mesmo grupo: nunca "segue o PDF" sem o PDF) com motivo; trocar o link invalida o anterior; a expiração para de servir e de enviar; reativar um
 * arquivo vencido exige link novo (o gatilho exige). A partir do momento em que o worker grava ENVIANDO (e solta a trava),
 * a chamada ao provedor já começou e NÃO pode ser desfeita: revogar recusa enquanto houver envio em andamento. Cópias que
 * o provedor, o cliente ou backups já têm não são alcançadas (docs/PRIVACIDADE_ATENDIMENTO_D1_D4.md).
 */
export type OrigemPrivacidade = 'PEDIDO' | 'RETENCAO';
export type MotivoExclusao = 'PEDIDO_DO_TITULAR' | 'DECISAO_DA_EMPRESA';
export type ResultadoExclusao =
  | { estado: 'EXCLUIDA'; mensagens: number; pendentesRemovidas: number; controles: { naoContatar: boolean; pausa: boolean; equipe: boolean } }
  | { estado: 'EM_PROCESSAMENTO' | 'NAO_ENCONTRADA' };
/** Prazo técnico (não é prazo de retenção de dado pessoal): só o hash do id do evento; cobre reentregas do provedor. */
export const RETENCAO_DEDUP_DIAS = 30;
export const PROVEDOR = 'GUPSHUP';

export async function tem082Privacidade(tx: DbExecutor) {
  return (await tx.query<{ e: boolean }>("SELECT to_regclass('public.whatsapp_atendimento_controles_contato') IS NOT NULL AS e")).rows[0]?.e === true;
}
const codigoDoErro = (erro: unknown) => {
  const e = erro as { message?: unknown; code?: unknown } | null;
  if (typeof e?.message === 'string' && /^ATENDIMENTO_[A-Z_]+$/.test(e.message)) return e.message;
  if (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return `SQLSTATE_${e.code}`;
  return 'ERRO_INTERNO';
};

/** Núcleo da exclusão (D2), dentro da transação de quem chama. */
export async function excluirDadosConversa(tx: DbExecutor, alvo: { empresa: string; ambiente: string; conversaId: string; origem: OrigemPrivacidade; usuarioId: string | null; motivo?: MotivoExclusao | null; prazoDias?: number | null }): Promise<ResultadoExclusao> {
  if (!(await tem082Privacidade(tx))) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
  const conversa = (await tx.query<{ id: string; contato: string; nao_contatar: boolean; estado: string; contexto: Record<string, unknown> }>(
    'SELECT id,contato,nao_contatar,estado,contexto FROM whatsapp_atendimento_conversas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 FOR UPDATE', [alvo.conversaId, alvo.empresa, alvo.ambiente])).rows[0];
  if (!conversa) return { estado: 'NAO_ENCONTRADA' };
  // NOWAIT: a linha que o worker segura agora (reserva ou envio) não é esperada nem apagada por baixo dele.
  try {
    await tx.query("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND estado IN ('PENDENTE','PROCESSANDO','ENVIANDO') FOR UPDATE NOWAIT", [conversa.id]);
  } catch (erro) {
    if ((erro as { code?: string }).code === '55P03') return { estado: 'EM_PROCESSAMENTO' };
    throw erro;
  }
  if ((await tx.query("SELECT 1 FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND estado IN ('PROCESSANDO','ENVIANDO') LIMIT 1", [conversa.id])).rows.length) return { estado: 'EM_PROCESSAMENTO' };
  const controles = { naoContatar: conversa.nao_contatar, pausa: semAutomatico(conversa), equipe: ['HUMANO', 'AGUARDANDO_HUMANO'].includes(conversa.estado) };
  if (controles.naoContatar || controles.pausa || controles.equipe) {
    await tx.query(`INSERT INTO whatsapp_atendimento_controles_contato(empresa_id,ambiente,contato,nao_contatar,sem_automatico,com_equipe) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (empresa_id,ambiente,contato) DO UPDATE SET nao_contatar=whatsapp_atendimento_controles_contato.nao_contatar OR EXCLUDED.nao_contatar,
        sem_automatico=whatsapp_atendimento_controles_contato.sem_automatico OR EXCLUDED.sem_automatico, com_equipe=whatsapp_atendimento_controles_contato.com_equipe OR EXCLUDED.com_equipe,
        atualizado_em=clock_timestamp()`, [alvo.empresa, alvo.ambiente, conversa.contato, controles.naoContatar, controles.pausa, controles.equipe]);
  }
  await tx.query(`INSERT INTO whatsapp_atendimento_eventos_excluidos(empresa_id,ambiente,provedor,evento_sha256)
    SELECT $2,$3,$4,encode(sha256(convert_to(externa_id,'UTF8')),'hex') FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND externa_id IS NOT NULL
    ON CONFLICT DO NOTHING`, [conversa.id, alvo.empresa, alvo.ambiente, PROVEDOR]);
  const pendentes = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND estado='PENDENTE'", [conversa.id])).rows[0]?.n ?? 0);
  await tx.query(`DELETE FROM whatsapp_atendimento_status WHERE empresa_id=$1 AND ambiente=$2 AND provedor_id IN (
    SELECT provedor_id FROM whatsapp_atendimento_mensagens WHERE conversa_id=$3 AND provedor_id IS NOT NULL)`, [alvo.empresa, alvo.ambiente, conversa.id]);
  // Uma instrução só: as referências entre mensagens da mesma conversa (origem, grupo) saem juntas.
  const mensagens = (await tx.query('DELETE FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND empresa_id=$2 AND ambiente=$3 RETURNING id', [conversa.id, alvo.empresa, alvo.ambiente])).rows.length;
  await tx.query('UPDATE whatsapp_atendimento_auditoria SET conversa_id=NULL WHERE conversa_id=$1 AND empresa_id=$2 AND ambiente=$3', [conversa.id, alvo.empresa, alvo.ambiente]);
  await tx.query('DELETE FROM whatsapp_atendimento_conversas WHERE id=$1', [conversa.id]);
  await tx.query(`INSERT INTO whatsapp_atendimento_privacidade(empresa_id,ambiente,acao,origem,usuario_id,conversa_id,mensagens_removidas,saidas_canceladas,manteve_nao_contatar,manteve_pausa,manteve_equipe,motivo,prazo_dias)
    VALUES($1,$2,'CONVERSA_EXCLUIDA',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [alvo.empresa, alvo.ambiente, alvo.origem, alvo.usuarioId, conversa.id, mensagens, pendentes,
    controles.naoContatar, controles.pausa, controles.equipe, alvo.origem === 'PEDIDO' ? alvo.motivo ?? null : null, alvo.origem === 'RETENCAO' ? alvo.prazoDias ?? null : null]);
  return { estado: 'EXCLUIDA', mensagens, pendentesRemovidas: pendentes, controles };
}

/** Sessão administrativa com o momento da última autenticação (para a reautenticação de 5 minutos). */
export type SessaoPrivacidade = SessaoParaTenant & { autenticado_em: string };
/** Gestão da empresa ATIVA da sessão (não a piloto), com senha confirmada há no máximo 5 minutos nas escritas. */
async function naEmpresaDaSessao<T>(sessao: SessaoPrivacidade, escrita: boolean, work: (tx: DbExecutor, empresa: string, ambiente: string) => Promise<T>) {
  return withTenantTransaction(sessao, null, async (tx, tenant) => {
    if (tenant.papelAtual !== 'REPRESENTANTE_AUTORIZADO') throw new Error('ATENDIMENTO_ACESSO_NEGADO');
    if (escrita && !reautenticacaoPerfilRecente(sessao.autenticado_em)) throw new Error('ATENDIMENTO_REAUTENTICACAO');
    if (!(await tem082Privacidade(tx))) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
    return work(tx, tenant.empresaComprovada, ambienteAtendimento());
  });
}

/** Exclusão a pedido (do titular ou decisão da empresa): Gestão da empresa ativa, com reautenticação. */
export async function excluirConversaAPedido(sessao: SessaoPrivacidade, pedido: { conversaId: string; motivo: MotivoExclusao }) {
  return naEmpresaDaSessao(sessao, true, async (tx, empresa, ambiente) => {
    const r = await excluirDadosConversa(tx, { empresa, ambiente, conversaId: pedido.conversaId, origem: 'PEDIDO', usuarioId: sessao.usuario_id, motivo: pedido.motivo });
    if (r.estado === 'NAO_ENCONTRADA') throw new Error('ATENDIMENTO_NAO_ENCONTRADO');
    if (r.estado === 'EM_PROCESSAMENTO') throw new Error('ATENDIMENTO_EXCLUSAO_ADIADA');
    return r;
  });
}

/** Retenção da empresa: prazo em dias sem atividade, ou null (sem exclusão automática). Nunca há valor padrão. */
export async function configurarRetencao(sessao: SessaoPrivacidade, pedido: { prazoDias: number | null }) {
  if (pedido.prazoDias !== null && (!Number.isInteger(pedido.prazoDias) || pedido.prazoDias < 1 || pedido.prazoDias > 3650)) throw new Error('ATENDIMENTO_PRAZO_INVALIDO');
  return naEmpresaDaSessao(sessao, true, async (tx, empresa, ambiente) => {
    await tx.query(`INSERT INTO whatsapp_atendimento_retencao_config(empresa_id,ambiente,prazo_dias,definido_por) VALUES($1,$2,$3,$4)
      ON CONFLICT (empresa_id,ambiente) DO UPDATE SET prazo_dias=EXCLUDED.prazo_dias,definido_por=EXCLUDED.definido_por,definido_em=clock_timestamp()`, [empresa, ambiente, pedido.prazoDias, sessao.usuario_id]);
    await tx.query(`INSERT INTO whatsapp_atendimento_privacidade(empresa_id,ambiente,acao,origem,usuario_id,prazo_dias) VALUES($1,$2,'RETENCAO_CONFIGURADA','PEDIDO',$3,$4)`, [empresa, ambiente, sessao.usuario_id, pedido.prazoDias]);
  });
}

/**
 * Rotina de retenção (D2): independente das chaves do canal e da IA (não consulta atendimentoAtivo nem a IA global);
 * chamada pela rota protegida /api/integracoes/gupshup/atendimento/retencao. Uma conversa por transação: a falha de uma
 * é contada e registrada (código), e as demais seguem. Sem empresa com prazo definido, nada é apagado.
 */
export async function executarRetencao(opcoes: { limitePorEmpresa?: number } = {}) {
  const ambiente = ambienteAtendimento();
  if (!(await tem082Privacidade(db()))) return { estado: 'SEM_082' as const };
  const execucao = (await db().query<{ id: string }>("INSERT INTO whatsapp_atendimento_retencao_execucoes(ambiente,estado) VALUES($1,'EM_ANDAMENTO') RETURNING id", [ambiente])).rows[0].id;
  const total = { empresas: 0, excluidas: 0, adiadas: 0, falhas: 0, pendentes: 0, dedup: 0 };
  const erros: string[] = [];
  try {
    const configs = (await db().query<{ empresa_id: string; prazo_dias: number }>('SELECT empresa_id,prazo_dias FROM whatsapp_atendimento_retencao_config WHERE ambiente=$1 AND prazo_dias IS NOT NULL ORDER BY empresa_id', [ambiente])).rows;
    for (const cfg of configs) {
      total.empresas++;
      const candidatas = (await db().query<{ id: string }>(`SELECT id FROM whatsapp_atendimento_conversas WHERE empresa_id=$1 AND ambiente=$2
        AND ultima_entrada_em < clock_timestamp()-make_interval(days => $3) AND atualizada_em < clock_timestamp()-make_interval(days => $3)
        ORDER BY atualizada_em, id LIMIT $4`, [cfg.empresa_id, ambiente, cfg.prazo_dias, opcoes.limitePorEmpresa ?? 200])).rows;
      for (const c of candidatas) {
        try {
          const r = await withTransaction((tx) => excluirDadosConversa(tx, { empresa: cfg.empresa_id, ambiente, conversaId: c.id, origem: 'RETENCAO', usuarioId: null, prazoDias: cfg.prazo_dias }));
          if (r.estado === 'EXCLUIDA') { total.excluidas++; total.pendentes += r.pendentesRemovidas; } else total.adiadas++;
        } catch (erro) {
          total.falhas++;
          if (erros.length < 20) erros.push(codigoDoErro(erro));
        }
      }
    }
    total.dedup = (await db().query('DELETE FROM whatsapp_atendimento_eventos_excluidos WHERE ambiente=$1 AND excluido_em < clock_timestamp()-make_interval(days => $2) RETURNING 1', [ambiente, RETENCAO_DEDUP_DIAS])).rows.length;
    const estado = total.falhas ? 'CONCLUIDA_COM_FALHAS' : 'CONCLUIDA';
    await db().query(`UPDATE whatsapp_atendimento_retencao_execucoes SET estado=$2,terminada_em=clock_timestamp(),empresas=$3,excluidas=$4,adiadas=$5,falhas=$6,pendentes_removidas=$7,dedup_removidos=$8,erros=$9 WHERE id=$1`,
      [execucao, estado, total.empresas, total.excluidas, total.adiadas, total.falhas, total.pendentes, total.dedup, erros]);
    return { estado, execucao, ...total, erros };
  } catch (erro) {
    erros.push(codigoDoErro(erro));
    await db().query(`UPDATE whatsapp_atendimento_retencao_execucoes SET estado='FALHOU',terminada_em=clock_timestamp(),empresas=$2,excluidas=$3,adiadas=$4,falhas=$5,pendentes_removidas=$6,erros=$7 WHERE id=$1`,
      [execucao, total.empresas, total.excluidas, total.adiadas, total.falhas + 1, total.pendentes, erros.slice(0, 20)]);
    throw erro;
  }
}

/**
 * Ordem de travas. As ações de arquivo rodam no Tenant Context, que trava a empresa (FOR UPDATE); toda transação do worker
 * começa pela empresa (FOR SHARE): as duas já se serializam ali (revogacao-envio.postgres.test.ts). Depois da empresa, a
 * ordem segue a do worker (conversa → mensagem → arquivo): as conversas com saídas deste arquivo na fila são travadas
 * ANTES do arquivo, em ordem de id, para que um caminho futuro sem a trava da empresa não crie espera circular.
 */
async function travarConversasDoArquivo(tx: DbExecutor, arquivoId: string, empresa: string, ambiente: string) {
  await tx.query(`SELECT id FROM whatsapp_atendimento_conversas WHERE id IN (SELECT conversa_id FROM whatsapp_atendimento_mensagens
    WHERE midia_arquivo_id=$1 AND empresa_id=$2 AND ambiente=$3 AND estado IN ('PENDENTE','PROCESSANDO')) ORDER BY id FOR UPDATE`, [arquivoId, empresa, ambiente]);
}
/**
 * Saídas de um arquivo ainda na fila e, de cada resposta em grupo, as irmãs ainda na fila ("segue o PDF" nunca sai sem o
 * PDF): canceladas com motivo (o operador vê). A linha que o worker segura é pulada e revalidada por ele. Nas conversas
 * afetadas, os materiais cancelados saem da memória de envio do Wall-e e a resposta automática cancelada passa a conversa
 * à equipe. Conversa travada por outro (não travada antes por travarConversasDoArquivo): pulada; o worker, ao ler a saída
 * CANCELADA com motivo de arquivo, faz o mesmo tratamento.
 */
async function cancelarFilaDoArquivo(tx: DbExecutor, arquivoId: string, empresa: string, ambiente: string, motivo: 'ARQUIVO_INDISPONIVEL' | 'ARQUIVO_REVOGADO') {
  const linhas = (await tx.query<{ conversa_id: string; midia_pronta_id: string | null; automatica: boolean }>(`WITH arq AS (
      SELECT id, origem_grupo_id FROM whatsapp_atendimento_mensagens WHERE midia_arquivo_id=$1 AND empresa_id=$2 AND ambiente=$3 AND estado IN ('PENDENTE','PROCESSANDO') FOR UPDATE SKIP LOCKED),
    irmas AS (SELECT id FROM whatsapp_atendimento_mensagens WHERE origem_grupo_id IN (SELECT origem_grupo_id FROM arq WHERE origem_grupo_id IS NOT NULL)
      AND empresa_id=$2 AND ambiente=$3 AND direcao='SAIDA' AND estado IN ('PENDENTE','PROCESSANDO') FOR UPDATE SKIP LOCKED)
    UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA',motivo_cancelamento=$4 WHERE id IN (SELECT id FROM arq UNION SELECT id FROM irmas)
    RETURNING conversa_id, midia_pronta_id, autor_usuario_id IS NULL AS automatica`, [arquivoId, empresa, ambiente, motivo])).rows;
  const porConversa = new Map<string, { prontas: string[]; automatica: boolean }>();
  for (const l of linhas) {
    const c = porConversa.get(l.conversa_id) ?? { prontas: [], automatica: false };
    if (l.midia_pronta_id) c.prontas.push(l.midia_pronta_id);
    c.automatica ||= l.automatica;
    porConversa.set(l.conversa_id, c);
  }
  for (const [conversaId, c] of porConversa) {
    if (!(await tx.query('SELECT id FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE SKIP LOCKED', [conversaId])).rows.length) continue;
    if (c.prontas.length) await tx.query(`UPDATE whatsapp_atendimento_conversas SET contexto=jsonb_set(contexto,'{enviados}',COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(contexto->'enviados') e
      WHERE NOT (e->>'prontaId' = ANY($2::text[]))),'[]'::jsonb)) WHERE id=$1 AND jsonb_typeof(contexto->'enviados')='array'`, [conversaId, c.prontas]);
    if (c.automatica) await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1 AND estado='IA'", [conversaId]);
  }
  return linhas.length;
}
const novoToken = () => randomBytes(32).toString('base64url');
const dataFuturaValida = (d: Date) => !Number.isNaN(d.getTime()) && d.getTime() > Date.now() + 60_000 && d.getTime() <= Date.now() + 5 * 366 * 86400_000;

/**
 * D3 — revogação. Espera a transação de envio do worker em curso (empresa e arquivo FOR SHARE até gravar ENVIANDO).
 * Depois dela: com envio em andamento (ENVIANDO) ou uma resposta em grupo já parcialmente enviada com este arquivo ainda
 * na fila, recusa (ponto sem volta: a chamada ao provedor não é desfeita; um "segue o PDF" sem o PDF seria pior). Saída
 * já SUBMETIDA/ENTREGUE não é recolhida: a revogação só impede novos envios e novos acessos ao link.
 */
export async function revogarArquivo(sessao: SessaoPrivacidade, pedido: { arquivoId: string }) {
  return naEmpresaDaSessao(sessao, true, async (tx, empresa, ambiente) => {
    await travarConversasDoArquivo(tx, pedido.arquivoId, empresa, ambiente);
    const arquivo = (await tx.query('SELECT id FROM whatsapp_atendimento_arquivos WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND revogado_em IS NULL FOR UPDATE', [pedido.arquivoId, empresa, ambiente])).rows[0];
    if (!arquivo) throw new Error('ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO');
    const emCurso = await tx.query(`SELECT 1 FROM whatsapp_atendimento_mensagens m WHERE m.midia_arquivo_id=$1 AND m.empresa_id=$2 AND m.ambiente=$3 AND (m.estado='ENVIANDO'
      OR (m.estado IN ('PENDENTE','PROCESSANDO') AND m.origem_grupo_id IS NOT NULL AND EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens g
          WHERE g.origem_grupo_id=m.origem_grupo_id AND g.id<>m.id AND g.direcao='SAIDA' AND g.estado IN ('ENVIANDO','SUBMETIDA','ENTREGUE','INCERTO')))) LIMIT 1`, [pedido.arquivoId, empresa, ambiente]);
    if (emCurso.rows.length) throw new Error('ATENDIMENTO_ENVIO_EM_ANDAMENTO');
    const canceladas = await cancelarFilaDoArquivo(tx, pedido.arquivoId, empresa, ambiente, 'ARQUIVO_REVOGADO');
    const prontas = (await tx.query(`UPDATE whatsapp_atendimento_mensagens_prontas SET ativa=false,atalho=NULL,estado='ARQUIVADA',atualizada_por=$4,versao=versao+1,atualizada_em=clock_timestamp()
      WHERE arquivo_id=$1 AND empresa_id=$2 AND ambiente=$3 AND ativa RETURNING id`, [pedido.arquivoId, empresa, ambiente, sessao.usuario_id])).rows.length;
    await tx.query("UPDATE whatsapp_atendimento_arquivos SET revogado_em=clock_timestamp(),revogado_por=$2,conteudo=''::bytea,token=$3 WHERE id=$1", [pedido.arquivoId, sessao.usuario_id, novoToken()]);
    await tx.query(`INSERT INTO whatsapp_atendimento_privacidade(empresa_id,ambiente,acao,origem,usuario_id,arquivo_id,saidas_canceladas) VALUES($1,$2,'ARQUIVO_REVOGADO','PEDIDO',$3,$4,$5)`,
      [empresa, ambiente, sessao.usuario_id, pedido.arquivoId, canceladas]);
    return { prontasArquivadas: prontas, saidasCanceladas: canceladas };
  });
}

/** D3 — troca do link (o anterior deixa de servir; o arquivo continua em uso). */
export async function trocarLinkArquivo(sessao: SessaoPrivacidade, pedido: { arquivoId: string }) {
  return naEmpresaDaSessao(sessao, true, async (tx, empresa, ambiente) => {
    const r = await tx.query('UPDATE whatsapp_atendimento_arquivos SET token=$4,token_trocado_em=clock_timestamp() WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND revogado_em IS NULL RETURNING id',
      [pedido.arquivoId, empresa, ambiente, novoToken()]);
    if (!r.rows.length) throw new Error('ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO');
    await tx.query(`INSERT INTO whatsapp_atendimento_privacidade(empresa_id,ambiente,acao,origem,usuario_id,arquivo_id) VALUES($1,$2,'ARQUIVO_LINK_TROCADO','PEDIDO',$3,$4)`, [empresa, ambiente, sessao.usuario_id, pedido.arquivoId]);
  });
}

/**
 * D3 — expiração: `agora` (vence já: acesso e fila invalidados na hora) ou uma data futura (até 5 anos). Arquivo já
 * vencido não muda por aqui: reativar exige link novo (reativarArquivo). Data passada ou inválida: ATENDIMENTO_DATA_INVALIDA.
 */
export async function definirExpiracaoArquivo(sessao: SessaoPrivacidade, pedido: { arquivoId: string; expiraEm: 'agora' | string }) {
  const agora = pedido.expiraEm === 'agora';
  const data = agora ? null : new Date(pedido.expiraEm);
  if (!agora && !dataFuturaValida(data!)) throw new Error('ATENDIMENTO_DATA_INVALIDA');
  return naEmpresaDaSessao(sessao, true, async (tx, empresa, ambiente) => {
    if (agora) await travarConversasDoArquivo(tx, pedido.arquivoId, empresa, ambiente);
    const atual = (await tx.query<{ vencido: boolean }>(`SELECT (expira_em IS NOT NULL AND expira_em <= clock_timestamp()) AS vencido FROM whatsapp_atendimento_arquivos
      WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND revogado_em IS NULL FOR UPDATE`, [pedido.arquivoId, empresa, ambiente])).rows[0];
    if (!atual) throw new Error('ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO');
    if (atual.vencido) throw new Error('ATENDIMENTO_ARQUIVO_VENCIDO');
    const r = agora
      ? await tx.query<{ expira_em: Date }>("UPDATE whatsapp_atendimento_arquivos SET expira_em=GREATEST(clock_timestamp(), criado_em + interval '1 millisecond') WHERE id=$1 RETURNING expira_em", [pedido.arquivoId])
      : await tx.query<{ expira_em: Date }>('UPDATE whatsapp_atendimento_arquivos SET expira_em=$2::timestamptz WHERE id=$1 RETURNING expira_em', [pedido.arquivoId, data!.toISOString()]);
    const canceladas = agora ? await cancelarFilaDoArquivo(tx, pedido.arquivoId, empresa, ambiente, 'ARQUIVO_INDISPONIVEL') : 0;
    await tx.query(`INSERT INTO whatsapp_atendimento_privacidade(empresa_id,ambiente,acao,origem,usuario_id,arquivo_id,saidas_canceladas,expira_em) VALUES($1,$2,'ARQUIVO_EXPIRACAO_DEFINIDA','PEDIDO',$3,$4,$5,$6)`,
      [empresa, ambiente, sessao.usuario_id, pedido.arquivoId, canceladas, r.rows[0].expira_em]);
    return { expiraEm: new Date(r.rows[0].expira_em).toISOString(), saidasCanceladas: canceladas };
  });
}

/** D3 — reativação explícita de arquivo vencido: link novo obrigatório (o anterior nunca volta), sem expiração ou nova data. */
export async function reativarArquivo(sessao: SessaoPrivacidade, pedido: { arquivoId: string; expiraEm: string | null }) {
  const data = pedido.expiraEm === null ? null : new Date(pedido.expiraEm);
  if (data && !dataFuturaValida(data)) throw new Error('ATENDIMENTO_DATA_INVALIDA');
  return naEmpresaDaSessao(sessao, true, async (tx, empresa, ambiente) => {
    const r = await tx.query(`UPDATE whatsapp_atendimento_arquivos SET expira_em=$4::timestamptz,token=$5,token_trocado_em=clock_timestamp()
      WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND revogado_em IS NULL AND expira_em IS NOT NULL AND expira_em <= clock_timestamp() RETURNING id`,
      [pedido.arquivoId, empresa, ambiente, data ? data.toISOString() : null, novoToken()]);
    if (!r.rows.length) throw new Error('ATENDIMENTO_ARQUIVO_NAO_VENCIDO');
    await tx.query(`INSERT INTO whatsapp_atendimento_privacidade(empresa_id,ambiente,acao,origem,usuario_id,arquivo_id,expira_em) VALUES($1,$2,'ARQUIVO_REATIVADO','PEDIDO',$3,$4,$5)`,
      [empresa, ambiente, sessao.usuario_id, pedido.arquivoId, data ? data.toISOString() : null]);
  });
}

export type SituacaoPrivacidade = {
  conversas: { id: string; contatoFinal: string; estado: string; naoContatar: boolean; pausa: boolean; mensagens: number; atualizadaEm: string }[];
  arquivos: { id: string; nome: string; tipo: string; tamanho: number; criadoEm: string; expiraEm: string | null; revogadoEm: string | null; disponivel: boolean; vencido: boolean; caminho: string | null }[];
  retencao: { prazoDias: number | null; definidoEm: string | null; ultimaExecucao: { iniciadaEm: string; terminadaEm: string | null; estado: string; excluidasDestaEmpresa: number; falhas: number; erros: string[] } | null };
  registro: { acao: string; origem: string; criadaEm: string; mensagens: number | null; saidasCanceladas: number | null; prazoDias: number | null }[];
};
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
/** Tela de privacidade: só leitura, da empresa ativa (não da piloto), só a Gestão. Contato só com os 4 últimos dígitos. */
export async function situacaoPrivacidade(sessao: SessaoPrivacidade): Promise<SituacaoPrivacidade> {
  return naEmpresaDaSessao(sessao, false, async (tx, empresa, ambiente) => {
    const conversas = (await tx.query<{ id: string; contato_final: string; estado: string; nao_contatar: boolean; pausa: boolean; atualizada_em: Date; mensagens: number }>(`SELECT c.id,right(c.contato,4) AS contato_final,c.estado,c.nao_contatar,(c.contexto ? 'semAutomatico') AS pausa,c.atualizada_em,
        (SELECT count(*)::int FROM whatsapp_atendimento_mensagens m WHERE m.conversa_id=c.id) AS mensagens
      FROM whatsapp_atendimento_conversas c WHERE c.empresa_id=$1 AND c.ambiente=$2 ORDER BY c.atualizada_em DESC LIMIT 200`, [empresa, ambiente])).rows;
    const arquivos = (await tx.query<{ id: string; nome: string; tipo: string; tamanho_bytes: number; criado_em: Date; expira_em: Date | null; revogado_em: Date | null; token: string; disponivel: boolean; vencido: boolean }>(`SELECT a.id,a.nome,a.tipo,a.tamanho_bytes,a.criado_em,a.expira_em,a.revogado_em,a.token,(${ARQUIVO_DISPONIVEL_SQL}) AS disponivel,(a.revogado_em IS NULL AND a.expira_em IS NOT NULL AND a.expira_em <= clock_timestamp()) AS vencido
      FROM whatsapp_atendimento_arquivos a WHERE a.empresa_id=$1 AND a.ambiente=$2 ORDER BY a.criado_em DESC LIMIT 200`, [empresa, ambiente])).rows;
    const cfg = (await tx.query<{ prazo_dias: number | null; definido_em: Date }>('SELECT prazo_dias,definido_em FROM whatsapp_atendimento_retencao_config WHERE empresa_id=$1 AND ambiente=$2', [empresa, ambiente])).rows[0];
    const ultima = (await tx.query<{ id: string; iniciada_em: Date; terminada_em: Date | null; estado: string; falhas: number; erros: string[] | null }>('SELECT id,iniciada_em,terminada_em,estado,falhas,erros FROM whatsapp_atendimento_retencao_execucoes WHERE ambiente=$1 ORDER BY iniciada_em DESC LIMIT 1', [ambiente])).rows[0];
    const daEmpresa = ultima ? Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM whatsapp_atendimento_privacidade WHERE empresa_id=$1 AND ambiente=$2 AND origem='RETENCAO'
      AND criada_em >= $3 AND ($4::timestamptz IS NULL OR criada_em <= $4)`, [empresa, ambiente, ultima.iniciada_em, ultima.terminada_em])).rows[0]?.n ?? 0) : 0;
    const registro = (await tx.query<{ acao: string; origem: string; criada_em: Date; mensagens_removidas: number | null; saidas_canceladas: number | null; prazo_dias: number | null }>(`SELECT acao,origem,criada_em,mensagens_removidas,saidas_canceladas,prazo_dias FROM whatsapp_atendimento_privacidade
      WHERE empresa_id=$1 AND ambiente=$2 ORDER BY criada_em DESC LIMIT 50`, [empresa, ambiente])).rows;
    return {
      conversas: conversas.map((c) => ({ id: c.id, contatoFinal: c.contato_final, estado: c.estado, naoContatar: c.nao_contatar, pausa: !!c.pausa, mensagens: Number(c.mensagens), atualizadaEm: iso(c.atualizada_em)! })),
      arquivos: arquivos.map((a) => ({ id: a.id, nome: a.nome, tipo: a.tipo, tamanho: Number(a.tamanho_bytes), criadoEm: iso(a.criado_em)!, expiraEm: iso(a.expira_em), revogadoEm: iso(a.revogado_em),
        disponivel: !!a.disponivel, vencido: !!a.vencido, caminho: a.disponivel ? caminhoPublicoArquivo(a.id, a.token, a.nome) : null })),
      retencao: { prazoDias: cfg?.prazo_dias ?? null, definidoEm: iso(cfg?.definido_em), ultimaExecucao: ultima ? { iniciadaEm: iso(ultima.iniciada_em)!, terminadaEm: iso(ultima.terminada_em), estado: ultima.estado, excluidasDestaEmpresa: daEmpresa, falhas: Number(ultima.falhas), erros: ultima.erros ?? [] } : null },
      registro: registro.map((r) => ({ acao: r.acao, origem: r.origem, criadaEm: iso(r.criada_em)!, mensagens: r.mensagens_removidas ?? null, saidasCanceladas: r.saidas_canceladas ?? null, prazoDias: r.prazo_dias ?? null })),
    };
  });
}
