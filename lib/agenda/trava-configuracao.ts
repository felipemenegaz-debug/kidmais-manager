import type { DbExecutor } from "../db/contracts.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 2/3, aprovado pelo Astra na rev. 7): protocolo de entrada
 * "linha da empresa → configuração da agenda → resto como hoje".
 *
 * - A linha de `empresas` vem antes da configuração: a entrada administrativa já a tem em FOR UPDATE (provarTenant);
 *   a pública, o worker e o webhook a tomam em FOR KEY SHARE como primeiro comando (a FK de fechamentos pede esse modo).
 * - A configuração é a advisory `kidmais:agenda-config:<empresa>`, sempre de transação (xact): compartilhada para quem
 *   lê a regra ou toma trava da agenda; exclusiva para quem muda a regra (save, horários, salões, combinados).
 * - Nenhuma transação toma a linha da empresa num modo mais forte depois da configuração, nem a exclusiva depois da
 *   compartilhada.
 *
 * A empresa travada fica em `kidmais.agenda_config_empresa` (local à transação) para os helpers que não recebem a
 * empresa (as travas de data são globais); a guarda confere a trava em pg_locks, nunca só a variável.
 */
export type ModoConfiguracao = "COMPARTILHADA" | "EXCLUSIVA";
/**
 * KEY_SHARE: entrada pública/worker/webhook; JA_TRAVADA: entrada administrativa (provarTenant já fez FOR UPDATE);
 * SO_LEITURA: transação READ ONLY (o PostgreSQL recusa FOR KEY SHARE nela e ela não insere fechamento, então a FK nunca
 * pede a linha).
 */
export type LinhaEmpresa = "KEY_SHARE" | "JA_TRAVADA" | "SO_LEITURA";

const CHAVE = `hashtextextended('kidmais:agenda-config:' || $1::text, 0)`;

export async function travarConfiguracaoAgenda(tx: DbExecutor, empresaId: string, opcoes: { modo: ModoConfiguracao; linha: LinhaEmpresa }) {
  if (opcoes.linha === "KEY_SHARE") await tx.query(`SELECT 1 FROM empresas WHERE id = $1::uuid FOR KEY SHARE`, [empresaId]);
  await tx.query(
    opcoes.modo === "EXCLUSIVA" ? `SELECT pg_advisory_xact_lock(${CHAVE})` : `SELECT pg_advisory_xact_lock_shared(${CHAVE})`,
    [empresaId],
  );
  await tx.query(`SELECT set_config('kidmais.agenda_config_empresa', $1::text, true)`, [empresaId]);
}

/** Empresa da festa (fechamento) ou do contrato, lida sem trava, para a entrada travar antes de tudo. */
export async function empresaDoFechamento(tx: DbExecutor, fechamentoId: string) {
  return (await tx.query<{ e: string }>(`SELECT empresa_id::text AS e FROM fechamentos WHERE id = $1::uuid`, [fechamentoId])).rows[0]?.e ?? null;
}
export async function empresaDoPagamento(tx: DbExecutor, pagamentoId: string) {
  return (await tx.query<{ e: string }>(
    `SELECT f.empresa_id::text AS e FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id
       JOIN contratos c ON c.id = v.contrato_id JOIN fechamentos f ON f.id = c.fechamento_id WHERE p.id = $1::uuid`, [pagamentoId],
  )).rows[0]?.e ?? null;
}
export async function empresaDoContrato(tx: DbExecutor, contratoId: string) {
  return (await tx.query<{ e: string }>(
    `SELECT f.empresa_id::text AS e FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id WHERE c.id = $1::uuid`, [contratoId],
  )).rows[0]?.e ?? null;
}

export class TravaConfiguracaoAusenteError extends Error {
  readonly code = "TRAVA_CONFIGURACAO_AUSENTE";
  constructor(empresaId: string | null) {
    super(`Trava da configuração da agenda ausente nesta transação${empresaId ? ` (empresa ${empresaId})` : ""}.`);
    this.name = "TravaConfiguracaoAusenteError";
  }
}

/**
 * Guarda de execução (rev. 3): a configuração da empresa está segura NESTA transação — pg_locks com granted, banco
 * atual (OID), advisory, as duas metades da chave bigint em classid/objid, objsubid = 1 (forma bigint), modo Share ou
 * Exclusive e o próprio backend. Sem empresa, usa a da entrada (kidmais.agenda_config_empresa). Falha fechada: sem
 * linha de resposta também recusa.
 */
export async function exigirTravaConfiguracao(tx: DbExecutor, empresaId?: string | null) {
  const r = await tx.query<{ ok: boolean; empresa: string | null }>(
    `WITH alvo AS (SELECT coalesce($1::text, nullif(current_setting('kidmais.agenda_config_empresa', true), '')) AS empresa),
          chave AS (SELECT empresa, hashtextextended('kidmais:agenda-config:' || empresa, 0) AS k FROM alvo)
     SELECT chave.empresa, EXISTS (
       SELECT 1 FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted AND l.pid = pg_backend_pid()
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.objsubid = 1
          AND l.classid::bigint = ((chave.k >> 32) & 4294967295)
          AND l.objid::bigint = (chave.k & 4294967295)
          AND l.mode IN ('ShareLock', 'ExclusiveLock')
     ) AND chave.empresa IS NOT NULL AS ok
       FROM chave`,
    [empresaId ?? null],
  );
  if (r.rows[0]?.ok !== true) throw new TravaConfiguracaoAusenteError(empresaId ?? r.rows[0]?.empresa ?? null);
}
