import type { EstadoOperacao, HumanGateDraft } from "../inteligencia/contratos.ts";
import type { RepositorioOperacoes } from "../inteligencia/acoes/tipos.ts";

/**
 * Human Gate em PostgreSQL (tabela `ia_operacoes`, migration 055 — NÃO aplicada).
 * Toda consulta filtra empresa comprovada e usuário. `atualizar` é compare-and-set por versão e estado.
 */
type Linha = {
  id: string; empresa_id: string; usuario_id: string; correlation_id: string; idempotency_key: string;
  capacidade: string; ferramenta: string; estado: EstadoOperacao; versao: number; payload: Record<string, unknown>;
  payload_hash: string; resultado: Record<string, unknown> | null; expira_em: string; criado_em: string; atualizado_em: string;
};

function mapear(l: Linha): HumanGateDraft {
  return {
    operacaoId: l.id,
    correlationId: l.correlation_id,
    idempotencyKey: l.idempotency_key,
    capacidade: l.capacidade,
    ferramenta: l.ferramenta,
    empresaId: l.empresa_id,
    usuarioId: l.usuario_id,
    estado: l.estado,
    versao: Number(l.versao),
    payload: l.payload,
    payloadHash: l.payload_hash,
    expiraEm: new Date(l.expira_em).toISOString(),
    criadoEm: new Date(l.criado_em).toISOString(),
    atualizadoEm: new Date(l.atualizado_em).toISOString(),
    resultado: l.resultado,
  };
}

const COLUNAS = `id::text, empresa_id::text, usuario_id::text, correlation_id, idempotency_key::text, capacidade, ferramenta,
  estado, versao, payload, payload_hash, resultado, expira_em::text, criado_em::text, atualizado_em::text`;

export const repositorioOperacoesPostgres: RepositorioOperacoes = {
  async disponivel(tx) {
    const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_operacoes') IS NOT NULL AS ok`);
    return r.rows[0]?.ok === true;
  },
  async criar(tx, d) {
    await tx.query(
      `INSERT INTO ia_operacoes (id, empresa_id, usuario_id, correlation_id, idempotency_key, capacidade, ferramenta,
         estado, versao, payload, payload_hash, resultado, expira_em, criado_em, atualizado_em)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13::timestamptz, $14::timestamptz, $15::timestamptz)`,
      [d.operacaoId, d.empresaId, d.usuarioId, d.correlationId.slice(0, 100), d.idempotencyKey, d.capacidade, d.ferramenta,
        d.estado, d.versao, JSON.stringify(d.payload), d.payloadHash, d.resultado ? JSON.stringify(d.resultado) : null, d.expiraEm, d.criadoEm, d.atualizadoEm],
    );
  },
  async buscar(tx, filtro, travar) {
    const r = await tx.query<Linha>(
      `SELECT ${COLUNAS} FROM ia_operacoes
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND usuario_id = $3::uuid${travar ? " FOR UPDATE" : ""}`,
      [filtro.operacaoId, filtro.empresaId, filtro.usuarioId],
    );
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },
  async atualizar(tx, d, esperado) {
    const r = await tx.query(
      `UPDATE ia_operacoes
          SET estado = $5, versao = $6, payload = $7::jsonb, payload_hash = $8, resultado = $9::jsonb,
              expira_em = $10::timestamptz, atualizado_em = $11::timestamptz
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND usuario_id = $3::uuid AND versao = $4 AND estado = $12
        RETURNING id`,
      [d.operacaoId, d.empresaId, d.usuarioId, esperado.versao, d.estado, d.versao, JSON.stringify(d.payload), d.payloadHash,
        d.resultado ? JSON.stringify(d.resultado) : null, d.expiraEm, d.atualizadoEm, esperado.estado],
    );
    return r.rowCount === 1;
  },
};
