import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { gravarFaixasPacote, lerFaixasPacote, pacotesComPrecoAConfirmar } from "./pacote-precos.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { buscarPrecoPacoteAplicavel } from "./repositories/comercial.repository.ts";

/**
 * 092 no PostgreSQL DESCARTÁVEL (modelo 089 + 092 aplicada aqui): preço por quantidades cheias (PONTO), conversão das
 * faixas antigas só na confirmação, cálculo da quantidade quebrada pela diferença até o próximo ponto, lacunas novas
 * na publicação (misturado, sem extremos, decrescente), isolamento entre empresas e rollback recusado com pontos.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");

let client: Client;
let tx: DbExecutor;
const sufixo = randomBytes(3).toString("hex");
const ctx = (empresaId: string) => ({ empresaId, usuarioId: randomUUID(), requestId: randomUUID(), motivo: "PACOTE_EDITADO" });
const limites = { minimo: 50, maximo: 100 };

async function empresa(nome: string) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`,
    [`e92${nome}${sufixo}`.toLowerCase(), `Empresa 092 ${nome}`],
  );
  return r.rows[0].id;
}

async function pacote(empresaId: string, codigo: string) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
     VALUES ($1::uuid, $2, $3, 920, true, true, 50, 100) RETURNING id::text AS id`,
    [empresaId, codigo, `Pacote ${codigo}`],
  );
  return r.rows[0].id;
}

async function corrente(empresaId: string) {
  const r = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM tabelas_preco
      WHERE empresa_id = $1::uuid AND publicada_em IS NOT NULL AND substituida_em IS NULL
        AND vigencia_inicio <= CURRENT_DATE AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)`,
    [empresaId],
  );
  assert.equal(r.rows.length, 1, "uma tabela corrente");
  return r.rows[0].id;
}

async function emTransacao<T>(trabalho: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const r = await trabalho();
    await client.query("COMMIT");
    return r;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

/** Tabela não publicada só para ler as lacunas da 047/092 sobre um conjunto de pontos. */
async function lacunasDePontos(empresaId: string, pacoteId: string, linhas: Array<[number, string, string?]>) {
  await client.query("BEGIN");
  try {
    const t = await client.query<{ id: string }>(
      `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, ativa)
       VALUES ($1::uuid, $2, 'Lacunas 092', CURRENT_DATE, false) RETURNING id::text AS id`,
      [empresaId, `L92_${randomBytes(4).toString("hex")}`.toUpperCase()],
    );
    const tabela = t.rows[0].id;
    const e = await client.query<{ id: string }>(
      `INSERT INTO tabela_preco_escopos (tabela_preco_id, pacote_id, categoria_horario, cobertura_continua)
       VALUES ($1::uuid, $2::uuid, 'GERAL', false) RETURNING id::text AS id`,
      [tabela, pacoteId],
    );
    for (const [q, valor, tipo] of linhas) {
      const max = tipo === "FIXO" ? q + 4 : q;
      await client.query(
        `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'GERAL')`,
        [tabela, pacoteId, q, max, tipo ?? "PONTO", valor],
      );
      await client.query(
        `INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1::uuid, $2, $3)`,
        [e.rows[0].id, q, max],
      );
    }
    const r = await client.query<{ codigo: string }>(`SELECT codigo FROM kidmais_047_lacunas_escopo($1::uuid)`, [tabela]);
    return r.rows.map((l) => l.codigo);
  } finally {
    await client.query("ROLLBACK");
  }
}

let A: string;
let B: string;
let pacoteA: string;
let pacoteB: string;

test.before(async () => {
  client = await conectarDescartavel();
  tx = {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      const r = await client.query(text, values as unknown[]);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  };
});

test.after(async () => {
  if (client) await encerrarDescartavel(client);
});

test("fixtures antes da 092: pacotes com faixas FIXO publicadas", async () => {
  A = await empresa("A");
  B = await empresa("B");
  pacoteA = await pacote(A, `P92A${sufixo}`.toUpperCase());
  pacoteB = await pacote(B, `P92B${sufixo}`.toUpperCase());
  const faixas = [
    { convidadosMin: 50, convidadosMax: 59, valor: "4500.00" },
    { convidadosMin: 60, convidadosMax: 89, valor: "4900.00" },
    { convidadosMin: 90, convidadosMax: 100, valor: "6100.00" },
  ];
  await emTransacao(() => gravarFaixasPacote(tx, A, pacoteA, faixas, limites, ctx(A)));
  await emTransacao(() => gravarFaixasPacote(tx, B, pacoteB, faixas, limites, ctx(B)));
  // Sem a 092, PONTO é barrado pela CHECK antiga.
  await recusa(
    emTransacao(() => gravarFaixasPacote(tx, A, pacoteA, { pontos: [{ convidados: 50, valor: "4500" }, { convidados: 100, valor: "6500" }] }, limites, ctx(A))),
    /tipo_calculo_check|violates check constraint/,
  );
});

test("092: precheck, migration e postcheck; segunda aplicação é recusada", async () => {
  await client.query(arquivo("database/checks/20261022_092_precheck.sql"));
  await client.query(arquivo("database/migrations/20261022_092_precos_por_quantidade.sql"));
  await client.query(arquivo("database/checks/20261022_092_postcheck.sql"));
  await recusa(client.query(arquivo("database/migrations/20261022_092_precos_por_quantidade.sql")), /092: precheck falhou/);
  await client.query("ROLLBACK").catch(() => undefined);
});

