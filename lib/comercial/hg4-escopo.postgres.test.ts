import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita, portaDescartavel, linhaDeBase, LINHA_DE_BASE_ATUAL } from "./postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration047 = resolve(root, "database/migrations/20260926_047_escopo_comercial_tabela.sql");
const precheck047 = resolve(root, "database/checks/20260926_047_precheck.sql");
const postcheck047 = resolve(root, "database/checks/20260926_047_postcheck.sql");
const down047 = resolve(root, "database/rollback/20260926_047_escopo_comercial_tabela_down.sql");

function texto(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codigo(prefixo: string) {
  return `${prefixo}${randomBytes(4).toString("hex")}`;
}

async function recusa(client: Client, sql: string, params: unknown[], trecho: string) {
  await client.query("SAVEPOINT prova");
  let message = "";
  try {
    await client.query(sql, params);
    message = "passou";
  } catch (error) {
    message = texto(error);
  }
  await client.query("ROLLBACK TO SAVEPOINT prova");
  assert.equal(message.includes(trecho), true, message);
}

test("escopo comercial declarado no postgres descartável", { timeout: 120_000 }, async (t) => {
  const fonte = readFileSync(migration047, "utf8");
  assert.equal(/INSERT INTO tabela_preco_escopos|ESSENCIAL|COMPLETA|PREMIUM|PIZZA_PARTY/.test(fonte), false);
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());
    // D3: produto parte do estado canônico ATUAL restaurado pela receita (046 aplicada: legado atribuído à Kidmais).
    assert.deepEqual(await linhaDeBase(db), LINHA_DE_BASE_ATUAL, "estado canônico atual");

    const antes = await db.query<{ precos: number; publicadas: number; sem_empresa: number }>(
      `SELECT
         (SELECT count(*)::int FROM precos_pacote pp JOIN tabelas_preco t ON t.id = pp.tabela_preco_id WHERE t.codigo LIKE 'COMERCIAL_%') AS precos,
         (SELECT count(*)::int FROM tabelas_preco WHERE codigo LIKE 'COMERCIAL_%' AND publicada_em IS NOT NULL) AS publicadas,
         (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS sem_empresa`,
    );
    assert.equal(antes.rows[0].publicadas, 0);
    assert.equal(antes.rows[0].sem_empresa, LINHA_DE_BASE_ATUAL.legado);

    const ja = await db.query<{ ok: boolean }>(
      "SELECT to_regclass('public.tabela_preco_escopos') IS NOT NULL AS ok",
    );
    if (!ja.rows[0].ok) {
      await db.query(readFileSync(precheck047, "utf8"));
      await db.query(readFileSync(migration047, "utf8"));
      await db.query(readFileSync(postcheck047, "utf8"));
      const vazio = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM tabela_preco_escopos");
      assert.equal(vazio.rows[0].n, 0);
    }

    await t.test("legado comercial não ganha escopo inferido", async () => {
      const legado = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM tabela_preco_escopos e
           JOIN tabelas_preco t ON t.id = e.tabela_preco_id
          WHERE t.codigo LIKE 'COMERCIAL_%'`,
      );
      assert.equal(legado.rows[0].n, 0);
    });

    await t.test("publicar segue o escopo declarado e não o catálogo inteiro", async () => {
      await db.query("BEGIN");
      try {
        const empresa = await db.query<{ id: string }>(
          `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa HG-4', 'PROVISIONAMENTO') RETURNING id`,
          [codigo("h4")],
        );
        const empresaId = empresa.rows[0].id;
        async function pacote(ordem: number) {
          const criado = await db.query<{ id: string }>(
            `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
             VALUES ($1::uuid, $2, 'Pacote HG-4', $3, true, true) RETURNING id`,
            [empresaId, codigo("p"), ordem],
          );
          return criado.rows[0].id;
        }
        const incluso = await pacote(410);
        const omitido = await pacote(411);
        const tabela = await db.query<{ id: string }>(
          `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
           VALUES ($1::uuid, $2, 'Tabela HG-4', DATE '2099-01-01', DATE '2099-06-30', false) RETURNING id`,
          [empresaId, codigo("u")],
        );
        const tabelaId = tabela.rows[0].id;
        async function preco(pacoteId: string, categoria: string, minimo: number, maximo: number) {
          await db.query(
            `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario)
             VALUES ($1::uuid, $2::uuid, $3, $4, 'FIXO', 10, $5)`,
            [tabelaId, pacoteId, minimo, maximo, categoria],
          );
        }
        await preco(incluso, "PADRAO", 20, 40);
        await recusa(
          db,
          `UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`,
          [tabelaId],
          "ESCOPO_AUSENTE",
        );
        const escopo = await db.query<{ id: string }>(
          `INSERT INTO tabela_preco_escopos (tabela_preco_id, pacote_id, categoria_horario, cobertura_continua)
           VALUES ($1::uuid, $2::uuid, 'PADRAO', false) RETURNING id`,
          [tabelaId, incluso],
        );
        await db.query(
          `INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1::uuid, 20, 40)`,
          [escopo.rows[0].id],
        );
        await db.query(`UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`, [tabelaId]);
        const publicada = await db.query<{ ok: boolean }>(
          "SELECT publicada_em IS NOT NULL AS ok FROM tabelas_preco WHERE id = $1::uuid",
          [tabelaId],
        );
        assert.equal(publicada.rows[0].ok, true);
        const fora = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM precos_pacote WHERE tabela_preco_id = $1::uuid AND pacote_id = $2::uuid",
          [tabelaId, omitido],
        );
        assert.equal(fora.rows[0].n, 0);
        await recusa(
          db,
          `INSERT INTO tabela_preco_escopos (tabela_preco_id, pacote_id, categoria_horario, cobertura_continua)
           VALUES ($1::uuid, $2::uuid, 'NOBRE', false)`,
          [tabelaId, incluso],
          "escopo de tabela publicada não muda",
        );
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("categoria não declarada não bloqueia e faixa contínua com buraco bloqueia", async () => {
      await db.query("BEGIN");
      try {
        const empresa = await db.query<{ id: string }>(
          `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa HG-4b', 'PROVISIONAMENTO') RETURNING id`,
          [codigo("h4")],
        );
        const empresaId = empresa.rows[0].id;
        const pacote = await db.query<{ id: string }>(
          `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
           VALUES ($1::uuid, $2, 'Pacote HG-4b', 412, true, true, 20, 80) RETURNING id`,
          [empresaId, codigo("p")],
        );
        const pacoteId = pacote.rows[0].id;
        const tabela = await db.query<{ id: string }>(
          `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, ativa)
           VALUES ($1::uuid, $2, 'Tabela HG-4b', DATE '2098-01-01', false) RETURNING id`,
          [empresaId, codigo("u")],
        );
        const tabelaId = tabela.rows[0].id;
        async function preco(minimo: number, maximo: number) {
          await db.query(
            `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario)
             VALUES ($1::uuid, $2::uuid, $3, $4, 'FIXO', 12, 'PADRAO')`,
            [tabelaId, pacoteId, minimo, maximo],
          );
        }
        await preco(20, 40);
        await preco(50, 80);
        const escopo = await db.query<{ id: string }>(
          `INSERT INTO tabela_preco_escopos (
             tabela_preco_id, pacote_id, categoria_horario, cobertura_continua, limite_convidados_min, limite_convidados_max
           ) VALUES ($1::uuid, $2::uuid, 'PADRAO', true, 20, 80) RETURNING id`,
          [tabelaId, pacoteId],
        );
        const escopoId = escopo.rows[0].id;
        await db.query(
          `INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1::uuid, 20, 40), ($1::uuid, 50, 80)`,
          [escopoId],
        );
        const buraco = await db.query<{ codigo: string }>(
          "SELECT codigo FROM kidmais_047_lacunas_escopo($1::uuid)",
          [tabelaId],
        );
        assert.equal(buraco.rows.some((linha) => linha.codigo === "FAIXA_COM_BURACO"), true);
        await recusa(db, `UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`, [tabelaId], "FAIXA_COM_BURACO");
        await db.query("UPDATE tabela_preco_escopos SET cobertura_continua = false WHERE id = $1::uuid", [escopoId]);
        const discreta = await db.query<{ codigo: string }>(
          "SELECT codigo FROM kidmais_047_lacunas_escopo($1::uuid)",
          [tabelaId],
        );
        assert.equal(discreta.rows.some((linha) => linha.codigo === "FAIXA_COM_BURACO"), false);
        await db.query(`UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`, [tabelaId]);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("preço fora do escopo, limite estourado e faixa sem preço bloqueiam", async () => {
      await db.query("BEGIN");
      try {
        const empresa = await db.query<{ id: string }>(
          `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa HG-4c', 'PROVISIONAMENTO') RETURNING id`,
          [codigo("h4")],
        );
        const empresaId = empresa.rows[0].id;
        const pacote = await db.query<{ id: string }>(
          `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
           VALUES ($1::uuid, $2, 'Pacote HG-4c', 413, true, true) RETURNING id`,
          [empresaId, codigo("p")],
        );
        const pacoteId = pacote.rows[0].id;
        const tabela = await db.query<{ id: string }>(
          `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, ativa)
           VALUES ($1::uuid, $2, 'Tabela HG-4c', DATE '2097-01-01', false) RETURNING id`,
          [empresaId, codigo("u")],
        );
        const tabelaId = tabela.rows[0].id;
        await db.query(
          `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario)
           VALUES ($1::uuid, $2::uuid, 10, 20, 'FIXO', 10, 'GERAL')`,
          [tabelaId, pacoteId],
        );
        const escopo = await db.query<{ id: string }>(
          `INSERT INTO tabela_preco_escopos (tabela_preco_id, pacote_id, categoria_horario, cobertura_continua, limite_convidados_min)
           VALUES ($1::uuid, $2::uuid, 'GERAL', false, 15) RETURNING id`,
          [tabelaId, pacoteId],
        );
        await db.query(
          `INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1::uuid, 10, 20)`,
          [escopo.rows[0].id],
        );
        const limite = await db.query<{ codigo: string }>("SELECT codigo FROM kidmais_047_lacunas_escopo($1::uuid)", [tabelaId]);
        assert.equal(limite.rows.some((linha) => linha.codigo === "FAIXA_FORA_DO_LIMITE"), true);
        await db.query("DELETE FROM tabela_preco_escopo_faixas WHERE escopo_id = $1::uuid", [escopo.rows[0].id]);
        await db.query(
          `INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1::uuid, 30, 40)`,
          [escopo.rows[0].id],
        );
        const semPreco = await db.query<{ codigo: string }>("SELECT codigo FROM kidmais_047_lacunas_escopo($1::uuid)", [tabelaId]);
        assert.equal(semPreco.rows.some((linha) => linha.codigo === "FAIXA_SEM_PRECO"), true);
        assert.equal(semPreco.rows.some((linha) => linha.codigo === "PRECO_FORA_DO_ESCOPO"), true);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("o rollback recusa apagar escopo e, vazio, devolve a guarda anterior só até o fim da transação", async () => {
      await db.query("BEGIN");
      try {
        const empresa = await db.query<{ id: string }>(
          `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa HG-4d', 'PROVISIONAMENTO') RETURNING id`,
          [codigo("h4")],
        );
        const pacote = await db.query<{ id: string }>(
          `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
           VALUES ($1::uuid, $2, 'Pacote HG-4d', 414, true, true) RETURNING id`,
          [empresa.rows[0].id, codigo("p")],
        );
        const tabela = await db.query<{ id: string }>(
          `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, ativa)
           VALUES ($1::uuid, $2, 'Tabela HG-4d', DATE '2096-01-01', false) RETURNING id`,
          [empresa.rows[0].id, codigo("u")],
        );
        await db.query(
          `INSERT INTO tabela_preco_escopos (tabela_preco_id, pacote_id, categoria_horario, cobertura_continua)
           VALUES ($1::uuid, $2::uuid, 'PADRAO', false)`,
          [tabela.rows[0].id, pacote.rows[0].id],
        );
        let message = "";
        try {
          await db.query(semTransacaoExplicita(readFileSync(down047, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /047 down: já existe escopo declarado/);
      } finally {
        await db.query("ROLLBACK");
      }

      const ocupado = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM tabela_preco_escopos");
      if (ocupado.rows[0].n === 0) {
        await db.query("BEGIN");
        try {
          await db.query(semTransacaoExplicita(readFileSync(down047, "utf8")));
          const empresa = await db.query<{ id: string }>(
            `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa HG-4e', 'PROVISIONAMENTO') RETURNING id`,
            [codigo("h4")],
          );
          const pacote = await db.query<{ id: string }>(
            `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
             VALUES ($1::uuid, $2, 'Pacote HG-4e', 415, true, true) RETURNING id`,
            [empresa.rows[0].id, codigo("p")],
          );
          const tabela = await db.query<{ id: string }>(
            `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, ativa)
             VALUES ($1::uuid, $2, 'Tabela HG-4e', DATE '2095-01-01', false) RETURNING id`,
            [empresa.rows[0].id, codigo("u")],
          );
          await recusa(
            db,
            `UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`,
            [tabela.rows[0].id],
            "tabela vazia",
          );
          await db.query(
            `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario)
             VALUES ($1::uuid, $2::uuid, 20, 30, 'FIXO', 10, 'PADRAO')`,
            [tabela.rows[0].id, pacote.rows[0].id],
          );
          await db.query(`UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`, [tabela.rows[0].id]);
        } finally {
          await db.query("ROLLBACK");
        }
      }
      const guarda = await db.query<{ ok: boolean }>(
        "SELECT pg_get_functiondef('kidmais_035_preservar_tabela_publicada()'::regprocedure) LIKE '%kidmais_047_lacunas_escopo%' AS ok",
      );
      assert.equal(guarda.rows[0].ok, true);
    });

    const depois = await db.query<{ precos: number; publicadas: number; sem_empresa: number }>(
      `SELECT
         (SELECT count(*)::int FROM precos_pacote pp JOIN tabelas_preco t ON t.id = pp.tabela_preco_id WHERE t.codigo LIKE 'COMERCIAL_%') AS precos,
         (SELECT count(*)::int FROM tabelas_preco WHERE codigo LIKE 'COMERCIAL_%' AND publicada_em IS NOT NULL) AS publicadas,
         (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS sem_empresa`,
    );
    assert.deepEqual(depois.rows[0], antes.rows[0]);
  } finally {
    await encerrarDescartavel(client);
  }
});
