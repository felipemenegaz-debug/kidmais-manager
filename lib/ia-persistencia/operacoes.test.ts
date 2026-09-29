import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../db/contracts.ts";
import type { HumanGateDraft } from "../inteligencia/contratos.ts";
import { repositorioOperacoesPostgres } from "./operacoes.ts";

function executor(respostas: (sql: string, values: readonly unknown[]) => object[] | { rows: object[]; rowCount: number }) {
  const consultas: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push({ sql, values });
      const r = respostas(sql, values);
      return (Array.isArray(r) ? { rows: r, rowCount: r.length } : r) as { rows: Row[]; rowCount: number };
    },
  };
  return { tx, consultas };
}

const draft: HumanGateDraft = {
  operacaoId: "00000001-0000-4000-8000-000000000000", correlationId: "req-1", idempotencyKey: "00000001-0000-4000-8000-000000000000",
  capacidade: "criar_pacote", ferramenta: "pacotes.criar", empresaId: "11111111-1111-4111-8111-111111111111", usuarioId: "aaaaaaaa-0000-4000-8000-000000000001",
  estado: "AGUARDANDO_CONFIRMACAO", versao: 3, payload: { nome: "Festa" }, payloadHash: "a".repeat(64), expiraEm: "2026-09-28T15:10:00.000Z",
  criadoEm: "2026-09-28T15:00:00.000Z", atualizadoEm: "2026-09-28T15:00:00.000Z", resultado: null,
};

test("Human Gate em PostgreSQL: leitura por empresa E usuário; atualização é compare-and-set por versão e estado", async () => {
  const { tx, consultas } = executor((sql) => (sql.startsWith("UPDATE") ? { rows: [], rowCount: 0 } : []));
  assert.equal(await repositorioOperacoesPostgres.buscar(tx, { operacaoId: draft.operacaoId, empresaId: draft.empresaId, usuarioId: draft.usuarioId }, true), null);
  assert.match(consultas[0].sql, /WHERE id = \$1::uuid AND empresa_id = \$2::uuid AND usuario_id = \$3::uuid FOR UPDATE/);
  assert.deepEqual(consultas[0].values, [draft.operacaoId, draft.empresaId, draft.usuarioId]);
  const ok = await repositorioOperacoesPostgres.atualizar(tx, { ...draft, estado: "EXECUTADA", resultado: { ok: true } }, { versao: 3, estado: "AGUARDANDO_CONFIRMACAO" });
  assert.equal(ok, false, "outra transação já mudou a linha");
  assert.match(consultas[1].sql, /AND versao = \$4 AND estado = \$12/);
  assert.deepEqual([consultas[1].values[3], consultas[1].values[11]], [3, "AGUARDANDO_CONFIRMACAO"]);
});
