import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { fonteParametrosDisponivel, parametroVigente, registrarParametroConsumo } from "./parametros-consumo.ts";

/**
 * Migration 059 (parâmetros de consumo) no PostgreSQL descartável — só pelo `check:v1:postgres`, com opt-in.
 * Tudo numa transação que termina em ROLLBACK, com os scripts REAIS (up, postcheck, rollback precheck, down,
 * verificação pós-rollback): categoria coerente, uma versão vigente, imutabilidade, DELETE/TRUNCATE recusados,
 * isolamento por empresa, versão esperada e idempotência pela operação do Human Gate, pelo serviço de domínio real.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20261001_059_operacional_parametros_consumo.sql");
const POST = ler("database/checks/20261001_059_postcheck.sql");
const DOWN = ler("database/rollback/20261001_059_operacional_parametros_consumo_down.sql");
const PRE_DOWN = ler("database/checks/20261001_059_rollback_precheck.sql");
const POS_DOWN = ler("database/checks/20261001_059_rollback_postcheck.sql");
const cod = (p: string) => `${p}${randomBytes(4).toString("hex")}`;

async function recusa(db: Client, sql: string, valores: unknown[], motivo: RegExp) {
  await db.query("SAVEPOINT recusa");
  await assert.rejects(db.query(sql, valores), motivo);
  await db.query("ROLLBACK TO SAVEPOINT recusa");
}

test("059: parâmetros de consumo — versão vigente única, imutável, por empresa, idempotente, com rollback", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const db = await conectarDescartavel();
  const tx = db as unknown as DbExecutor;
  const id = async (sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
  try {
    await db.query("BEGIN");
    assert.equal(await fonteParametrosDisponivel(tx), false, "descartável começa sem a 059");
    await db.query(semTransacaoExplicita(UP));
    await db.query(POST);
    assert.equal(await fonteParametrosDisponivel(tx), true);

    const empresa = async (nome: string) => {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("op"), nome]);
      await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      return e;
    };
    const A = await empresa("Empresa consumo A");
    const B = await empresa("Empresa consumo B");
    const autor = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness 059', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
      [`${cod("u")}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);

    const base = { usuarioId: autor, porConvidado: 4, mlPorConvidado: null, embalagemMl: null, margemPercentual: null } as const;
    const op1 = randomUUID();
    assert.deepEqual(await registrarParametroConsumo(tx, { ...base, empresaId: A, categoria: "DOCES", versaoEsperada: null, operacaoId: op1 }), { versao: 1, repetido: false });
    assert.deepEqual(await registrarParametroConsumo(tx, { ...base, empresaId: A, categoria: "DOCES", versaoEsperada: null, operacaoId: op1 }), { versao: 1, repetido: true }, "mesma operação não duplica");
    await db.query("SAVEPOINT divergente");
    await assert.rejects(registrarParametroConsumo(tx, { ...base, empresaId: A, categoria: "DOCES", versaoEsperada: null, operacaoId: randomUUID() }), /mudou desde a revisão/);
    await db.query("ROLLBACK TO SAVEPOINT divergente");
    assert.deepEqual(await registrarParametroConsumo(tx, { ...base, porConvidado: 5, empresaId: A, categoria: "DOCES", versaoEsperada: 1, operacaoId: randomUUID() }), { versao: 2, repetido: false });
    assert.equal((await parametroVigente(tx, A, "DOCES"))?.porConvidado, 5);
    assert.equal(await parametroVigente(tx, B, "DOCES"), null, "outra empresa não vê");
    assert.deepEqual(await registrarParametroConsumo(tx, { usuarioId: autor, empresaId: A, categoria: "REFRIGERANTES", porConvidado: null, mlPorConvidado: 400, embalagemMl: 2000, margemPercentual: 10, versaoEsperada: null, operacaoId: randomUUID() }), { versao: 1, repetido: false });

    // Banco garante o que o serviço garante.
    await recusa(db, `INSERT INTO operacional_parametros_consumo (empresa_id, categoria, versao, quantidade_por_convidado, arredondamento, origem, criado_por) VALUES ($1::uuid, 'DOCES', 9, 4, 'UNIDADE_INTEIRA', 'TELA', $2::uuid)`, [A, autor], /operacional_059_uma_vigente_uk/);
    await recusa(db, `INSERT INTO operacional_parametros_consumo (empresa_id, categoria, versao, ml_por_convidado, arredondamento, origem, criado_por) VALUES ($1::uuid, 'DOCES', 1, 400, 'UNIDADE_INTEIRA', 'TELA', $2::uuid)`, [B, autor], /operacional_059_categoria_check/);
    await recusa(db, `UPDATE operacional_parametros_consumo SET quantidade_por_convidado = 9 WHERE empresa_id = $1::uuid AND categoria = 'DOCES' AND versao = 2`, [A], /imutável/);
    await recusa(db, `UPDATE operacional_parametros_consumo SET substituida_em = NULL WHERE empresa_id = $1::uuid AND versao = 1 AND categoria = 'DOCES'`, [A], /já substituída/);
    await recusa(db, `DELETE FROM operacional_parametros_consumo WHERE empresa_id = $1::uuid`, [A], /exclusão de parâmetro recusada/);
    await recusa(db, `TRUNCATE operacional_parametros_consumo`, [], /TRUNCATE/);

    await db.query(PRE_DOWN);
    await recusa(db, semTransacaoExplicita(DOWN), [], /Rollback da 059 recusado/);
    await db.query(`SET LOCAL kidmais.rollback_059_descartar_parametros = 'sim'`);
    // O down tem trigger de TRUNCATE só na tabela; DROP TABLE não dispara os gatilhos de linha.
    await db.query(semTransacaoExplicita(DOWN));
    await db.query(POS_DOWN);
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await encerrarDescartavel(db);
  }
});
