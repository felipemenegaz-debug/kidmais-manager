import { z } from "zod";
import type { DbExecutor } from "../db/contracts.ts";
import { withTransaction as withTransactionPadrao } from "../db/postgres.ts";
import { consumirOrigem, type RegraOrigem } from "../acessos/limite-origem.ts";
import { nomePublicoDaEmpresa } from "../perfil/nome-publico.ts";
import { configuracaoIndisponivel, linkIndisponivel, SatisfacaoError } from "./erros.ts";
import { esquemaResposta, precisaDeTarefa, primeiroNome, VERSAO_QUESTIONARIO, type RespostaQuestionario } from "./questionario.ts";
import { suprimirPesquisas } from "./supressao.ts";
import { lerAnel, mesmoHash, verificarToken, type AnelChaves, type TokenVerificado } from "./token.ts";
import { comRepeticao, travarPais, TravaOcupada, type Repeticao } from "./travas.ts";

/**
 * Página pública da pesquisa (plano R8 + N1 + M1 + L5). Ordem de proteção em todas as rotas:
 *   1. formato e HMAC do token EM MEMÓRIA — token inventado não consulta nem grava nada (nem no limite);
 *   2. limite de tentativas (consumirOrigem): com IP confiável, por IP; sem IP, pelo hash do token (5 em 10 min);
 *   3. banco: envio FOR UPDATE (marcador satisfacao:travar-envio), identidade (geração, chave, hash em tempo constante),
 *      validade e festa (pais FOR SHARE NOWAIT, repetição integral em 55P03 até 5 tentativas).
 * Empresa, unidade e cliente saem do envio que o token identifica; o corpo do POST nunca decide isso. Nada do corpo
 * (token, notas, comentário) é registrado em log.
 */
export type ContextoPublico = { ip: string | null };
export type DepsPublico = {
  withTransaction: <T>(work: (tx: DbExecutor) => Promise<T>) => Promise<T>;
  anel: () => AnelChaves | null;
  repeticao?: Repeticao;
  /** Gravação da tarefa da nota baixa (dublável para provar o rollback integral). */
  criarTarefa?: (tx: DbExecutor, envio: EnvioTravado, respostaId: string) => Promise<void>;
};

export function depsPublicoPadrao(): DepsPublico {
  return { withTransaction: withTransactionPadrao, anel: () => lerAnel() };
}

const JANELA = 600;
export const REGRAS = {
  abrir: { namespace: "satisfacao-abrir", janelaSegundos: JANELA, limite: 30 },
  responder: { namespace: "satisfacao-responder", janelaSegundos: JANELA, limite: 10 },
  sair: { namespace: "satisfacao-sair", janelaSegundos: JANELA, limite: 10 },
} satisfies Record<string, RegraOrigem>;
export const LIMITE_SEM_ORIGEM = 5;

type EnvioTravado = {
  id: string; empresa_id: string; estabelecimento_id: string | null; fechamento_id: string; cliente_id: string; geracao: number; chave_versao: number;
  token_hash: Buffer; estado: string; vencido: boolean;
};

/** Passos 1 e 2: token verificado em memória e uma tentativa consumida (transação própria, confirmada antes do resto). */
async function verificarEConsumir(deps: DepsPublico, token: unknown, regra: RegraOrigem, ctx: ContextoPublico): Promise<{ anel: AnelChaves; v: TokenVerificado }> {
  const anel = deps.anel();
  if (!anel) configuracaoIndisponivel();
  const v = verificarToken(anel, token);
  if (!v) linkIndisponivel();
  const regraEfetiva = ctx.ip ? regra : { ...regra, limite: LIMITE_SEM_ORIGEM };
  const recusa = await deps.withTransaction((tx) => consumirOrigem(tx, ctx.ip, regraEfetiva, { porIdentificador: v.hash.toString("hex") }));
  if (recusa) {
    throw new SatisfacaoError("MUITAS_TENTATIVAS", "Muitas tentativas. Aguarde alguns minutos e tente de novo.", 429,
      recusa.aguardar ? { retryAfterSegundos: recusa.aguardar } : null);
  }
  return { anel, v };
}

