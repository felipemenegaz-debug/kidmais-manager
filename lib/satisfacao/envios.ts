import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { assinarToken, hashDoToken, type AnelChaves } from "./token.ts";
import { travarPais } from "./travas.ts";

/**
 * Criação do envio (chamada pela execução PESQUISA_SATISFACAO do motor, PS-2) e recuperação do link (despacho, PS-2).
 * Uma pesquisa por festa: UNIQUE (empresa_id, fechamento_id) no banco; a criação pega a trava por cliente do motor, trava
 * os pais NOWAIT (55P03 sobe para o motor, que devolve a execução para AGENDADA sem consumir tentativa) e grava o envio e
 * as entregas INICIAL de cada canal na mesma transação. O token não é gravado nem devolvido: o despacho o recalcula.
 */
export type CanalPesquisa = "WHATSAPP" | "EMAIL";
export type ResultadoCriacao =
  | { criado: true; envioId: string }
  | { criado: false; motivo: "PESQUISA_JA_EXISTE" | "FESTA_CANCELADA" | "CONTRATO_NAO_ASSINADO" | "EXECUCAO_INVALIDA" };

export async function criarEnvio(tx: DbExecutor, anel: AnelChaves, entrada: {
  empresaId: string; execucaoId: string; canais: readonly CanalPesquisa[]; agendadaPara: Date; maxTentativas: number;
}): Promise<ResultadoCriacao> {
  const x = (await tx.query<{ fechamento_id: string | null; cliente_id: string; acao: string }>(
    `SELECT fechamento_id::text, cliente_id::text, acao FROM marketing_automacao_execucoes WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [entrada.execucaoId, entrada.empresaId])).rows[0];
  if (!x || !x.fechamento_id || x.acao !== "PESQUISA_SATISFACAO" || entrada.canais.length === 0) return { criado: false, motivo: "EXECUCAO_INVALIDA" };
  // Mesma trava por cliente do motor (reentrante na transação): frequência e criação do mesmo cliente nunca correm juntas.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('marketing:' || $1 || ':' || $2))`, [entrada.empresaId, x.cliente_id]);
  const existente = await tx.query(`SELECT 1 FROM satisfacao_envios WHERE empresa_id = $1::uuid AND fechamento_id = $2::uuid`, [entrada.empresaId, x.fechamento_id]);
  if (existente.rows.length > 0) return { criado: false, motivo: "PESQUISA_JA_EXISTE" };
  const festa = await travarPais(tx, x.fechamento_id);
  if (!festa.valida) return { criado: false, motivo: festa.motivo! };
  const envioId = randomUUID();
  const hash = hashDoToken(assinarToken(anel, envioId, 1, anel.atual));
  // Unidade da festa na criação (o gatilho confere e trava o fechamento de novo, NOWAIT); validade = criação + 30 dias.
  await tx.query(
    `WITH agora AS (SELECT clock_timestamp() AS t)
     INSERT INTO satisfacao_envios (id, empresa_id, estabelecimento_id, fechamento_id, cliente_id, execucao_id, chave_versao, token_hash, criado_em, expira_em)
     SELECT $1::uuid, $2::uuid, f.estabelecimento_id, f.id, f.cliente_id, $3::uuid, $4, $5::bytea, agora.t, agora.t + interval '30 days'
       FROM fechamentos f, agora WHERE f.id = $6::uuid`,
    [envioId, entrada.empresaId, entrada.execucaoId, anel.atual, hash, x.fechamento_id]);
  for (const canal of new Set(entrada.canais)) {
    await tx.query(
      `INSERT INTO satisfacao_entregas (empresa_id, envio_id, canal, etapa, agendada_para, max_tentativas) VALUES ($1::uuid, $2::uuid, $3, 'INICIAL', $4::timestamptz, $5)`,
      [entrada.empresaId, envioId, canal, entrada.agendadaPara.toISOString(), entrada.maxTentativas]);
  }
  return { criado: true, envioId };
}

/**
 * Link de um envio ATIVO para o despacho, já com o envio travado (FOR UPDATE) pelo chamador.
 *   - chave do envio no anel: o mesmo link (rotação normal; o lembrete leva o mesmo link);
 *   - chave retirada: UMA regeneração (geração + 1, chave atual, hash novo) por UPDATE condicional à geração/chave lidas;
 *     quem perde a corrida relê a linha e usa a geração nova. O link antigo deixa de valer.
 */
export async function linkDoEnvio(tx: DbExecutor, anel: AnelChaves, envioId: string): Promise<{ token: string; geracao: number; regenerado: boolean } | null> {
  for (let i = 0; i < 2; i++) {
    const e = (await tx.query<{ geracao: number; chave_versao: number; estado: string }>(
      `SELECT geracao, chave_versao, estado FROM satisfacao_envios WHERE id = $1::uuid`, [envioId])).rows[0];
    if (!e || e.estado !== "ATIVO") return null;
    if (anel.chaves.has(e.chave_versao)) return { token: assinarToken(anel, envioId, e.geracao, e.chave_versao), geracao: e.geracao, regenerado: false };
    const geracao = e.geracao + 1;
    const token = assinarToken(anel, envioId, geracao, anel.atual);
    const r = await tx.query(
      `UPDATE satisfacao_envios SET geracao = $2, chave_versao = $3, token_hash = $4::bytea
        WHERE id = $1::uuid AND geracao = $5 AND chave_versao = $6 AND estado = 'ATIVO'`,
      [envioId, geracao, anel.atual, hashDoToken(token), e.geracao, e.chave_versao]);
    if (r.rowCount === 1) return { token, geracao, regenerado: true };
  }
  return null;
}