test("faixas antigas continuam cobrando e ficam a confirmar, com proposta", async () => {
  const tabela = await corrente(A);
  const leitura = await lerFaixasPacote(tx, A, pacoteA, limites);
  assert.equal(leitura.aConfirmar, true);
  assert.deepEqual(leitura.proposta?.map((p) => [p.convidados, p.valor]), [[50, "4500.00"], [60, "4900.00"], [90, "6100.00"], [100, "6100.00"]]);
  assert.equal((await pacotesComPrecoAConfirmar(tx, A)).has(pacoteA), true);
  const preco = await buscarPrecoPacoteAplicavel({ tabelaPrecoId: tabela, pacoteId: pacoteA, categoriaHorario: "PADRAO", convidados: 53 }, tx);
  assert.equal(preco?.tipoCalculo, "FIXO");
  assert.equal(preco?.valor, 4500, "até confirmar, 53 paga a faixa 50–59");
});

test("confirmar a conversão grava pontos e a quantidade quebrada é calculada", async () => {
  await emTransacao(() => gravarFaixasPacote(tx, A, pacoteA, {
    pontos: [
      { convidados: 50, valor: "4500" }, { convidados: 60, valor: "4900" }, { convidados: 70, valor: "5300" },
      { convidados: 90, valor: "6100" }, { convidados: 100, valor: "6500" },
    ],
    conversao: true,
  }, limites, ctx(A)));
  const tabela = await corrente(A);
  const linhas = await client.query<{ tipo_calculo: string; convidados_min: number; convidados_max: number }>(
    `SELECT tipo_calculo, convidados_min, convidados_max FROM precos_pacote WHERE tabela_preco_id = $1::uuid AND pacote_id = $2::uuid ORDER BY convidados_min`,
    [tabela, pacoteA],
  );
  assert.deepEqual(linhas.rows.map((l) => [l.tipo_calculo, l.convidados_min, l.convidados_max]), [
    ["PONTO", 50, 50], ["PONTO", 60, 60], ["PONTO", 70, 70], ["PONTO", 90, 90], ["PONTO", 100, 100],
  ]);
  const auditoria = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auditoria WHERE acao = 'PRECO_PACOTE_CONVERTIDO' AND entidade_id = $1::uuid`, [tabela],
  );
  assert.equal(auditoria.rows[0].n, 1);
  const preco = async (convidados: number, categoriaHorario: "PADRAO" | "NOBRE" = "PADRAO") =>
    buscarPrecoPacoteAplicavel({ tabelaPrecoId: tabela, pacoteId: pacoteA, categoriaHorario, convidados }, tx);
  assert.equal((await preco(53))?.valor, 4620);
  assert.equal((await preco(53))?.tipoCalculo, "PONTO");
  assert.deepEqual([(await preco(53))?.convidadosMin, (await preco(53))?.convidadosMax], [50, 60]);
  assert.equal((await preco(60))?.valor, 4900);
  assert.equal((await preco(75, "NOBRE"))?.valor, 5500, "70→90 em 20: 5300 + 5 × 40");
  assert.equal((await preco(100))?.valor, 6500);
  assert.equal(await preco(101), null);
  const leitura = await lerFaixasPacote(tx, A, pacoteA, limites);
  assert.equal(leitura.aConfirmar, false);
  assert.equal(leitura.pontos.length, 5);
  assert.equal((await pacotesComPrecoAConfirmar(tx, A)).has(pacoteA), false);
  // A empresa B não foi tocada.
  assert.equal((await lerFaixasPacote(tx, B, pacoteB, limites)).aConfirmar, true);
});

test("a publicação recusa pontos misturados, sem extremos ou decrescentes; a CHECK exige mínimo = máximo", async () => {
  assert.deepEqual(await lacunasDePontos(A, pacoteA, [[50, "10"], [100, "20"]]), []);
  assert.ok((await lacunasDePontos(A, pacoteA, [[50, "10"], [60, "9"], [100, "20"]])).includes("PONTO_DECRESCENTE"));
  assert.ok((await lacunasDePontos(A, pacoteA, [[60, "10"], [100, "20"]])).includes("PONTO_SEM_EXTREMOS"));
  assert.ok((await lacunasDePontos(A, pacoteA, [[50, "10"], [60, "12", "FIXO"], [100, "20"]])).includes("PONTO_MISTURADO"));
  await client.query("BEGIN");
  try {
    const t = await client.query<{ id: string }>(
      `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, ativa)
       VALUES ($1::uuid, $2, 'Check 092', CURRENT_DATE, false) RETURNING id::text AS id`,
      [A, `C92_${randomBytes(4).toString("hex")}`.toUpperCase()],
    );
    await recusa(client.query(
      `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario)
       VALUES ($1::uuid, $2::uuid, 50, 60, 'PONTO', 10, 'GERAL')`,
      [t.rows[0].id, pacoteA],
    ), /precos_pacote_092_ponto_check/);
  } finally {
    await client.query("ROLLBACK");
  }
});

test("o servidor recusa preço menor que o anterior sem gravar nada", async () => {
  const antes = await corrente(A);
  await recusa(
    emTransacao(() => gravarFaixasPacote(tx, A, pacoteA, { pontos: [{ convidados: 50, valor: "4500" }, { convidados: 100, valor: "4000" }] }, limites, ctx(A))),
    /igual ou maior/,
  );
  assert.equal(await corrente(A), antes);
});

test("rollback da 092 recusado enquanto houver pontos", async () => {
  await recusa(client.query(arquivo("database/rollback/20261022_092_precos_por_quantidade_down.sql")), /092 rollback: há preços/);
  await client.query("ROLLBACK").catch(() => undefined);
});