/** Envio do token travado FOR UPDATE; null quando a identidade não confere (resposta genérica). */
async function travarEnvio(tx: DbExecutor, v: TokenVerificado): Promise<EnvioTravado | null> {
  const e = (await tx.query<EnvioTravado>(
    `/* satisfacao:travar-envio */ SELECT id::text, empresa_id::text, estabelecimento_id::text, fechamento_id::text, cliente_id::text, geracao, chave_versao,
            token_hash, estado, expira_em <= clock_timestamp() AS vencido
       FROM satisfacao_envios WHERE id = $1::uuid FOR UPDATE`, [v.envioId])).rows[0];
  if (!e || e.geracao !== v.geracao || e.chave_versao !== v.chaveVersao || !mesmoHash(e.token_hash, v.hash)) return null;
  return e;
}

async function cancelarPendentes(tx: DbExecutor, envioId: string, motivo: string) {
  await tx.query(`UPDATE satisfacao_entregas SET estado = 'CANCELADA', motivo = $2, concluida_em = clock_timestamp() WHERE envio_id = $1::uuid AND estado = 'PENDENTE'`,
    [envioId, motivo]);
}

/**
 * Situação do envio para abrir/responder, com o envio travado: vencido vira EXPIRADO; festa cancelada ou contrato que
 * deixou de estar ASSINADO revoga (pais NOWAIT — 55P03 sobe e a transação inteira repete). RESPONDIDO é terminal e
 * preservado mesmo com a festa cancelada depois.
 */
async function situacao(tx: DbExecutor, e: EnvioTravado): Promise<"ATIVO" | "RESPONDIDO" | "INDISPONIVEL"> {
  if (e.estado === "RESPONDIDO") return "RESPONDIDO";
  if (e.estado !== "ATIVO") return "INDISPONIVEL";
  if (e.vencido) {
    await tx.query(`UPDATE satisfacao_envios SET estado = 'EXPIRADO', expirado_em = clock_timestamp() WHERE id = $1::uuid`, [e.id]);
    await cancelarPendentes(tx, e.id, "EXPIRADO");
    return "INDISPONIVEL";
  }
  const festa = await travarPais(tx, e.fechamento_id);
  if (!festa.valida) {
    await tx.query(`UPDATE satisfacao_envios SET estado = 'REVOGADO', revogado_em = clock_timestamp(), motivo_revogacao = $2 WHERE id = $1::uuid`, [e.id, festa.motivo]);
    await cancelarPendentes(tx, e.id, festa.motivo!);
    return "INDISPONIVEL";
  }
  return "ATIVO";
}

/** Repetição integral; esgotada, o cliente recebe "tente de novo em instantes" (nada foi gravado). */
async function repetir<T>(deps: DepsPublico, trabalho: (tx: DbExecutor) => Promise<T>): Promise<T> {
  try {
    return await comRepeticao(() => deps.withTransaction(trabalho), deps.repeticao);
  } catch (error) {
    if (error instanceof TravaOcupada) throw new SatisfacaoError("TENTE_NOVAMENTE", "Não foi possível registrar agora. Tente de novo em instantes.", 503);
    throw error;
  }
}

const esquemaToken = z.object({ token: z.string().max(200) }).strict();
const esquemaSaida = z.object({ token: z.string().max(200), origem: z.enum(["PAGINA", "LINK_EMAIL"]).default("PAGINA") }).strict();

export type Abertura =
  | { situacao: "ABERTA"; primeiroNome: string; buffet: string; unidade: string | null; dataFesta: string; versaoQuestionario: number }
  | { situacao: "RESPONDIDA"; buffet: string };

export async function abrirPesquisa(raw: unknown, ctx: ContextoPublico, deps: DepsPublico = depsPublicoPadrao()): Promise<Abertura> {
  const corpo = esquemaToken.safeParse(raw);
  const { v } = await verificarEConsumir(deps, corpo.success ? corpo.data.token : null, REGRAS.abrir, ctx);
  const r = await repetir(deps, async (tx) => {
    const e = await travarEnvio(tx, v);
    if (!e) return null;
    const s = await situacao(tx, e);
    if (s === "INDISPONIVEL") return null;
    const buffet = (await nomePublicoDaEmpresa(tx, e.empresa_id)) ?? "buffet";
    if (s === "RESPONDIDO") return { situacao: "RESPONDIDA" as const, buffet };
    const d = (await tx.query<{ nome: string | null; unidade: string | null; data: string }>(
      `SELECT c.nome_completo AS nome, u.nome AS unidade, to_char(f.data_evento, 'YYYY-MM-DD') AS data
         FROM fechamentos f JOIN clientes c ON c.id = $2::uuid LEFT JOIN estabelecimentos u ON u.empresa_id = f.empresa_id AND u.id = $3::uuid
        WHERE f.id = $1::uuid`, [e.fechamento_id, e.cliente_id, e.estabelecimento_id])).rows[0];
    return { situacao: "ABERTA" as const, primeiroNome: primeiroNome(d?.nome), buffet, unidade: d?.unidade ?? null, dataFesta: d?.data ?? "", versaoQuestionario: VERSAO_QUESTIONARIO };
  });
  // Expiração/revogação gravadas acima já foram confirmadas; o cliente recebe a mesma resposta genérica.
  if (!r) linkIndisponivel();
  return r;
}

