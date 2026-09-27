import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { gravarFaixasPacote } from "./pacote-precos.ts";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "./postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration048 = resolve(root, "database/migrations/20260927_048_supersessao_tabela_publicada.sql");
const precheck048 = resolve(root, "database/checks/20260927_048_precheck.sql");
const postcheck048 = resolve(root, "database/checks/20260927_048_postcheck.sql");
const down048 = resolve(root, "database/rollback/20260927_048_supersessao_tabela_publicada_down.sql");

function texto(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codigo(prefixo: string) {
  return `${prefixo}${randomBytes(4).toString("hex")}`;
}

function executor(db: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      const result = await db.query(text, values as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
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

async function empresa(db: Client, nome: string) {
  const criada = await db.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`,
    [codigo("e48"), nome],
  );
  return criada.rows[0].id;
}

async function pacote(db: Client, empresaId: string) {
  const criado = await db.query<{ id: string }>(
    `INSERT INTO pacotes (
       empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos
     ) VALUES ($1::uuid, $2, 'Pacote 048', 480, true, true, 20, 30) RETURNING id`,
    [empresaId, codigo("p48")],
  );
  return criado.rows[0].id;
}

async function tabela(db: Client, empresaId: string, inicio: string, fim: string | null) {
  const criada = await db.query<{ id: string; codigo: string }>(
    `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
     VALUES ($1::uuid, $2, 'Tabela 048', $3::date, $4::date, false)
     RETURNING id, codigo`,
    [empresaId, codigo("u48"), inicio, fim],
  );
  return criada.rows[0];
}

async function preco(db: Client, tabelaId: string, pacoteId: string, valor: string) {
  const criado = await db.query<{ id: string }>(
    `INSERT INTO precos_pacote (
       tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario
     ) VALUES ($1::uuid, $2::uuid, 20, 30, 'FIXO', $3, 'GERAL') RETURNING id`,
    [tabelaId, pacoteId, valor],
  );
  return criado.rows[0].id;
}

async function escopo(db: Client, tabelaId: string, pacoteId: string) {
  const criado = await db.query<{ id: string }>(
    `INSERT INTO tabela_preco_escopos (
       tabela_preco_id, pacote_id, categoria_horario, cobertura_continua
     ) VALUES ($1::uuid, $2::uuid, 'GERAL', true) RETURNING id`,
    [tabelaId, pacoteId],
  );
  await db.query(
    `INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max) VALUES ($1::uuid, 20, 30)`,
    [criado.rows[0].id],
  );
}

async function publicar(db: Client, tabelaId: string) {
  await db.query(`UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`, [tabelaId]);
}

async function correntes(db: Client, empresaId: string) {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM tabelas_preco
      WHERE empresa_id = $1::uuid
        AND publicada_em IS NOT NULL
        AND substituida_em IS NULL
        AND vigencia_inicio <= CURRENT_DATE
        AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)`,
    [empresaId],
  );
  return result.rows[0].n;
}

test("supersessão 048 no postgres descartável", { timeout: 180_000 }, async (t) => {
  const fonte = readFileSync(migration048, "utf8");
  assert.equal(fonte.includes("CURRENT_DATE - 1"), false);
  assert.equal(/UPDATE tabelas_preco[\s\S]*vigencia_fim/.test(fonte), false);
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), 55498);
    assert.equal(process.env.KIDMAIS_POSTGRES_DESCARTAVEL, "kidmais_pacotes_v1_descartavel");
    assert.equal(process.env.DATABASE_URL, undefined);

    const antes = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tabelas_preco WHERE publicada_em IS NOT NULL",
    );
    const ja = await db.query<{ ok: boolean }>(
      "SELECT to_regprocedure('public.kidmais_048_recusar_ciclo(uuid,uuid)') IS NOT NULL AS ok",
    );
    if (!ja.rows[0].ok) {
      await db.query(readFileSync(precheck048, "utf8"));
      await db.query(readFileSync(migration048, "utf8"));
      await db.query(readFileSync(postcheck048, "utf8"));
      const depois = await db.query<{ n: number; substituidas: number }>(
        `SELECT
           (SELECT count(*)::int FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS n,
           (SELECT count(*)::int FROM tabelas_preco WHERE substituida_em IS NOT NULL) AS substituidas`,
      );
      assert.equal(depois.rows[0].n, antes.rows[0].n);
      assert.equal(depois.rows[0].substituidas, 0);
    }
    const estrutura = await db.query<{ ok: boolean }>(
      `SELECT (
         to_regprocedure('public.kidmais_048_recusar_ciclo(uuid,uuid)') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM pg_trigger
            WHERE tgname = 'tabelas_preco_supersessao_fim_trg'
              AND tgdeferrable AND tginitdeferred AND tgenabled <> 'D'
         )
         AND EXISTS (
           SELECT 1 FROM pg_proc
            WHERE proname = 'kidmais_035_preservar_tabela_publicada'
              AND pg_get_functiondef(oid) LIKE '%kidmais_047_lacunas_escopo%'
              AND pg_get_functiondef(oid) LIKE '%substituida_em IS NULL%'
         )
       ) AS ok`,
    );
    assert.equal(estrutura.rows[0].ok, true);

    await t.test("preço novo no mesmo dia e snapshot antigo intacto", async () => {
      const empresaId = await empresa(db, "Empresa 048 mesmo dia");
      const pacoteId = await pacote(db, empresaId);
      const atual = await tabela(db, empresaId, "2000-01-01", null);
      await db.query(
        `UPDATE tabelas_preco SET vigencia_inicio = CURRENT_DATE, vigencia_fim = NULL WHERE id = $1::uuid`,
        [atual.id],
      );
      const precoId = await preco(db, atual.id, pacoteId, "10000.00");
      await escopo(db, atual.id, pacoteId);
      await publicar(db, atual.id);
      const agenda = await db.query<{ id: string }>(
        "SELECT id FROM configuracao_agenda WHERE ativo ORDER BY codigo LIMIT 1",
      );
      const fechamento = await db.query<{ id: string }>(
        `INSERT INTO fechamentos (
           data_evento, horario_inicio, horario_fim, configuracao_agenda_id,
           pacote_id, tabela_preco_id, preco_pacote_id,
           categoria_horario, categoria_preco_aplicada,
           convidados, convidados_faturados,
           valor_pacote_base, desconto_percentual, valor_desconto_pacote, valor_pacote_aplicado,
           valor_adicionais, valor_tabela, status, origem_fechamento
         ) VALUES (
           CURRENT_DATE, TIME '10:00', TIME '14:00', $1::uuid,
           $2::uuid, $3::uuid, $4::uuid,
           'PADRAO', 'PADRAO', 20, 20,
           10000, 0, 0, 10000, 0, 10000, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS'
         ) RETURNING id`,
        [agenda.rows[0].id, pacoteId, atual.id, precoId],
      );
      const foto = await db.query<{ id: string }>(
        `INSERT INTO fechamento_pacote_snapshots (
           fechamento_id, sequencia, pacote_id, codigo_aplicado, nome_aplicado,
           tabela_preco_id, tabela_codigo_aplicado, tabela_nome_aplicado, preco_pacote_id,
           tipo_calculo, convidados_min_faixa, convidados_max_faixa, categoria_preco_linha,
           valor_linha, categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
           desconto_percentual, valor_pacote_base, valor_desconto_pacote, valor_pacote_aplicado,
           valor_adicionais, valor_tabela
         ) VALUES (
           $1::uuid, 1, $2::uuid, 'P048', 'Pacote 048',
           $3::uuid, $4, 'Tabela 048', $5::uuid,
           'FIXO', 20, 30, 'GERAL',
           10000, 'PADRAO', 'GERAL', 20, 20,
           0, 10000, 0, 10000, 0, 10000
         ) RETURNING id`,
        [fechamento.rows[0].id, pacoteId, atual.id, atual.codigo, precoId],
      );
      await db.query("BEGIN");
      try {
        await gravarFaixasPacote(executor(db), empresaId, pacoteId, [
          { convidadosMin: 20, convidadosMax: 30, valor: "11000.00" },
        ], { minimo: 20, maximo: 30 }, {
          empresaId,
          usuarioId: randomUUID(),
          requestId: randomUUID(),
          motivo: "PACOTE_EDITADO",
        });
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      const antigo = await db.query<{ valor: string; fim: string | null; substituida: boolean; publicada: boolean }>(
        `SELECT pp.valor::text AS valor,
                t.vigencia_fim::text AS fim,
                t.substituida_em IS NOT NULL AS substituida,
                t.publicada_em IS NOT NULL AS publicada
           FROM precos_pacote pp
           JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
          WHERE pp.id = $1::uuid`,
        [precoId],
      );
      assert.equal(antigo.rows[0].valor, "10000.00");
      assert.equal(antigo.rows[0].fim, null);
      assert.equal(antigo.rows[0].substituida, true);
      assert.equal(antigo.rows[0].publicada, true);
      const fotoValor = await db.query<{ valor: string }>(
        "SELECT valor_linha::text AS valor FROM fechamento_pacote_snapshots WHERE id = $1::uuid",
        [foto.rows[0].id],
      );
      assert.equal(fotoValor.rows[0].valor, "10000.00");
      const corrente = await db.query<{ valor: string; inicio: string; fim: string | null }>(
        `SELECT pp.valor::text AS valor, t.vigencia_inicio::text AS inicio, t.vigencia_fim::text AS fim
           FROM tabelas_preco t
           JOIN precos_pacote pp ON pp.tabela_preco_id = t.id AND pp.pacote_id = $2::uuid
          WHERE t.empresa_id = $1::uuid
            AND t.publicada_em IS NOT NULL
            AND t.substituida_em IS NULL
            AND t.vigencia_inicio <= CURRENT_DATE
            AND (t.vigencia_fim IS NULL OR t.vigencia_fim >= CURRENT_DATE)`,
        [empresaId, pacoteId],
      );
      assert.equal(corrente.rows.length, 1);
      assert.equal(corrente.rows[0].valor, "11000.00");
      assert.equal(corrente.rows[0].fim, null);
      assert.equal(await correntes(db, empresaId), 1);
      await db.query("BEGIN");
      try {
        await recusa(
          db,
          `UPDATE tabelas_preco SET substituida_em = NULL, substituida_por_id = NULL WHERE id = $1::uuid`,
          [atual.id],
          "supersessão não pode ser desfeita",
        );
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("duas alterações concorrentes deixam uma corrente", async () => {
      const empresaId = await empresa(db, "Empresa 048 concorrente");
      const pacoteId = await pacote(db, empresaId);
      const atual = await tabela(db, empresaId, "2000-01-01", null);
      await db.query(`UPDATE tabelas_preco SET vigencia_inicio = CURRENT_DATE WHERE id = $1::uuid`, [atual.id]);
      const precoId = await preco(db, atual.id, pacoteId, "10000.00");
      await escopo(db, atual.id, pacoteId);
      await publicar(db, atual.id);
      const outro = await conectarDescartavel({ travar: false });
      const b = outro as unknown as Client;
      try {
        await db.query("SET statement_timeout = '60s'");
        await b.query("SET statement_timeout = '60s'");
        await db.query("BEGIN");
        await gravarFaixasPacote(executor(db), empresaId, pacoteId, [
          { convidadosMin: 20, convidadosMax: 30, valor: "11000.00" },
        ], { minimo: 20, maximo: 30 }, {
          empresaId, usuarioId: randomUUID(), requestId: randomUUID(), motivo: "PACOTE_EDITADO",
        });
        const pendente = (async () => {
          await b.query("BEGIN");
          await gravarFaixasPacote(executor(b), empresaId, pacoteId, [
            { convidadosMin: 20, convidadosMax: 30, valor: "12000.00" },
          ], { minimo: 20, maximo: 30 }, {
            empresaId, usuarioId: randomUUID(), requestId: randomUUID(), motivo: "PACOTE_EDITADO",
          });
          await b.query("COMMIT");
        })();
        await new Promise((resolveEspera) => setTimeout(resolveEspera, 400));
        await db.query("COMMIT");
        await pendente;
      } finally {
        await encerrarDescartavel(outro, false);
      }
      const original = await db.query<{ valor: string }>(
        "SELECT valor::text AS valor FROM precos_pacote WHERE id = $1::uuid",
        [precoId],
      );
      assert.equal(original.rows[0].valor, "10000.00");
      assert.equal(await correntes(db, empresaId), 1);
      const vigente = await db.query<{ valor: string }>(
        `SELECT pp.valor::text AS valor
           FROM tabelas_preco t
           JOIN precos_pacote pp ON pp.tabela_preco_id = t.id AND pp.pacote_id = $2::uuid AND pp.ativo
          WHERE t.empresa_id = $1::uuid
            AND t.publicada_em IS NOT NULL
            AND t.substituida_em IS NULL`,
        [empresaId, pacoteId],
      );
      assert.equal(vigente.rows[0].valor, "12000.00");
    });

    await t.test("erro no meio desfaz a sucessora inteira", async () => {
      const empresaId = await empresa(db, "Empresa 048 rollback");
      const pacoteId = await pacote(db, empresaId);
      const atual = await tabela(db, empresaId, "2000-01-01", null);
      await db.query(`UPDATE tabelas_preco SET vigencia_inicio = CURRENT_DATE WHERE id = $1::uuid`, [atual.id]);
      const precoId = await preco(db, atual.id, pacoteId, "10000.00");
      await escopo(db, atual.id, pacoteId);
      await publicar(db, atual.id);
      const antesTabelas = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tabelas_preco WHERE empresa_id = $1::uuid",
        [empresaId],
      );
      await db.query("BEGIN");
      let falhou = false;
      try {
        await gravarFaixasPacote(executor(db), empresaId, pacoteId, [
          { convidadosMin: 20, convidadosMax: 80, valor: "11000.00" },
        ], { minimo: 20, maximo: 80 }, {
          empresaId, usuarioId: randomUUID(), requestId: randomUUID(), motivo: "PACOTE_EDITADO",
        });
      } catch (error) {
        falhou = true;
        assert.match(texto(error), /Não foi possível guardar os preços/);
      } finally {
        await db.query("ROLLBACK");
      }
      assert.equal(falhou, true);
      const depoisTabelas = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tabelas_preco WHERE empresa_id = $1::uuid",
        [empresaId],
      );
      assert.equal(depoisTabelas.rows[0].n, antesTabelas.rows[0].n);
      const antigo = await db.query<{ valor: string; substituida: boolean }>(
        `SELECT valor::text AS valor,
                (SELECT substituida_em IS NOT NULL FROM tabelas_preco WHERE id = $2::uuid) AS substituida
           FROM precos_pacote WHERE id = $1::uuid`,
        [precoId, atual.id],
      );
      assert.equal(antigo.rows[0].valor, "10000.00");
      assert.equal(antigo.rows[0].substituida, false);
      assert.equal(await correntes(db, empresaId), 1);
    });

    await t.test("commit sem publicar a sucessora é recusado", async () => {
      const marca = codigo("z48");
      let message = "";
      try {
        await db.query("BEGIN");
        const empresaId = await empresa(db, "Empresa 048 deferida");
        const pacoteId = await pacote(db, empresaId);
        const anterior = await tabela(db, empresaId, "2097-01-01", "2097-12-31");
        await db.query("UPDATE tabelas_preco SET codigo = $2 WHERE id = $1::uuid", [anterior.id, marca]);
        await preco(db, anterior.id, pacoteId, "10.00");
        await escopo(db, anterior.id, pacoteId);
        await publicar(db, anterior.id);
        const sucessora = await tabela(db, empresaId, "2097-01-01", "2097-12-31");
        await db.query(
          `UPDATE tabelas_preco
              SET substituida_por_id = $2::uuid, substituida_em = clock_timestamp()
            WHERE id = $1::uuid`,
          [anterior.id, sucessora.id],
        );
        await db.query("COMMIT");
        message = "passou";
      } catch (error) {
        message = texto(error);
        await db.query("ROLLBACK");
      }
      assert.match(message, /048: sucessora não é a corrente publicada/);
      const ficou = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tabelas_preco WHERE codigo = $1",
        [marca],
      );
      assert.equal(ficou.rows[0].n, 0);
    });

    await t.test("ciclo e sucessora de outra empresa são recusados", async () => {
      await db.query("BEGIN");
      try {
        const empresaA = await empresa(db, "Empresa 048 ciclo");
        const empresaB = await empresa(db, "Empresa 048 outra");
        const pacoteA = await pacote(db, empresaA);
        const anterior = await tabela(db, empresaA, "2096-01-01", "2096-06-30");
        await preco(db, anterior.id, pacoteA, "10.00");
        await escopo(db, anterior.id, pacoteA);
        await publicar(db, anterior.id);
        const sucessora = await tabela(db, empresaA, "2096-01-01", "2096-06-30");
        await preco(db, sucessora.id, pacoteA, "11.00");
        await escopo(db, sucessora.id, pacoteA);
        const outra = await tabela(db, empresaB, "2096-01-01", "2096-06-30");
        await recusa(
          db,
          `UPDATE tabelas_preco
              SET substituida_por_id = $2::uuid, substituida_em = clock_timestamp()
            WHERE id = $1::uuid`,
          [anterior.id, outra.id],
          "mesma empresa",
        );
        await db.query(
          `UPDATE tabelas_preco
              SET substituida_por_id = $2::uuid, substituida_em = clock_timestamp()
            WHERE id = $1::uuid`,
          [anterior.id, sucessora.id],
        );
        await publicar(db, sucessora.id);
        await recusa(
          db,
          `UPDATE tabelas_preco
              SET substituida_por_id = $2::uuid, substituida_em = clock_timestamp()
            WHERE id = $1::uuid`,
          [sucessora.id, anterior.id],
          "ciclo na cadeia de supersessão",
        );
        const terceira = await tabela(db, empresaA, "2096-03-01", "2096-04-01");
        await preco(db, terceira.id, pacoteA, "12.00");
        await escopo(db, terceira.id, pacoteA);
        await recusa(
          db,
          `UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid`,
          [terceira.id],
          "vigência publicada sobreposta",
        );
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("o down recusa apagar supersessão já gravada", async () => {
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(readFileSync(down048, "utf8")));
        assert.fail("down passou");
      } catch (error) {
        assert.match(texto(error), /já existe supersessão/);
      } finally {
        await db.query("ROLLBACK");
      }
      const segue = await db.query<{ ok: boolean }>(
        `SELECT to_regprocedure('public.kidmais_048_validar_supersessao_fim()') IS NOT NULL AS ok`,
      );
      assert.equal(segue.rows[0].ok, true);
    });
  } finally {
    await encerrarDescartavel(client);
  }
});
