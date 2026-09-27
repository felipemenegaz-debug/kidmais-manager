import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { alterarComposicaoPacoteAdmin, criarRevisaoPacoteAdmin } from "./pacotes-admin.ts";
import { publicarTabelaPrecoAdmin } from "./tabelas-preco-admin.ts";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "./postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration036 = resolve(root, "database/migrations/20260926_036_empresa_pai_imutavel.sql");
const down036 = resolve(root, "database/rollback/20260926_036_empresa_pai_imutavel_down.sql");
const migration037 = resolve(root, "database/migrations/20260926_037_publicacao_concorrencia.sql");
const down037 = resolve(root, "database/rollback/20260926_037_publicacao_concorrencia_down.sql");
const migration038 = resolve(root, "database/migrations/20260926_038_integridade_tenant_atomica.sql");
const down038 = resolve(root, "database/rollback/20260926_038_integridade_tenant_atomica_down.sql");
const migration039 = resolve(root, "database/migrations/20260926_039_publicacao_serial_completa.sql");
const down039 = resolve(root, "database/rollback/20260926_039_publicacao_serial_completa_down.sql");
const migration040 = resolve(root, "database/migrations/20260926_040_integridade_sem_excecao_nominal.sql");
const down040 = resolve(root, "database/rollback/20260926_040_integridade_sem_excecao_nominal_down.sql");
const precheck040 = resolve(root, "database/checks/20260926_040_precheck.sql");
const migration041 = resolve(root, "database/migrations/20260926_041_revisao_mesmo_tenant.sql");
const down041 = resolve(root, "database/rollback/20260926_041_revisao_mesmo_tenant_down.sql");
const migration042 = resolve(root, "database/migrations/20260926_042_reativacao_faixa_publicada.sql");
const down042 = resolve(root, "database/rollback/20260926_042_reativacao_faixa_publicada_down.sql");
const empresasDeTeste = "^t0(3[6-9]|4[0-2])";
const trava038 = `
LOCK TABLE
  public.adicionais,
  public.pacote_adicionais,
  public.pacotes,
  public.precos_adicional,
  public.precos_pacote,
  public.tabelas_preco
IN SHARE ROW EXCLUSIVE MODE`;
const trava039 = `
LOCK TABLE
  public.precos_pacote,
  public.tabelas_preco
IN SHARE ROW EXCLUSIVE MODE`;

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

