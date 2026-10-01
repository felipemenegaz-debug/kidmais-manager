import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { buscarPacoteAtivoPorCodigo, buscarPacoteVigenteDaEmpresaPorCodigo } from "./repositories/comercial.repository.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";

/**
 * Busca de pacote do Fechamento administrativo pela empresa COMPROVADA, no PostgreSQL descartável (só com opt-in, pelo
 * `check:v1:postgres`). Tudo numa transação que termina em ROLLBACK. Duas empresas com o MESMO código: cada uma só vê o
 * próprio pacote vigente e ativo; inativo, não vigente ou arquivado não é encontrado; o catálogo público segue recusado.
 */
const sufixo = () => randomBytes(4).toString("hex");
/** Código de empresa: minúsculo (empresas_codigo_ck); código de pacote: maiúsculo, como no catálogo. */
const codEmpresa = (p: string) => `${p}${sufixo()}`;
const codPacote = (p: string) => `${p}${sufixo()}`.toUpperCase();

test("pacote do Fechamento pela empresa comprovada: isolamento por empresa e estados do pacote", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const db = await conectarDescartavel() as unknown as Client;
  const tx: DbExecutor = { query: async (sql, values) => { const r = await db.query(sql, values as unknown[]); return { rows: r.rows, rowCount: r.rowCount }; } } as DbExecutor;
  try {
    await db.query("BEGIN");
    const empresa = async (nome: string) => {
      const id = (await db.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [codEmpresa("pe"), nome])).rows[0].id;
      await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
      return id;
    };
    const A = await empresa("Empresa pacote A");
    const B = await empresa("Empresa pacote B");
    const codigo = codPacote("PREM");
    const pacote = async (empresaId: string, nome: string, ativo = true, vigente = true) => (await db.query<{ id: string }>(
      `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
       VALUES ($1::uuid, $2, $3, 1, $4, $5, 20, 100) RETURNING id`, [empresaId, codigo, nome, ativo, vigente])).rows[0].id;
    const deA = await pacote(A, "Premium A");
    const deB = await pacote(B, "Premium B");
    assert.equal((await buscarPacoteVigenteDaEmpresaPorCodigo(A, codigo, tx))?.id, deA);
    assert.equal((await buscarPacoteVigenteDaEmpresaPorCodigo(B, codigo, tx))?.id, deB);
    assert.equal((await buscarPacoteVigenteDaEmpresaPorCodigo(A, codigo, tx))?.empresaId, A);

    await db.query(`UPDATE pacotes SET ativo = false WHERE id = $1::uuid`, [deA]);
    assert.equal(await buscarPacoteVigenteDaEmpresaPorCodigo(A, codigo, tx), null, "inativo");
    await db.query(`UPDATE pacotes SET ativo = true, arquivado_em = clock_timestamp() WHERE id = $1::uuid`, [deA]);
    assert.equal(await buscarPacoteVigenteDaEmpresaPorCodigo(A, codigo, tx), null, "arquivado");
    assert.equal((await buscarPacoteVigenteDaEmpresaPorCodigo(B, codigo, tx))?.id, deB, "a outra empresa não é afetada");

    await assert.rejects(buscarPacoteAtivoPorCodigo(codigo, tx), (e: { code?: string }) => e.code === "CATALOGO_PUBLICO_INDETERMINADO");
    await assert.rejects(buscarPacoteVigenteDaEmpresaPorCodigo("", codigo, tx), (e: { code?: string }) => e.code === "CATALOGO_PUBLICO_INDETERMINADO");
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await encerrarDescartavel(db as never);
  }
});