async function criarTarefaPadrao(tx: DbExecutor, e: EnvioTravado, respostaId: string) {
  await tx.query(`INSERT INTO satisfacao_tarefas (empresa_id, estabelecimento_id, envio_id, resposta_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    [e.empresa_id, e.estabelecimento_id, e.id, respostaId]);
}

/**
 * Resposta atômica (R7/N5): envio FOR UPDATE → identidade → validade/festa (NOWAIT) → resposta → RESPONDIDO → entregas
 * pendentes canceladas → tarefa (nota 0–6) → COMMIT. Qualquer falha (inclusive da tarefa) volta tudo. Segundo POST:
 * "já respondida", sem sobrescrever nem criar outra tarefa.
 */
export async function responderPesquisa(raw: unknown, ctx: ContextoPublico, deps: DepsPublico = depsPublicoPadrao()) {
  const token = typeof (raw as { token?: unknown })?.token === "string" ? (raw as { token: string }).token : null;
  const { v } = await verificarEConsumir(deps, token, REGRAS.responder, ctx);
  const resposta: RespostaQuestionario = esquemaResposta.parse(raw);
  const criarTarefa = deps.criarTarefa ?? criarTarefaPadrao;
  const r = await repetir(deps, async (tx) => {
    const e = await travarEnvio(tx, v);
    if (!e) return "INDISPONIVEL" as const;
    const s = await situacao(tx, e);
    if (s !== "ATIVO") return s;
    const id = (await tx.query<{ id: string }>(
      `INSERT INTO satisfacao_respostas (empresa_id, envio_id, versao_questionario, nota_indicacao, nota_comida, nota_equipe, nota_espaco, comentario)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
      [e.empresa_id, e.id, VERSAO_QUESTIONARIO, resposta.notaIndicacao, resposta.notaComida, resposta.notaEquipe, resposta.notaEspaco, resposta.comentario])).rows[0].id;
    await tx.query(`UPDATE satisfacao_envios SET estado = 'RESPONDIDO', respondido_em = clock_timestamp() WHERE id = $1::uuid`, [e.id]);
    await cancelarPendentes(tx, e.id, "RESPONDIDA");
    if (precisaDeTarefa(resposta.notaIndicacao)) await criarTarefa(tx, e, id);
    return "GRAVADA" as const;
  });
  if (r === "INDISPONIVEL") linkIndisponivel();
  if (r === "RESPONDIDO") throw new SatisfacaoError("JA_RESPONDIDA", "Esta pesquisa já foi respondida. Obrigado!", 409);
  return { gravada: true as const };
}

/**
 * Saída das pesquisas (só POST; GET não grava): vale para os dois canais das PESQUISAS desta empresa e não toca no
 * Marketing (descadastro geral é outra coisa). Aceita link de envio já encerrado — sair precisa sempre funcionar.
 */
export async function sairDasPesquisas(raw: unknown, ctx: ContextoPublico, deps: DepsPublico = depsPublicoPadrao()) {
  const corpo = esquemaSaida.safeParse(raw);
  const { v } = await verificarEConsumir(deps, corpo.success ? corpo.data.token : null, REGRAS.sair, ctx);
  if (!corpo.success) linkIndisponivel();
  const r = await repetir(deps, async (tx) => {
    const e = await travarEnvio(tx, v);
    if (!e) return false;
    await tx.query(`INSERT INTO satisfacao_saidas (empresa_id, cliente_id, origem) VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT (empresa_id, cliente_id) DO NOTHING`,
      [e.empresa_id, e.cliente_id, corpo.data.origem]);
    await suprimirPesquisas(tx, e.empresa_id, e.cliente_id, { canal: "TODOS", motivo: "SAIDA_PESQUISAS" });
    return true;
  });
  if (!r) linkIndisponivel();
  return { saiu: true as const };
}