async function empresa(client: Client, prefixo: string) {
  const criada = await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status)
     VALUES ($1, $2, 'PROVISIONAMENTO')
     RETURNING id`,
    [codigo(prefixo), "Empresa de teste"],
  );
  return criada.rows[0].id;
}

async function pacote(client: Client, empresaId: string | null, prefixo: string) {
  const criado = await client.query<{ id: string }>(
    `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
     VALUES ($1::uuid, $2, 'Pacote de teste', 400, true, true)
     RETURNING id`,
    [empresaId, codigo(prefixo)],
  );
  return criado.rows[0].id;
}

async function tabela(client: Client, empresaId: string | null, prefixo: string, inicio: string, fim: string | null) {
  const criada = await client.query<{ id: string }>(
    `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
     VALUES ($1::uuid, $2, 'Tabela de teste', $3::date, $4::date, false)
     RETURNING id`,
    [empresaId, codigo(prefixo), inicio, fim],
  );
  return criada.rows[0].id;
}

async function preco(client: Client, tabelaId: string, pacoteId: string) {
  const criado = await client.query<{ id: string }>(
    `INSERT INTO precos_pacote (
       tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario
     ) VALUES ($1::uuid, $2::uuid, 20, 40, 'FIXO', 10.00, 'PADRAO')
     RETURNING id`,
    [tabelaId, pacoteId],
  );
  return criado.rows[0].id;
}

async function adicional(client: Client, empresaId: string | null, prefixo: string) {
  const criado = await client.query<{ id: string }>(
    `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao)
     SELECT $1::uuid, $2, 'Adicional de teste', categoria, categoria_id, unidade_cobranca, 400
       FROM adicionais
      WHERE codigo = 'SALADA_PREMIUM'
     RETURNING id`,
    [empresaId, codigo(prefixo)],
  );
  return criado.rows[0].id;
}

function rastrear(trabalho: Promise<string>) {
  let terminou = false;
  const promessa = trabalho.finally(() => {
    terminou = true;
  });
  return {
    promessa,
    async aindaEspera() {
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(terminou, false, "a sessão concorrente não ficou bloqueada");
    },
  };
}

async function abrir(): Promise<Client> {
  return conectarDescartavel({ travar: false });
}

async function precoInativo(client: Client, tabelaId: string, pacoteId: string, minimo: number, maximo: number) {
  const criado = await client.query<{ id: string }>(
    `INSERT INTO precos_pacote (
       tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario, ativo
     ) VALUES ($1::uuid, $2::uuid, $3, $4, 'FIXO', 10.00, 'PADRAO', false)
     RETURNING id`,
    [tabelaId, pacoteId, minimo, maximo],
  );
  return criado.rows[0].id;
}

async function precoNaFaixa(client: Client, tabelaId: string, pacoteId: string, minimo: number, maximo: number) {
  const criado = await client.query<{ id: string }>(
    `INSERT INTO precos_pacote (
       tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario
     ) VALUES ($1::uuid, $2::uuid, $3, $4, 'FIXO', 10.00, 'PADRAO')
     RETURNING id`,
    [tabelaId, pacoteId, minimo, maximo],
  );
  return criado.rows[0].id;
}

async function corridaBloqueada(
  lockSql: string,
  concorrente: (cliente: Client) => Promise<void>,
  noMeio: (titular: Client) => Promise<void>,
) {
  const titular = await abrir();
  const outro = await abrir();
  let corrida: ReturnType<typeof rastrear> | undefined;
  try {
    await titular.query("BEGIN");
    await titular.query(lockSql);
    corrida = rastrear((async () => {
      try {
        await outro.query("BEGIN");
        await concorrente(outro);
        await outro.query("ROLLBACK");
        return "ok";
      } catch (error) {
        try {
          await outro.query("ROLLBACK");
        } catch {
          /* transação abortada */
        }
        return texto(error);
      }
    })());
    await corrida.aindaEspera();
    await noMeio(titular);
    await titular.query("COMMIT");
    return await corrida.promessa;
  } finally {
    try {
      await titular.query("ROLLBACK");
    } catch {
      /* já confirmada ou abortada */
    }
    if (corrida) await corrida.promessa.catch(() => undefined);
    await fechar(titular);
    await fechar(outro);
  }
}

async function fechar(client: Client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* transação abortada ou inexistente */
  }
  await client.end();
}

async function apagarEmpresasDeTeste(client: Client) {
  const encontradas = await client.query<{ id: string }>(
    `SELECT id FROM empresas WHERE codigo ~ '${empresasDeTeste}'`,
  );
  if (encontradas.rows.length === 0) return;
  await client.query("ALTER TABLE precos_pacote DISABLE TRIGGER USER");
  await client.query("ALTER TABLE empresas DISABLE TRIGGER empresas_guard_trg");
  try {
    for (const empresaId of encontradas.rows.map((row) => row.id)) {
      await client.query(
        `DELETE FROM precos_pacote
          WHERE tabela_preco_id IN (SELECT id FROM tabelas_preco WHERE empresa_id = $1::uuid)
             OR pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)`,
        [empresaId],
      );
      await client.query(
        `DELETE FROM precos_adicional
          WHERE tabela_preco_id IN (SELECT id FROM tabelas_preco WHERE empresa_id = $1::uuid)
             OR adicional_id IN (SELECT id FROM adicionais WHERE empresa_id = $1::uuid)`,
        [empresaId],
      );
      await client.query(
        `DELETE FROM pacote_adicionais
          WHERE pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)
             OR adicional_id IN (SELECT id FROM adicionais WHERE empresa_id = $1::uuid)`,
        [empresaId],
      );
      await client.query(
        "DELETE FROM regras_disponibilidade_pacote WHERE pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)",
        [empresaId],
      );
      await client.query(
        "DELETE FROM regras_desconto_pacote WHERE pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)",
        [empresaId],
      );
      await client.query(
        "DELETE FROM pacote_buffet_categorias WHERE pacote_id IN (SELECT id FROM pacotes WHERE empresa_id = $1::uuid)",
        [empresaId],
      );
      await client.query("DELETE FROM pacotes WHERE empresa_id = $1::uuid", [empresaId]);
      await client.query("DELETE FROM tabelas_preco WHERE empresa_id = $1::uuid", [empresaId]);
      await client.query("DELETE FROM adicionais WHERE empresa_id = $1::uuid", [empresaId]);
      await client.query("DELETE FROM empresas WHERE id = $1::uuid", [empresaId]);
    }
  } finally {
    await client.query("ALTER TABLE empresas ENABLE TRIGGER empresas_guard_trg");
    await client.query("ALTER TABLE precos_pacote ENABLE TRIGGER USER");
  }
}

test("remediação de pacotes no postgres descartável", { timeout: 300_000 }, async (t) => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  const estado039 = await db.query<{ trava: boolean; depois: boolean }>(
    `SELECT to_regprocedure('public.kidmais_039_travar_par(uuid,uuid)') IS NOT NULL AS trava,
            EXISTS (
              SELECT 1 FROM pg_trigger
               WHERE tgname = 'precos_pacote_tabela_publicada_depois_trg' AND NOT tgisinternal
            ) AS depois`,
  );
  if (estado039.rows[0].trava && !estado039.rows[0].depois) {
    await db.query(readFileSync(down039, "utf8"));
    await db.query(readFileSync(migration039, "utf8"));
  }
  const revisao041 = await db.query<{ ok: boolean }>(
    "SELECT to_regprocedure('public.kidmais_041_revisao_mesmo_tenant()') IS NOT NULL AS ok",
  );
  if (!revisao041.rows[0].ok) await db.query(readFileSync(migration041, "utf8"));
  const faixa042 = await db.query<{ ok: boolean }>(
    "SELECT to_regprocedure('public.kidmais_042_revalidar_faixa_publicada(uuid,uuid,uuid,text,integer,integer)') IS NOT NULL AS ok",
  );
  if (!faixa042.rows[0].ok) await db.query(readFileSync(migration042, "utf8"));
  try {
    await t.test("a migration 036 falha fechada quando já há duas empresas no vínculo", async () => {
      await db.query("BEGIN");
      try {
        await db.query(`
          DROP TRIGGER IF EXISTS pacotes_empresa_imutavel_trg ON pacotes;
          DROP TRIGGER IF EXISTS tabelas_preco_empresa_imutavel_trg ON tabelas_preco;
          DROP TRIGGER IF EXISTS adicionais_empresa_imutavel_trg ON adicionais;
          DROP FUNCTION IF EXISTS kidmais_036_empresa_pai_imutavel();
          DROP FUNCTION IF EXISTS kidmais_036_falhar_se_incompativel();
        `);
        const empresaA = await empresa(db, "t036a");
        const empresaB = await empresa(db, "t036b");
        const pacoteB = await pacote(db, empresaB, "p036b");
        const tabelaA = await tabela(db, empresaA, "t036t", "2091-01-01", "2091-06-01");
        await db.query("ALTER TABLE precos_pacote DISABLE TRIGGER precos_pacote_empresa_trg");
        await preco(db, tabelaA, pacoteB);
        let message = "";
        try {
          await db.query(semTransacaoExplicita(readFileSync(migration036, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /036: .*duas empresas/);
      } finally {
        await db.query("ROLLBACK");
      }
      const guarda = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_036_falhar_se_incompativel()') IS NOT NULL AS ok",
      );
      if (!guarda.rows[0].ok) await db.query(readFileSync(migration036, "utf8"));
    });

    await t.test("relação da mesma empresa passa e a empresa do pai não muda", async () => {
      await db.query("BEGIN");
      try {
        const empresaA = await empresa(db, "t036c");
        const empresaB = await empresa(db, "t036d");
        const pacoteA = await pacote(db, empresaA, "p036c");
        const tabelaA = await tabela(db, empresaA, "t036u", "2091-07-01", "2091-12-01");
        await preco(db, tabelaA, pacoteA);
        const adicionalA = await adicional(db, empresaA, "a036c");
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, 'INCLUSO')`,
          [pacoteA, adicionalA],
        );
        await recusa(db, "UPDATE pacotes SET empresa_id = $2::uuid WHERE id = $1::uuid", [pacoteA, empresaB], "036:");
        await recusa(db, "UPDATE tabelas_preco SET empresa_id = $2::uuid WHERE id = $1::uuid", [tabelaA, empresaB], "036:");
        await recusa(db, "UPDATE adicionais SET empresa_id = $2::uuid WHERE id = $1::uuid", [adicionalA, empresaB], "036:");
        const pacoteB = await pacote(db, empresaB, "p036d");
        await recusa(
          db,
          `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario)
           VALUES ($1::uuid, $2::uuid, 20, 40, 'FIXO', 10.00, 'PADRAO')`,
          [tabelaA, pacoteB],
          "034:",
        );
        const legadoPacote = await pacote(db, null, "p036n");
        const legadoAdicional = await adicional(db, null, "a036n");
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [legadoPacote, legadoAdicional],
        );
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("o rollback da 036 remove a guarda e a transação a devolve", async () => {
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(readFileSync(down036, "utf8")));
        const ausente = await db.query<{ ok: boolean }>(
          "SELECT to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NULL AS ok",
        );
        assert.equal(ausente.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK");
      }
      const presente = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NOT NULL AS ok",
      );
      assert.equal(presente.rows[0].ok, true);
    });

    await t.test("a migration 037 falha fechada quando a vigência publicada já se cruza", async () => {
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(readFileSync(down039, "utf8")));
        await db.query(semTransacaoExplicita(readFileSync(down037, "utf8")));
        const empresaId = await empresa(db, "t037a");
        await db.query(
          `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa, publicada_em)
           VALUES
             ($1::uuid, $2, 'Sobre A', DATE '2092-01-01', DATE '2092-12-31', false, clock_timestamp()),
             ($1::uuid, $3, 'Sobre B', DATE '2092-06-01', DATE '2092-12-31', false, clock_timestamp())`,
          [empresaId, codigo("s037a"), codigo("s037b")],
        );
        let message = "";
        try {
          await db.query(semTransacaoExplicita(readFileSync(migration037, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /037: .*sobre/);
      } finally {
        await db.query("ROLLBACK");
      }
      const trava = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NOT NULL AS ok",
      );
      if (!trava.rows[0].ok) await db.query(readFileSync(migration037, "utf8"));
    });

    await t.test("publicação recusa delete, mudança de tabela, ativo que esvazia e segundo carimbo", async () => {
      await db.query("BEGIN");
      try {
        const empresaId = await empresa(db, "t037b");
        const pacoteId = await pacote(db, empresaId, "p037b");
        const publicadaId = await tabela(db, empresaId, "u037b", "2093-01-01", "2093-06-30");
        const rascunhoId = await tabela(db, empresaId, "u037c", "2093-07-01", "2093-12-31");
        const precoPublicado = await preco(db, publicadaId, pacoteId);
        const precoRascunho = await preco(db, rascunhoId, pacoteId);
        await db.query(
          `UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid AND publicada_em IS NULL`,
          [publicadaId],
        );
        await recusa(db, "DELETE FROM precos_pacote WHERE id = $1::uuid", [precoPublicado], "037:");
        await recusa(
          db,
          "UPDATE precos_pacote SET tabela_preco_id = $2::uuid WHERE id = $1::uuid",
          [precoPublicado, rascunhoId],
          "037:",
        );
        await recusa(
          db,
          "UPDATE precos_pacote SET tabela_preco_id = $2::uuid WHERE id = $1::uuid",
          [precoRascunho, publicadaId],
          "037:",
        );
        await recusa(db, "UPDATE precos_pacote SET ativo = false WHERE id = $1::uuid", [precoPublicado], "037:");
        await db.query("UPDATE precos_pacote SET observacoes = 'nota operacional' WHERE id = $1::uuid", [precoPublicado]);
        const nota = await db.query<{ observacoes: string }>(
          "SELECT observacoes FROM precos_pacote WHERE id = $1::uuid",
          [precoPublicado],
        );
        assert.equal(nota.rows[0].observacoes, "nota operacional");
        await recusa(
          db,
          "UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid",
          [publicadaId],
          "035:",
        );
        const vaziaId = await tabela(db, empresaId, "u037z", "2093-01-01", "2093-03-01");
        await recusa(
          db,
          "UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id = $1::uuid",
          [vaziaId],
          "tabela vazia",
        );
        const publicada = await db.query<{ ok: boolean }>(
          "SELECT publicada_em IS NOT NULL AS ok FROM tabelas_preco WHERE id = $1::uuid",
          [publicadaId],
        );
        assert.equal(publicada.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("só uma publicação conflitante confirma", async () => {
      const empresaId = await empresa(db, "t037d");
      const pacoteId = await pacote(db, empresaId, "p037d");
      const tabelaA = await tabela(db, empresaId, "u037d", "2094-01-01", "2094-12-31");
      const tabelaB = await tabela(db, empresaId, "u037e", "2094-06-01", "2094-12-31");
      await preco(db, tabelaA, pacoteId);
      await preco(db, tabelaB, pacoteId);

      async function publicar(id: string) {
        const outro = await conectarDescartavel({ travar: false });
        try {
          await outro.query("BEGIN");
          await outro.query(
            `UPDATE tabelas_preco SET publicada_em = clock_timestamp()
              WHERE id = $1::uuid AND publicada_em IS NULL AND ativa = false`,
            [id],
          );
          await outro.query("COMMIT");
          return "ok";
        } catch (error) {
          try {
            await outro.query("ROLLBACK");
          } catch {
            /* transação abortada */
          }
          return texto(error);
        } finally {
          await outro.end();
        }
      }

      const [primeira, segunda] = await Promise.all([publicar(tabelaA), publicar(tabelaB)]);
      const ok = [primeira, segunda].filter((item) => item === "ok");
      assert.equal(ok.length, 1, `${primeira} | ${segunda}`);
      const publicadas = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tabelas_preco WHERE id = ANY($1::uuid[]) AND publicada_em IS NOT NULL`,
        [[tabelaA, tabelaB]],
      );
      assert.equal(publicadas.rows[0].n, 1);
    });

    await t.test("o rollback da 037 devolve a guarda anterior e a transação restaura a trava", async () => {
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(readFileSync(down039, "utf8")));
        await db.query(semTransacaoExplicita(readFileSync(down037, "utf8")));
        const ausente = await db.query<{ ok: boolean }>(
          "SELECT to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NULL AS ok",
        );
        assert.equal(ausente.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK");
      }
      const presente = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NOT NULL AS ok",
      );
      assert.equal(presente.rows[0].ok, true);
    });

    await t.test("revisão de pacote utilizado clona a disponibilidade e preserva a anterior", async () => {
      await db.query("BEGIN");
      try {
        const empresaId = await empresa(db, "t036e");
        const pacoteId = await pacote(db, empresaId, "p036e");
        const tabelaId = await tabela(db, empresaId, "u036e", "2095-01-01", "2095-06-30");
        const precoId = await preco(db, tabelaId, pacoteId);
        const agenda = await db.query<{ id: string }>(
          "SELECT id FROM configuracao_agenda WHERE codigo = 'TURNO_2' AND ativo LIMIT 1",
        );
        await db.query(
          `INSERT INTO regras_disponibilidade_pacote (
             pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, ativo, observacoes
           ) VALUES ($1::uuid, 6, $2::uuid, 'INDISPONIVEL', DATE '2026-11-01', true, 'somente sabado turno 2')`,
          [pacoteId, agenda.rows[0].id],
        );
        await db.query(
          `INSERT INTO fechamentos (
             data_evento, horario_inicio, horario_fim, configuracao_agenda_id,
             pacote_id, tabela_preco_id, preco_pacote_id,
             categoria_horario, categoria_preco_aplicada,
             convidados, convidados_faturados,
             valor_pacote_base, desconto_percentual, valor_desconto_pacote, valor_pacote_aplicado,
             valor_adicionais, valor_tabela, status, origem_fechamento
           ) VALUES (
             DATE '2026-11-07', TIME '14:00', TIME '18:00', $1::uuid,
             $2::uuid, $3::uuid, $4::uuid,
             'PADRAO', 'PADRAO', 30, 30,
             10, 0, 0, 10, 0, 10, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS'
           )`,
          [agenda.rows[0].id, pacoteId, tabelaId, precoId],
        );
        const tx = {
          async query<Row extends object>(text: string, values?: readonly unknown[]) {
            const result = await db.query(text, values as unknown[]);
            return { rows: result.rows as Row[], rowCount: result.rowCount };
          },
        };
        const nova = await criarRevisaoPacoteAdmin(
          tx,
          pacoteId,
          { nome: "Revisão com disponibilidade", descricao: null, duracaoMinutos: null },
          { empresaId, usuarioId: randomUUID(), requestId: randomUUID(), motivo: "Nova revisão do pacote usado" },
        );
        const regras = async (id: string) => (await db.query<{ estado: string; dia_semana: number; observacoes: string }>(
          `SELECT estado, dia_semana, observacoes
             FROM regras_disponibilidade_pacote
            WHERE pacote_id = $1::uuid
            ORDER BY dia_semana, vigencia_inicio`,
          [id],
        )).rows;
        assert.deepEqual(await regras(nova.id), await regras(pacoteId));
        assert.equal((await regras(pacoteId)).length, 1);
        assert.equal((await regras(pacoteId))[0].observacoes, "somente sabado turno 2");
        const precosNovos = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM precos_pacote WHERE pacote_id = $1::uuid",
          [nova.id],
        );
        const precosAntigos = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM precos_pacote WHERE pacote_id = $1::uuid",
          [pacoteId],
        );
        assert.equal(precosNovos.rows[0].n, 0);
        assert.equal(precosAntigos.rows[0].n, 1);
        const anterior = await db.query<{ vigente: boolean }>("SELECT vigente FROM pacotes WHERE id = $1::uuid", [pacoteId]);
        assert.equal(anterior.rows[0].vigente, false);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("auditoria da composição é uma, real, e some no rollback", async () => {
      const requestId = randomUUID();
      await db.query("BEGIN");
      const empresaId = await empresa(db, "t036f");
      const pacoteId = await pacote(db, empresaId, "p036f");
      const adicionalId = await adicional(db, empresaId, "a036f");
      await db.query(
        `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, 'INCLUSO')`,
        [pacoteId, adicionalId],
      );
      const tabelaId = await tabela(db, empresaId, "u036f", "2096-01-01", "2096-06-30");
      const precoId = await preco(db, tabelaId, pacoteId);
      const agenda = await db.query<{ id: string }>(
        "SELECT id FROM configuracao_agenda WHERE codigo = 'TURNO_1' AND ativo LIMIT 1",
      );
      await db.query(
        `INSERT INTO fechamentos (
           data_evento, horario_inicio, horario_fim, configuracao_agenda_id,
           pacote_id, tabela_preco_id, preco_pacote_id,
           categoria_horario, categoria_preco_aplicada,
           convidados, convidados_faturados,
           valor_pacote_base, desconto_percentual, valor_desconto_pacote, valor_pacote_aplicado,
           valor_adicionais, valor_tabela, status, origem_fechamento
         ) VALUES (
           DATE '2026-11-09', TIME '10:00', TIME '14:00', $1::uuid,
           $2::uuid, $3::uuid, $4::uuid,
           'PADRAO', 'PADRAO', 30, 30,
           10, 0, 0, 10, 0, 10, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS'
         )`,
        [agenda.rows[0].id, pacoteId, tabelaId, precoId],
      );
      const tx = {
        async query<Row extends object>(text: string, values?: readonly unknown[]) {
          const result = await db.query(text, values as unknown[]);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
      };
      await alterarComposicaoPacoteAdmin(
        tx,
        pacoteId,
        { tipo: "vinculo", adicionalId, modalidade: "EXTRA" },
        { empresaId, usuarioId: randomUUID(), requestId, motivo: "Troca a modalidade do incluso" },
      );
      const eventos = await db.query<{ acao: string; dados_antes: { adicionais: Array<{ modalidade: string }> }; dados_depois: { adicionais: Array<{ modalidade: string }> } }>(
        `SELECT acao, dados_antes, dados_depois FROM auditoria WHERE request_id = $1::uuid`,
        [requestId],
      );
      assert.equal(eventos.rows.length, 1);
      assert.equal(eventos.rows[0].acao, "PACOTE_COMPOSICAO");
      assert.equal(eventos.rows[0].dados_antes.adicionais[0].modalidade, "INCLUSO");
      assert.equal(eventos.rows[0].dados_depois.adicionais[0].modalidade, "EXTRA");
      await db.query("ROLLBACK");
      const depois = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM auditoria WHERE request_id = $1::uuid",
        [requestId],
      );
      assert.equal(depois.rows[0].n, 0);
    });

    await t.test("a publicação grava o carimbo devolvido e o rollback apaga a auditoria", async () => {
      const requestId = randomUUID();
      await db.query("BEGIN");
      const empresaId = await empresa(db, "t037f");
      const pacoteId = await pacote(db, empresaId, "p037f");
      const tabelaId = await tabela(db, empresaId, "u037f", "2097-01-01", "2097-06-30");
      await preco(db, tabelaId, pacoteId);
      const tx = {
        async query<Row extends object>(text: string, values?: readonly unknown[]) {
          const result = await db.query(text, values as unknown[]);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
      };
      await publicarTabelaPrecoAdmin(tx, {
        empresaId,
        tabelaId,
        usuarioId: randomUUID(),
        requestId,
        motivo: "Publicar a faixa conferida",
      });
      const evento = await db.query<{ dados_depois: { publicadaEm?: string } }>(
        "SELECT dados_depois FROM auditoria WHERE request_id = $1::uuid",
        [requestId],
      );
      const carimbo = await db.query<{ publicada_em: string }>(
        "SELECT publicada_em::text AS publicada_em FROM tabelas_preco WHERE id = $1::uuid",
        [tabelaId],
      );
      assert.equal(evento.rows.length, 1);
      assert.equal(evento.rows[0].dados_depois.publicadaEm, carimbo.rows[0].publicada_em);
      assert.equal(String(evento.rows[0].dados_depois.publicadaEm).includes("clock_timestamp()"), false);
      await db.query("ROLLBACK");
      const depois = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM auditoria WHERE request_id = $1::uuid",
        [requestId],
      );
      assert.equal(depois.rows[0].n, 0);
    });

    await t.test("os sete pacotes legados e o vínculo sem tenant permanecem", async () => {
      const legado = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL");
      const vinculo = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pacote_adicionais pa
           JOIN pacotes p ON p.id = pa.pacote_id
           JOIN adicionais a ON a.id = pa.adicional_id
          WHERE p.codigo = 'FESTA_LOCAL'
            AND a.codigo = 'SALADA_PREMIUM'
            AND p.empresa_id IS NOT NULL
            AND a.empresa_id IS NULL`,
      );
      assert.equal(legado.rows[0].n, 7);
      assert.equal(vinculo.rows[0].n, 0);
    });

    await t.test("a migration 038 volta atrás inteira com vínculo incompatível", async () => {
      async function planta(preparar: () => Promise<void>) {
        await db.query("BEGIN");
        try {
          await preparar();
          let message = "";
          try {
            await db.query(semTransacaoExplicita(readFileSync(migration038, "utf8")));
            message = "passou";
          } catch (error) {
            message = texto(error);
          }
          assert.match(message, /038: vínculo incompatível/);
        } finally {
          await db.query("ROLLBACK");
        }
      }

      await planta(async () => {
        await db.query("ALTER TABLE precos_pacote DISABLE TRIGGER precos_pacote_empresa_trg");
        const empresaA = await empresa(db, "t038a");
        const empresaB = await empresa(db, "t038b");
        const pacoteB = await pacote(db, empresaB, "p038b");
        const tabelaA = await tabela(db, empresaA, "u038a", "2081-01-01", "2081-06-01");
        await preco(db, tabelaA, pacoteB);
      });
      await planta(async () => {
        await db.query("ALTER TABLE pacote_adicionais DISABLE TRIGGER pacote_adicionais_empresa_trg");
        const empresaA = await empresa(db, "t038c");
        const pacoteA = await pacote(db, empresaA, "p038c");
        const salada = await db.query<{ id: string }>(
          "SELECT id FROM adicionais WHERE codigo = 'SALADA_PREMIUM' AND empresa_id IS NULL",
        );
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteA, salada.rows[0].id],
        );
      });
      await planta(async () => {
        await db.query("ALTER TABLE pacote_adicionais DISABLE TRIGGER pacote_adicionais_empresa_trg");
        const empresaA = await empresa(db, "t038d");
        const pacoteNulo = await pacote(db, null, "p038n");
        const adicionalA = await adicional(db, empresaA, "a038d");
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteNulo, adicionalA],
        );
      });
    });

    await t.test("a instalação da 038 não deixa outra transação mudar a empresa", async () => {
      const local = await db.query<{ id: string }>("SELECT id FROM empresas WHERE codigo = 'empresa-local'");
      const empresaAlvo = local.rows[0]?.id ?? await empresa(db, "t038");
      const ja = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_038_falhar_se_incompativel()') IS NOT NULL AS ok",
      );
      const resultado = await corridaBloqueada(
        trava038,
        async (cliente) => {
          await cliente.query(
            "UPDATE pacotes SET empresa_id = $1::uuid WHERE codigo = 'COMPACTA' AND empresa_id IS NULL",
            [empresaAlvo],
          );
        },
        async (titular) => {
          if (!ja.rows[0].ok) await titular.query(semTransacaoExplicita(readFileSync(migration038, "utf8")));
        },
      );
      assert.match(resultado, /036:/);
      const compacta = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pacotes WHERE codigo = 'COMPACTA' AND empresa_id IS NULL",
      );
      assert.equal(compacta.rows[0].n, 1);
      const guarda = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_038_falhar_se_incompativel()') IS NOT NULL AS ok",
      );
      assert.equal(guarda.rows[0].ok, true);
    });

    await t.test("a política de tenant recusa desencontro e mudança de empresa", async () => {
      await db.query("BEGIN");
      try {
        const empresaA = await empresa(db, "t038e");
        const empresaB = await empresa(db, "t038f");
        const pacoteA = await pacote(db, empresaA, "p038e");
        const pacoteB = await pacote(db, empresaB, "p038f");
        const pacoteNulo = await pacote(db, null, "p038g");
        const tabelaA = await tabela(db, empresaA, "u038e", "2082-01-01", "2082-06-01");
        const adicionalA = await adicional(db, empresaA, "a038e");
        const adicionalNulo = await adicional(db, null, "a038g");
        await preco(db, tabelaA, pacoteA);
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteNulo, adicionalNulo],
        );
        await recusa(
          db,
          `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario)
           VALUES ($1::uuid, $2::uuid, 20, 40, 'FIXO', 10.00, 'PADRAO')`,
          [tabelaA, pacoteB],
          "034:",
        );
        const salada = await db.query<{ id: string }>(
          "SELECT id FROM adicionais WHERE codigo = 'SALADA_PREMIUM' AND empresa_id IS NULL",
        );
        await recusa(
          db,
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteA, salada.rows[0].id],
          "034:",
        );
        await recusa(
          db,
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteNulo, adicionalA],
          "034:",
        );
        await recusa(db, "UPDATE pacotes SET empresa_id = $2::uuid WHERE id = $1::uuid", [pacoteA, empresaB], "036:");
        const compacta = await db.query<{ id: string }>("SELECT id FROM pacotes WHERE codigo = 'COMPACTA'");
        await recusa(
          db,
          "UPDATE pacotes SET empresa_id = $2::uuid WHERE id = $1::uuid",
          [compacta.rows[0].id, empresaA],
          "036:",
        );
        const legado = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL");
        assert.equal(legado.rows[0].n >= 7, true);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("a migration 039 volta atrás inteira com vigência sobreposta", async () => {
      await db.query("BEGIN");
      try {
        const empresaId = await empresa(db, "t039a");
        await db.query(
          `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa, publicada_em)
           VALUES
             ($1::uuid, $2, 'Sobre A', DATE '2083-01-01', DATE '2083-12-31', false, clock_timestamp()),
             ($1::uuid, $3, 'Sobre B', DATE '2083-06-01', DATE '2083-12-31', false, clock_timestamp())`,
          [empresaId, codigo("s039a"), codigo("s039b")],
        );
        let message = "";
        try {
          await db.query(semTransacaoExplicita(readFileSync(migration039, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /039: .*sobre/);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("a instalação da 039 não deixa outra transação escrever preço no intervalo", async () => {
      const precoId = await db.query<{ id: string }>("SELECT id FROM precos_pacote LIMIT 1");
      const ja = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_039_travar_par(uuid,uuid)') IS NOT NULL AS ok",
      );
      const resultado = await corridaBloqueada(
        trava039,
        async (cliente) => {
          await cliente.query("UPDATE precos_pacote SET observacoes = 'janela da 039' WHERE id = $1::uuid", [
            precoId.rows[0].id,
          ]);
        },
        async (titular) => {
          if (!ja.rows[0].ok) await titular.query(semTransacaoExplicita(readFileSync(migration039, "utf8")));
        },
      );
      assert.equal(resultado, "ok");
      const nota = await db.query<{ observacoes: string | null }>(
        "SELECT observacoes FROM precos_pacote WHERE id = $1::uuid",
        [precoId.rows[0].id],
      );
      assert.notEqual(nota.rows[0].observacoes, "janela da 039");
      const guarda = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_039_travar_par(uuid,uuid)') IS NOT NULL AS ok",
      );
      assert.equal(guarda.rows[0].ok, true);
    });

    await t.test("publicação concorrente não deixa insert, update, delete nem movimento escapar", async () => {
      const empresaId = await empresa(db, "t039b");
      const pacoteId = await pacote(db, empresaId, "p039b");
      const rascunhoId = await tabela(db, empresaId, "u039z", "2088-01-01", "2088-06-01");

      async function contra(
        tabelaId: string,
        concorrente: (cliente: Client) => Promise<void>,
      ) {
        const titular = await abrir();
        const outro = await abrir();
        let corrida: ReturnType<typeof rastrear> | undefined;
        try {
          await titular.query("BEGIN");
          await titular.query(
            `UPDATE tabelas_preco SET publicada_em = clock_timestamp()
              WHERE id = $1::uuid AND publicada_em IS NULL AND ativa = false`,
            [tabelaId],
          );
          corrida = rastrear((async () => {
            try {
              await outro.query("BEGIN");
              await concorrente(outro);
              await outro.query("ROLLBACK");
              return "ok";
            } catch (error) {
              try {
                await outro.query("ROLLBACK");
              } catch {
                /* transação abortada */
              }
              return texto(error);
            }
          })());
          await corrida.aindaEspera();
          await titular.query("COMMIT");
          return await corrida.promessa;
        } finally {
          try {
            await titular.query("ROLLBACK");
          } catch {
            /* já confirmada */
          }
          if (corrida) await corrida.promessa.catch(() => undefined);
          await fechar(titular);
          await fechar(outro);
        }
      }

      const paraInserir = await tabela(db, empresaId, "u039b", "2084-01-01", "2084-03-31");
      await preco(db, paraInserir, pacoteId);
      assert.match(
        await contra(paraInserir, async (cliente) => {
          await precoNaFaixa(cliente, paraInserir, pacoteId, 41, 80);
        }),
        /035:/,
      );

      const paraAtualizar = await tabela(db, empresaId, "u039c", "2084-04-01", "2084-06-30");
      const precoAtualizar = await preco(db, paraAtualizar, pacoteId);
      assert.match(
        await contra(paraAtualizar, async (cliente) => {
          await cliente.query("UPDATE precos_pacote SET valor = 99 WHERE id = $1::uuid", [precoAtualizar]);
        }),
        /037:/,
      );

      const paraApagar = await tabela(db, empresaId, "u039d", "2084-07-01", "2084-09-30");
      const precoApagar = await preco(db, paraApagar, pacoteId);
      assert.match(
        await contra(paraApagar, async (cliente) => {
          await cliente.query("DELETE FROM precos_pacote WHERE id = $1::uuid", [precoApagar]);
        }),
        /037:/,
      );

      const paraMover = await tabela(db, empresaId, "u039e", "2084-10-01", "2084-12-31");
      const precoMover = await preco(db, paraMover, pacoteId);
      assert.match(
        await contra(paraMover, async (cliente) => {
          await cliente.query("UPDATE precos_pacote SET tabela_preco_id = $2::uuid WHERE id = $1::uuid", [
            precoMover,
            rascunhoId,
          ]);
        }),
        /037:/,
      );
    });

    await t.test("duas desativações do fim da publicação não esvaziam a tabela", async () => {
      const empresaId = await empresa(db, "t039d");
      const pacoteId = await pacote(db, empresaId, "p039d");
      const tabelaId = await tabela(db, empresaId, "u039d", "2086-01-01", "2086-12-31");
      const primeira = await precoNaFaixa(db, tabelaId, pacoteId, 20, 40);
      const segunda = await precoNaFaixa(db, tabelaId, pacoteId, 41, 80);
      await db.query(
        `UPDATE tabelas_preco SET publicada_em = clock_timestamp()
          WHERE id = $1::uuid AND publicada_em IS NULL AND ativa = false`,
        [tabelaId],
      );
      const titular = await abrir();
      const outro = await abrir();
      let corrida: ReturnType<typeof rastrear> | undefined;
      try {
        await titular.query("BEGIN");
        await titular.query("UPDATE precos_pacote SET ativo = false WHERE id = $1::uuid", [primeira]);
        corrida = rastrear((async () => {
          try {
            await outro.query("BEGIN");
            await outro.query("UPDATE precos_pacote SET ativo = false WHERE id = $1::uuid", [segunda]);
            await outro.query("COMMIT");
            return "ok";
          } catch (error) {
            try {
              await outro.query("ROLLBACK");
            } catch {
              /* transação abortada */
            }
            return texto(error);
          }
        })());
        await corrida.aindaEspera();
        await titular.query("COMMIT");
        const resultado = await corrida.promessa;
        assert.match(resultado, /037:/);
        const ativos = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM precos_pacote WHERE tabela_preco_id = $1::uuid AND ativo",
          [tabelaId],
        );
        assert.equal(ativos.rows[0].n, 1);
      } finally {
        try {
          await titular.query("ROLLBACK");
        } catch {
          /* já confirmada */
        }
        if (corrida) await corrida.promessa.catch(() => undefined);
        await fechar(titular);
        await fechar(outro);
      }
    });

    await t.test("observacoes segue editável enquanto outra empresa publica sem espera global", async () => {
      const empresaA = await empresa(db, "t039e");
      const empresaB = await empresa(db, "t039f");
      const pacoteA = await pacote(db, empresaA, "p039e");
      const pacoteB = await pacote(db, empresaB, "p039f");
      const tabelaA = await tabela(db, empresaA, "u039e", "2087-01-01", "2087-12-31");
      const tabelaB = await tabela(db, empresaB, "u039f", "2087-01-01", "2087-12-31");
      const precoA = await preco(db, tabelaA, pacoteA);
      await preco(db, tabelaB, pacoteB);
      const titular = await abrir();
      const notas = await abrir();
      const outra = await abrir();
      try {
        await titular.query("BEGIN");
        await titular.query(
          `UPDATE tabelas_preco SET publicada_em = clock_timestamp()
            WHERE id = $1::uuid AND publicada_em IS NULL AND ativa = false`,
          [tabelaA],
        );
        await notas.query("BEGIN");
        await notas.query("SET lock_timeout = '800ms'");
        await notas.query("UPDATE precos_pacote SET observacoes = 'nota operacional' WHERE id = $1::uuid", [precoA]);
        await notas.query("ROLLBACK");
        await outra.query("BEGIN");
        await outra.query("SET lock_timeout = '800ms'");
        await outra.query(
          `UPDATE tabelas_preco SET publicada_em = clock_timestamp()
            WHERE id = $1::uuid AND publicada_em IS NULL AND ativa = false`,
          [tabelaB],
        );
        await outra.query("ROLLBACK");
      } finally {
        await fechar(titular);
        await fechar(notas);
        await fechar(outra);
      }
    });

    await t.test("o rollback da 038 e da 039 desfaz a guarda nova e a transação a devolve", async () => {
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(readFileSync(down038, "utf8")));
        await db.query(semTransacaoExplicita(readFileSync(down039, "utf8")));
        const ausente = await db.query<{ ok: boolean }>(
          `SELECT to_regprocedure('public.kidmais_038_falhar_se_incompativel()') IS NULL
              AND to_regprocedure('public.kidmais_039_travar_par(uuid,uuid)') IS NULL AS ok`,
        );
        assert.equal(ausente.rows[0].ok, true);
        const antes = await db.query<{ ok: boolean }>(
          `SELECT (tgtype & 2) = 2 AS ok
             FROM pg_trigger
            WHERE tgname = 'precos_pacote_tabela_publicada_trg' AND NOT tgisinternal`,
        );
        assert.equal(antes.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK");
      }
      const presente = await db.query<{ ok: boolean }>(
        `SELECT to_regprocedure('public.kidmais_038_falhar_se_incompativel()') IS NOT NULL
            AND to_regprocedure('public.kidmais_039_travar_par(uuid,uuid)') IS NOT NULL AS ok`,
      );
      assert.equal(presente.rows[0].ok, true);
    });

    await t.test("a migration 040 aborta no vínculo histórico e não o reescreve", async () => {
      const antes = await db.query<{ vinculos: number; legado: number; guarda: boolean }>(
        `SELECT
           (SELECT count(*)::int
              FROM pacote_adicionais pa
              JOIN pacotes p ON p.id = pa.pacote_id
              JOIN adicionais a ON a.id = pa.adicional_id
             WHERE p.codigo = 'FESTA_LOCAL'
               AND a.codigo = 'SALADA_PREMIUM'
               AND p.empresa_id IS NOT NULL
               AND a.empresa_id IS NULL) AS vinculos,
           (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS legado,
           to_regprocedure('public.kidmais_040_falhar_se_incompativel()') IS NOT NULL AS guarda`,
      );
      assert.equal(antes.rows[0].vinculos, 0);
      assert.equal(antes.rows[0].legado, 7);
      assert.equal(antes.rows[0].guarda, false);
      await db.query("BEGIN");
      try {
        await db.query("ALTER TABLE pacote_adicionais DISABLE TRIGGER pacote_adicionais_empresa_trg");
        const empresaA = await empresa(db, "t040h");
        const pacoteA = await pacote(db, empresaA, "p040h");
        const adicionalNulo = await adicional(db, null, "a040h");
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteA, adicionalNulo],
        );
        let message = "";
        try {
          await db.query(semTransacaoExplicita(readFileSync(precheck040, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /040 precheck: vínculo incompatível/);
        await db.query("ROLLBACK");
        await db.query("BEGIN");
        await db.query("ALTER TABLE pacote_adicionais DISABLE TRIGGER pacote_adicionais_empresa_trg");
        const empresaB = await empresa(db, "t040i");
        const pacoteB = await pacote(db, empresaB, "p040i");
        const adicionalNuloB = await adicional(db, null, "a040i");
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteB, adicionalNuloB],
        );
        message = "";
        try {
          await db.query(semTransacaoExplicita(readFileSync(migration040, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /040: vínculo incompatível/);
      } finally {
        await db.query("ROLLBACK");
      }
      const depois = await db.query<{ vinculos: number; legado: number; guarda: boolean; lista: boolean }>(
        `SELECT
           (SELECT count(*)::int
              FROM pacote_adicionais pa
              JOIN pacotes p ON p.id = pa.pacote_id
              JOIN adicionais a ON a.id = pa.adicional_id
             WHERE p.codigo = 'FESTA_LOCAL'
               AND a.codigo = 'SALADA_PREMIUM'
               AND p.empresa_id IS NOT NULL
               AND a.empresa_id IS NULL) AS vinculos,
           (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS legado,
           to_regprocedure('public.kidmais_040_falhar_se_incompativel()') IS NOT NULL AS guarda,
           position('SALADA_PREMIUM' IN pg_get_functiondef('public.kidmais_038_falhar_se_incompativel()'::regprocedure)) > 0 AS lista`,
      );
      assert.equal(depois.rows[0].vinculos, 0);
      assert.equal(depois.rows[0].legado, 7);
      assert.equal(depois.rows[0].guarda, false);
      assert.equal(depois.rows[0].lista, true);
    });

    await t.test("a migration 040 aborta com vínculo incompatível introduzido e desfaz tudo", async () => {
      await db.query("BEGIN");
      try {
        await db.query("ALTER TABLE pacote_adicionais DISABLE TRIGGER pacote_adicionais_empresa_trg");
        await db.query(
          `DELETE FROM pacote_adicionais pa
            USING pacotes p, adicionais a
           WHERE pa.pacote_id = p.id
             AND pa.adicional_id = a.id
             AND p.codigo = 'FESTA_LOCAL'
             AND a.codigo = 'SALADA_PREMIUM'
             AND p.empresa_id IS NOT NULL
             AND a.empresa_id IS NULL`,
        );
        const empresaA = await empresa(db, "t040a");
        const pacoteA = await pacote(db, empresaA, "p040a");
        const adicionalNulo = await adicional(db, null, "a040a");
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteA, adicionalNulo],
        );
        let message = "";
        try {
          await db.query(semTransacaoExplicita(readFileSync(migration040, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /040: vínculo incompatível/);
      } finally {
        await db.query("ROLLBACK");
      }
      const vinculo = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pacote_adicionais pa
           JOIN pacotes p ON p.id = pa.pacote_id
           JOIN adicionais a ON a.id = pa.adicional_id
          WHERE p.codigo = 'FESTA_LOCAL'
            AND a.codigo = 'SALADA_PREMIUM'
            AND p.empresa_id IS NOT NULL
            AND a.empresa_id IS NULL`,
      );
      const guardas = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_040_falhar_se_incompativel()') IS NULL AS ok",
      );
      const empresasNovas = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM empresas WHERE codigo ~ '^t040'",
      );
      assert.equal(vinculo.rows[0].n, 0);
      assert.equal(guardas.rows[0].ok, true);
      assert.equal(empresasNovas.rows[0].n, 0);
    });

    await t.test("a guarda da 040, desfeita em seguida, não tolera desencontro", async () => {
      await db.query("BEGIN");
      try {
        await db.query(
          `DELETE FROM pacote_adicionais pa
            USING pacotes p, adicionais a
           WHERE pa.pacote_id = p.id
             AND pa.adicional_id = a.id
             AND p.codigo = 'FESTA_LOCAL'
             AND a.codigo = 'SALADA_PREMIUM'
             AND p.empresa_id IS NOT NULL
             AND a.empresa_id IS NULL`,
        );
        await db.query(semTransacaoExplicita(readFileSync(migration040, "utf8")));
        await db.query("SELECT kidmais_040_falhar_se_incompativel()");
        const empresaA = await empresa(db, "t040c");
        const empresaB = await empresa(db, "t040d");
        const pacoteA = await pacote(db, empresaA, "p040c");
        const pacoteB = await pacote(db, empresaB, "p040d");
        const pacoteNulo = await pacote(db, null, "p040n");
        const pacoteNulo2 = await pacote(db, null, "p040m");
        const adicionalA = await adicional(db, empresaA, "a040c");
        const adicionalNulo = await adicional(db, null, "a040n");
        const adicionalNulo2 = await adicional(db, null, "a040m");
        const tabelaA = await tabela(db, empresaA, "u040c", "2080-01-01", "2080-06-01");
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteA, adicionalA],
        );
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteNulo, adicionalNulo],
        );
        await preco(db, tabelaA, pacoteA);
        await db.query("SELECT kidmais_040_falhar_se_incompativel()");
        await db.query(
          "UPDATE pacotes SET revisao_anterior_id = $2::uuid WHERE id = $1::uuid",
          [pacoteNulo2, pacoteNulo],
        );
        await db.query("ALTER TABLE pacote_adicionais DISABLE TRIGGER pacote_adicionais_empresa_trg");
        await db.query("ALTER TABLE precos_pacote DISABLE TRIGGER precos_pacote_empresa_trg");
        await db.query("SAVEPOINT mistura");
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteA, adicionalNulo2],
        );
        await recusa(db, "SELECT kidmais_040_falhar_se_incompativel()", [], "040:");
        await db.query("ROLLBACK TO SAVEPOINT mistura");
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteNulo, adicionalA],
        );
        await recusa(db, "SELECT kidmais_040_falhar_se_incompativel()", [], "040:");
        await db.query("ROLLBACK TO SAVEPOINT mistura");
        await db.query(
          `INSERT INTO precos_pacote (
             tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario
           ) VALUES ($1::uuid, $2::uuid, 41, 60, 'FIXO', 10.00, 'PADRAO')`,
          [tabelaA, pacoteB],
        );
        await recusa(db, "SELECT kidmais_040_falhar_se_incompativel()", [], "040:");
        await db.query("ROLLBACK TO SAVEPOINT mistura");
        await db.query("ALTER TABLE pacote_adicionais ENABLE TRIGGER pacote_adicionais_empresa_trg");
        await recusa(
          db,
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteA, adicionalNulo],
          "034:",
        );
        const compacta = await db.query<{ id: string }>("SELECT id FROM pacotes WHERE codigo = 'COMPACTA'");
        await recusa(
          db,
          "UPDATE pacotes SET empresa_id = $2::uuid WHERE id = $1::uuid",
          [compacta.rows[0].id, empresaA],
          "036:",
        );
        await db.query(semTransacaoExplicita(readFileSync(down040, "utf8")));
        const ausente = await db.query<{ ok: boolean }>(
          "SELECT to_regprocedure('public.kidmais_040_falhar_se_incompativel()') IS NULL AS ok",
        );
        assert.equal(ausente.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK");
      }
      const vinculo = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pacote_adicionais pa
           JOIN pacotes p ON p.id = pa.pacote_id
           JOIN adicionais a ON a.id = pa.adicional_id
          WHERE p.codigo = 'FESTA_LOCAL'
            AND a.codigo = 'SALADA_PREMIUM'
            AND p.empresa_id IS NOT NULL
            AND a.empresa_id IS NULL`,
      );
      const legado = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL");
      const guarda = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.kidmais_040_falhar_se_incompativel()') IS NULL AS ok",
      );
      assert.equal(vinculo.rows[0].n, 0);
      assert.equal(legado.rows[0].n, 7);
      assert.equal(guarda.rows[0].ok, true);
    });

    await t.test("SQL direto não cruza tenant na revisão e a mesma linhagem passa", async () => {
      await db.query("BEGIN");
      try {
        const empresaA = await empresa(db, "t041a");
        const empresaB = await empresa(db, "t041b");
        const pacoteA = await pacote(db, empresaA, "p041a");
        const pacoteA2 = await pacote(db, empresaA, "p041c");
        const pacoteB = await pacote(db, empresaB, "p041b");
        const pacoteNulo = await pacote(db, null, "p041n");
        const pacoteNulo2 = await pacote(db, null, "p041m");
        await db.query(
          "UPDATE pacotes SET revisao_anterior_id = $2::uuid WHERE id = $1::uuid",
          [pacoteA2, pacoteA],
        );
        await db.query(
          "UPDATE pacotes SET revisao_anterior_id = $2::uuid WHERE id = $1::uuid",
          [pacoteNulo2, pacoteNulo],
        );
        const filho = await pacote(db, empresaA, "p041d");
        await db.query(
          "UPDATE pacotes SET revisao_anterior_id = $2::uuid WHERE id = $1::uuid",
          [filho, pacoteA],
        );
        await recusa(
          db,
          "UPDATE pacotes SET revisao_anterior_id = $2::uuid WHERE id = $1::uuid",
          [pacoteA, pacoteB],
          "041:",
        );
        await recusa(
          db,
          "UPDATE pacotes SET revisao_anterior_id = $2::uuid WHERE id = $1::uuid",
          [pacoteA, pacoteNulo],
          "041:",
        );
        await recusa(
          db,
          "UPDATE pacotes SET revisao_anterior_id = $2::uuid WHERE id = $1::uuid",
          [pacoteNulo, pacoteA],
          "041:",
        );
        await recusa(
          db,
          `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, revisao_anterior_id)
           VALUES ($1::uuid, $2, 'Pacote de teste', 400, true, true, $3::uuid)`,
          [empresaA, codigo("p041e"), pacoteB],
          "041:",
        );
        const mesma = await db.query<{ ok: boolean }>(
          `SELECT bool_and(filho.empresa_id IS NOT DISTINCT FROM pai.empresa_id) AS ok
             FROM pacotes filho
             JOIN pacotes pai ON pai.id = filho.revisao_anterior_id
            WHERE filho.id = ANY($1::uuid[])`,
          [[pacoteA2, pacoteNulo2, filho]],
        );
        assert.equal(mesma.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("a trava da revisão não deixa o cruzamento entrar no intervalo", async () => {
      const empresaA = await empresa(db, "t041f");
      const empresaB = await empresa(db, "t041g");
      const pacoteA = await pacote(db, empresaA, "p041f");
      const pacoteB = await pacote(db, empresaB, "p041g");
      const resultado = await corridaBloqueada(
        "LOCK TABLE public.pacotes IN SHARE ROW EXCLUSIVE MODE",
        async (cliente) => {
          await cliente.query(
            "UPDATE pacotes SET revisao_anterior_id = $2::uuid WHERE id = $1::uuid",
            [pacoteA, pacoteB],
          );
        },
        async () => {
          /* a trava segura a tabela até o commit */
        },
      );
      assert.match(resultado, /041:/);
      const cruzada = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pacotes filho
           JOIN pacotes pai ON pai.id = filho.revisao_anterior_id
          WHERE filho.empresa_id IS DISTINCT FROM pai.empresa_id`,
      );
      assert.equal(cruzada.rows[0].n, 0);
    });

    await t.test("reativar faixas sobrepostas na tabela publicada não confirma as duas", async () => {
      const empresaId = await empresa(db, "t042a");
      const pacoteId = await pacote(db, empresaId, "p042a");
      const tabelaId = await tabela(db, empresaId, "u042a", "2089-01-01", "2089-12-31");
      await precoNaFaixa(db, tabelaId, pacoteId, 20, 30);
      const esquerda = await precoInativo(db, tabelaId, pacoteId, 40, 60);
      const direita = await precoInativo(db, tabelaId, pacoteId, 50, 70);
      await db.query(
        `UPDATE tabelas_preco SET publicada_em = clock_timestamp()
          WHERE id = $1::uuid AND publicada_em IS NULL AND ativa = false`,
        [tabelaId],
      );
      const titular = await abrir();
      const outro = await abrir();
      let corrida: ReturnType<typeof rastrear> | undefined;
      try {
        await titular.query("BEGIN");
        await titular.query("UPDATE precos_pacote SET ativo = true WHERE id = $1::uuid", [esquerda]);
        corrida = rastrear((async () => {
          try {
            await outro.query("BEGIN");
            await outro.query("UPDATE precos_pacote SET ativo = true WHERE id = $1::uuid", [direita]);
            await outro.query("COMMIT");
            return "ok";
          } catch (error) {
            try {
              await outro.query("ROLLBACK");
            } catch {
              /* transação abortada */
            }
            return texto(error);
          }
        })());
        await corrida.aindaEspera();
        const espera = await titular.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM pg_locks
            WHERE locktype = 'advisory'
              AND NOT granted
              AND classid = hashtext('kidmais-037-publicacao')`,
        );
        assert.equal(espera.rows[0].n >= 1, true);
        await titular.query("COMMIT");
        const resultado = await corrida.promessa;
        assert.match(resultado, /042:/);
        const sobre = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM precos_pacote a
             JOIN precos_pacote b
               ON b.tabela_preco_id = a.tabela_preco_id
              AND b.pacote_id = a.pacote_id
              AND b.categoria_horario = a.categoria_horario
              AND b.id > a.id
              AND a.ativo
              AND b.ativo
              AND int4range(a.convidados_min::integer, a.convidados_max::integer, '[]')
                  && int4range(b.convidados_min::integer, b.convidados_max::integer, '[]')
            WHERE a.tabela_preco_id = $1::uuid`,
          [tabelaId],
        );
        const ativos = await db.query<{ esquerda: boolean; direita: boolean }>(
          `SELECT
             bool_or(id = $2::uuid AND ativo) AS esquerda,
             bool_or(id = $3::uuid AND ativo) AS direita
             FROM precos_pacote
            WHERE tabela_preco_id = $1::uuid`,
          [tabelaId, esquerda, direita],
        );
        assert.equal(sobre.rows[0].n, 0);
        assert.equal(ativos.rows[0].esquerda, true);
        assert.equal(ativos.rows[0].direita, false);
      } finally {
        try {
          await titular.query("ROLLBACK");
        } catch {
          /* já confirmada */
        }
        if (corrida) await corrida.promessa.catch(() => undefined);
        await fechar(titular);
        await fechar(outro);
      }
    });

    await t.test("duas reativações sem sobreposição confirmam e outra empresa não espera", async () => {
      const empresaA = await empresa(db, "t042b");
      const empresaB = await empresa(db, "t042c");
      const pacoteA = await pacote(db, empresaA, "p042b");
      const pacoteB = await pacote(db, empresaB, "p042c");
      const tabelaA = await tabela(db, empresaA, "u042b", "2090-01-01", "2090-12-31");
      const tabelaB = await tabela(db, empresaB, "u042c", "2090-01-01", "2090-12-31");
      const ancora = await precoNaFaixa(db, tabelaA, pacoteA, 20, 30);
      const baixa = await precoInativo(db, tabelaA, pacoteA, 80, 90);
      const alta = await precoInativo(db, tabelaA, pacoteA, 100, 110);
      await precoNaFaixa(db, tabelaB, pacoteB, 20, 30);
      const outraFaixa = await precoInativo(db, tabelaB, pacoteB, 40, 50);
      await db.query(
        `UPDATE tabelas_preco SET publicada_em = clock_timestamp()
          WHERE id = ANY($1::uuid[]) AND publicada_em IS NULL AND ativa = false`,
        [[tabelaA, tabelaB]],
      );
      const titular = await abrir();
      const outro = await abrir();
      const notas = await abrir();
      const terceira = await abrir();
      let corrida: ReturnType<typeof rastrear> | undefined;
      try {
        await titular.query("BEGIN");
        await titular.query("UPDATE precos_pacote SET ativo = true WHERE id = $1::uuid", [baixa]);
        corrida = rastrear((async () => {
          try {
            await outro.query("BEGIN");
            await outro.query("UPDATE precos_pacote SET ativo = true WHERE id = $1::uuid", [alta]);
            await outro.query("COMMIT");
            return "ok";
          } catch (error) {
            try {
              await outro.query("ROLLBACK");
            } catch {
              /* transação abortada */
            }
            return texto(error);
          }
        })());
        await corrida.aindaEspera();
        await notas.query("BEGIN");
        await notas.query("SET lock_timeout = '800ms'");
        await notas.query("UPDATE precos_pacote SET observacoes = 'nota operacional' WHERE id = $1::uuid", [ancora]);
        await notas.query("ROLLBACK");
        await terceira.query("BEGIN");
        await terceira.query("SET lock_timeout = '800ms'");
        await terceira.query("UPDATE precos_pacote SET ativo = true WHERE id = $1::uuid", [outraFaixa]);
        await terceira.query("ROLLBACK");
        await titular.query("COMMIT");
        const resultado = await corrida.promessa;
        assert.equal(resultado, "ok");
        const ativos = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM precos_pacote WHERE id = ANY($1::uuid[]) AND ativo",
          [[baixa, alta]],
        );
        const sobre = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM precos_pacote a
             JOIN precos_pacote b
               ON b.tabela_preco_id = a.tabela_preco_id
              AND b.pacote_id = a.pacote_id
              AND b.categoria_horario = a.categoria_horario
              AND b.id > a.id
              AND a.ativo
              AND b.ativo
              AND int4range(a.convidados_min::integer, a.convidados_max::integer, '[]')
                  && int4range(b.convidados_min::integer, b.convidados_max::integer, '[]')
            WHERE a.tabela_preco_id = $1::uuid`,
          [tabelaA],
        );
        assert.equal(ativos.rows[0].n, 2);
        assert.equal(sobre.rows[0].n, 0);
      } finally {
        try {
          await titular.query("ROLLBACK");
        } catch {
          /* já confirmada */
        }
        if (corrida) await corrida.promessa.catch(() => undefined);
        await fechar(titular);
        await fechar(outro);
        await fechar(notas);
        await fechar(terceira);
      }
    });

    await t.test("o rollback da 041 e da 042 desfaz a guarda nova e a transação a devolve", async () => {
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(readFileSync(down042, "utf8")));
        await db.query(semTransacaoExplicita(readFileSync(down041, "utf8")));
        const ausente = await db.query<{ ok: boolean }>(
          `SELECT to_regprocedure('public.kidmais_041_revisao_mesmo_tenant()') IS NULL
              AND to_regprocedure('public.kidmais_042_revalidar_faixa_publicada(uuid,uuid,uuid,text,integer,integer)') IS NULL AS ok`,
        );
        assert.equal(ausente.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK");
      }
      const presente = await db.query<{ ok: boolean }>(
        `SELECT to_regprocedure('public.kidmais_041_revisao_mesmo_tenant()') IS NOT NULL
            AND to_regprocedure('public.kidmais_042_revalidar_faixa_publicada(uuid,uuid,uuid,text,integer,integer)') IS NOT NULL AS ok`,
      );
      assert.equal(presente.rows[0].ok, true);
    });

    await t.test("o legado permanece e a prova não grava empresa nova", async () => {
      const legado = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL");
      const vinculo = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pacote_adicionais pa
           JOIN pacotes p ON p.id = pa.pacote_id
           JOIN adicionais a ON a.id = pa.adicional_id
          WHERE p.codigo = 'FESTA_LOCAL'
            AND a.codigo = 'SALADA_PREMIUM'
            AND p.empresa_id IS NOT NULL
            AND a.empresa_id IS NULL`,
      );
      const salada = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM adicionais WHERE codigo = 'SALADA_PREMIUM' AND empresa_id IS NULL",
      );
      assert.equal(legado.rows[0].n, 7);
      assert.equal(vinculo.rows[0].n, 0);
      assert.equal(salada.rows[0].n, 1);
    });
  } finally {
    try {
      try {
        await db.query("ROLLBACK");
      } catch {
        /* sem transação aberta */
      }
      await apagarEmpresasDeTeste(db);
      const resto = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM empresas WHERE codigo ~ '${empresasDeTeste}'`,
      );
      const legado = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL");
      const gatilhos = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_trigger
          WHERE tgname IN (
            'precos_pacote_tabela_publicada_trg',
            'precos_pacote_tabela_publicada_depois_trg',
            'empresas_guard_trg'
          )
            AND NOT tgisinternal
            AND tgenabled = 'D'`,
      );
      assert.equal(resto.rows[0].n, 0);
      assert.equal(legado.rows[0].n, 7);
      assert.equal(gatilhos.rows[0].n, 0);
    } finally {
      await encerrarDescartavel(db);
    }
  }
});
