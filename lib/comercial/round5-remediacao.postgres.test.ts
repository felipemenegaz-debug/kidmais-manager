import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { salvarPacoteComercial } from "./pacote-comercial.ts";
import { calcularResumoComercial, precificarAdicionais, precificarPacote } from "./services/pricing.service.ts";
import { PricingServiceError } from "./services/errors.ts";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "./postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const down048 = resolve(root, "database/rollback/20260927_048_supersessao_tabela_publicada_down.sql");
const down049 = resolve(root, "database/rollback/20260927_049_publicacao_insert_e_trava_down.sql");
const migration049 = resolve(root, "database/migrations/20260927_049_publicacao_insert_e_trava.sql");

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

function contexto(empresaId: string) {
  return { empresaId, usuarioId: randomUUID(), requestId: randomUUID(), motivo: "PACOTE_EDITADO" };
}

async function empresa(db: Client, nome: string) {
  const criada = await db.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`,
    [codigo("e5"), nome],
  );
  return criada.rows[0].id;
}

async function pacote(db: Client, empresaId: string, nome = "Pacote rodada 5") {
  const criado = await db.query<{ id: string }>(
    `INSERT INTO pacotes (
       empresa_id, codigo, nome, ordem_exibicao, ativo, vigente,
       duracao_minutos, convidados_minimos, convidados_maximos
     ) VALUES ($1::uuid, $2, $3, $4, true, true, 180, 20, 30) RETURNING id`,
    [empresaId, codigo("p5"), nome, 500 + Math.floor(Math.random() * 8000)],
  );
  return criado.rows[0].id;
}

async function tabela(db: Client, empresaId: string) {
  const criada = await db.query<{ id: string }>(
    `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
     VALUES ($1::uuid, $2, 'Tabela rodada 5', CURRENT_DATE, NULL, false)
     RETURNING id`,
    [empresaId, codigo("t5")],
  );
  return criada.rows[0].id;
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

async function agenda(db: Client) {
  const achou = await db.query<{ id: string }>(
    "SELECT id FROM configuracao_agenda WHERE ativo ORDER BY codigo LIMIT 1",
  );
  if (!achou.rows[0]) throw new Error("sem horário de agenda");
  return achou.rows[0].id;
}

async function usar(db: Client, empresaId: string, nome: string, valor: string) {
  const empresaIdLocal = empresaId;
  const pacoteId = await pacote(db, empresaIdLocal, nome);
  const tabelaId = await tabela(db, empresaIdLocal);
  const precoId = await preco(db, tabelaId, pacoteId, valor);
  await escopo(db, tabelaId, pacoteId);
  await publicar(db, tabelaId);
  const agendaId = await agenda(db);
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
       $5, 0, 0, $5, 0, $5, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS'
     ) RETURNING id`,
    [agendaId, pacoteId, tabelaId, precoId, valor],
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
       $1::uuid, 1, $2::uuid, 'P5', $3,
       $4::uuid, 'T5', 'Tabela rodada 5', $5::uuid,
       'FIXO', 20, 30, 'GERAL',
       $6, 'PADRAO', 'GERAL', 20, 20,
       0, $6, 0, $6, 0, $6
     ) RETURNING id`,
    [fechamento.rows[0].id, pacoteId, nome, tabelaId, precoId, valor],
  );
  return { empresaId, pacoteId, tabelaId, precoId, agendaId, fechamentoId: fechamento.rows[0].id, fotoId: foto.rows[0].id };
}

async function salvar(db: Client, base: Awaited<ReturnType<typeof usar>>, nome: string, faixas: Array<{ convidadosMin: number; convidadosMax: number; valor: string }> | null) {
  return salvarPacoteComercial(executor(db), {
    id: base.pacoteId,
    nome,
    descricao: null,
    duracaoMinutos: 180,
    convidadosMinimos: 20,
    convidadosMaximos: 30,
    disponibilidade: [],
    faixas,
    categorias: [],
  }, contexto(base.empresaId));
}

async function cadeia(db: Client, empresaId: string) {
  return db.query<{ id: string; substituida_por_id: string | null; corrente: boolean }>(
    `SELECT id, substituida_por_id, substituida_em IS NULL AND publicada_em IS NOT NULL AS corrente
       FROM tabelas_preco
      WHERE empresa_id = $1::uuid
      ORDER BY criado_em`,
    [empresaId],
  );
}

test("remediação da rodada 5 no postgres descartável", { timeout: 180_000 }, async (t) => {
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

    await t.test("pacote utilizado muda o preço em uma única supersessão A para B", async () => {
      const empresaId = await empresa(db, "Empresa rodada 5 preço");
      const base = await usar(db, empresaId, "Festa antiga", "10000.00");
      const antes = await cadeia(db, empresaId);
      await db.query("BEGIN");
      try {
        const salvo = await salvar(db, base, "Festa nova", [{ convidadosMin: 20, convidadosMax: 30, valor: "12000.00" }]);
        await db.query("COMMIT");
        assert.notEqual(salvo.pacote.id, base.pacoteId);
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      const depois = await cadeia(db, empresaId);
      assert.equal(depois.rows.length, antes.rows.length + 1);
      const substituidas = depois.rows.filter((linha) => linha.substituida_por_id);
      const correntes = depois.rows.filter((linha) => linha.corrente);
      assert.equal(substituidas.length, 1);
      assert.equal(correntes.length, 1);
      assert.equal(substituidas[0].id, base.tabelaId);
      assert.equal(substituidas[0].substituida_por_id, correntes[0].id);
      const novo = await db.query<{ valor: string; vigente: boolean }>(
        `SELECT pp.valor::text AS valor, p.vigente
           FROM pacotes p
           JOIN precos_pacote pp ON pp.pacote_id = p.id
           JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
          WHERE p.empresa_id = $1::uuid AND p.vigente AND t.substituida_em IS NULL`,
        [empresaId],
      );
      assert.equal(novo.rows.length, 1);
      assert.equal(novo.rows[0].valor, "12000.00");
      assert.equal(novo.rows[0].vigente, true);
      const historico = await db.query<{ valor: string; foto: string; contrato: string }>(
        `SELECT pp.valor::text AS valor, s.valor_linha::text AS foto, f.preco_pacote_id::text AS contrato
           FROM precos_pacote pp
           JOIN fechamento_pacote_snapshots s ON s.id = $2::uuid
           JOIN fechamentos f ON f.id = $3::uuid
          WHERE pp.id = $1::uuid`,
        [base.precoId, base.fotoId, base.fechamentoId],
      );
      assert.equal(historico.rows[0].valor, "10000.00");
      assert.equal(historico.rows[0].foto, "10000.00");
      assert.equal(historico.rows[0].contrato, base.precoId);
      const antiga = await db.query<{ vigente: boolean }>("SELECT vigente FROM pacotes WHERE id = $1::uuid", [base.pacoteId]);
      assert.equal(antiga.rows[0].vigente, false);
    });

    await t.test("alterar só o nome preserva o preço na mesma sucessora", async () => {
      const empresaId = await empresa(db, "Empresa rodada 5 nome");
      const base = await usar(db, empresaId, "Nome antigo", "10000.00");
      await db.query("BEGIN");
      try {
        await salvar(db, base, "Nome novo", null);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      const depois = await cadeia(db, empresaId);
      assert.equal(depois.rows.filter((linha) => linha.substituida_por_id).length, 1);
      assert.equal(depois.rows.filter((linha) => linha.corrente).length, 1);
      const precoNovo = await db.query<{ valor: string }>(
        `SELECT pp.valor::text AS valor
           FROM pacotes p
           JOIN precos_pacote pp ON pp.pacote_id = p.id
           JOIN tabelas_preco t ON t.id = pp.tabela_preco_id AND t.substituida_em IS NULL
          WHERE p.empresa_id = $1::uuid AND p.vigente`,
        [empresaId],
      );
      assert.equal(precoNovo.rows[0].valor, "10000.00");
    });

    await t.test("sem preço corrente a revisão não é promovida", async () => {
      const empresaId = await empresa(db, "Empresa rodada 5 sem preço");
      const base = await usar(db, empresaId, "Sem preço corrente", "10000.00");
      const outroId = await pacote(db, empresaId, "Outro pacote");
      const sucessora = await tabela(db, empresaId);
      await preco(db, sucessora, outroId, "10.00");
      await escopo(db, sucessora, outroId);
      await db.query("BEGIN");
      try {
        await db.query(
          `UPDATE tabelas_preco SET substituida_por_id = $2::uuid, substituida_em = clock_timestamp() WHERE id = $1::uuid`,
          [base.tabelaId, sucessora],
        );
        await publicar(db, sucessora);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      const tabelasAntes = await cadeia(db, empresaId);
      await db.query("BEGIN");
      let falhou = false;
      try {
        await salvar(db, base, "Nome que não fica", null);
      } catch (error) {
        falhou = true;
        assert.equal(texto(error), "Não foi possível preservar o preço atual deste pacote. Nenhuma alteração foi salva.");
      } finally {
        await db.query("ROLLBACK");
      }
      assert.equal(falhou, true);
      const vigente = await db.query<{ vigente: boolean; pacotes: number }>(
        `SELECT p.vigente, (SELECT count(*)::int FROM pacotes WHERE empresa_id = $1::uuid AND codigo = p.codigo) AS pacotes
           FROM pacotes p WHERE p.id = $2::uuid`,
        [empresaId, base.pacoteId],
      );
      assert.equal(vigente.rows[0].vigente, true);
      assert.equal(vigente.rows[0].pacotes, 1);
      const tabelasDepois = await cadeia(db, empresaId);
      assert.equal(tabelasDepois.rows.length, tabelasAntes.rows.length);
    });

    await t.test("falha ao aplicar o preço desfaz a revisão inteira", async () => {
      const empresaId = await empresa(db, "Empresa rodada 5 rollback");
      const base = await usar(db, empresaId, "Rollback", "10000.00");
      const tabelasAntes = (await cadeia(db, empresaId)).rows.length;
      await db.query("BEGIN");
      let falhou = false;
      try {
        await salvar(db, base, "Não fica", [
          { convidadosMin: 20, convidadosMax: 25, valor: "11000.00" },
          { convidadosMin: 24, convidadosMax: 30, valor: "12000.00" },
        ]);
      } catch (error) {
        falhou = true;
        assert.match(texto(error), /não podem se sobrepor/);
      } finally {
        await db.query("ROLLBACK");
      }
      assert.equal(falhou, true);
      const estado = await db.query<{ vigente: boolean; pacotes: number; tabelas: number }>(
        `SELECT p.vigente,
                (SELECT count(*)::int FROM pacotes WHERE empresa_id = $1::uuid) AS pacotes,
                (SELECT count(*)::int FROM tabelas_preco WHERE empresa_id = $1::uuid) AS tabelas
           FROM pacotes p WHERE p.id = $2::uuid`,
        [empresaId, base.pacoteId],
      );
      assert.equal(estado.rows[0].vigente, true);
      assert.equal(estado.rows[0].pacotes, 1);
      assert.equal(estado.rows[0].tabelas, tabelasAntes);
    });

    await t.test("o cálculo fica na tabela fixada e a operação seguinte usa a sucessora", async () => {
      const empresaId = await empresa(db, "Empresa rodada 5 pin");
      const pacoteId = await pacote(db, empresaId);
      const atualId = await tabela(db, empresaId);
      await preco(db, atualId, pacoteId, "10000.00");
      await escopo(db, atualId, pacoteId);
      await publicar(db, atualId);
      const doDia = await db.query<{ id: string }>(
        `SELECT c.id
           FROM configuracao_agenda c
           JOIN regras_categoria_horario r ON r.configuracao_agenda_id = c.id
          WHERE c.ativo AND r.ativo
            AND r.dia_semana = EXTRACT(ISODOW FROM CURRENT_DATE)::smallint
            AND r.vigencia_inicio <= CURRENT_DATE
            AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= CURRENT_DATE)
          ORDER BY c.codigo
          LIMIT 1`,
      );
      if (!doDia.rows[0]) throw new Error("sem categoria comercial para hoje");
      const agendaId = doDia.rows[0].id;
      await db.query(
        `INSERT INTO regras_disponibilidade_pacote (
           pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio
         ) VALUES ($1::uuid, EXTRACT(ISODOW FROM CURRENT_DATE)::smallint, $2::uuid, 'DISPONIVEL', CURRENT_DATE)`,
        [pacoteId, agendaId],
      );
      const hoje = (await db.query<{ hoje: string }>("SELECT CURRENT_DATE::text AS hoje")).rows[0].hoje;
      const entrada = { data: hoje, configuracaoAgendaId: agendaId, pacoteId, convidados: 20 };
      const primeiro = await precificarPacote({ ...entrada, tabelaPrecoId: atualId }, executor(db));
      const outro = await conectarDescartavel({ travar: false });
      try {
        const sucessora = await tabela(outro as unknown as Client, empresaId);
        await preco(outro as unknown as Client, sucessora, pacoteId, "13000.00");
        await escopo(outro as unknown as Client, sucessora, pacoteId);
        await outro.query("BEGIN");
        await outro.query(
          `UPDATE tabelas_preco SET substituida_por_id = $2::uuid, substituida_em = clock_timestamp() WHERE id = $1::uuid`,
          [atualId, sucessora],
        );
        await publicar(outro as unknown as Client, sucessora);
        await outro.query("COMMIT");
        await assert.rejects(
          () => precificarAdicionais({
            data: hoje, convidados: 20, itens: [], empresaId, tabelaPrecoId: atualId,
          }, executor(db)),
          (error: unknown) => error instanceof PricingServiceError && error.code === "TABELA_PRECO_NAO_CONFIGURADA",
        );
        assert.equal(primeiro.tabelaPreco.id, atualId);
        const seguinte = await calcularResumoComercial({ ...entrada, adicionais: [] }, executor(db));
        assert.equal(seguinte.pacote.tabelaPreco.id, sucessora);
        assert.equal(seguinte.adicionais.tabelaPreco.id, sucessora);
        assert.equal(seguinte.valorTabelaPacoteAplicado, 13000);
      } finally {
        await encerrarDescartavel(outro, false);
      }
    });

    await t.test("id explícito só é aceito quando é a tabela corrente", async () => {
      const empresaId = await empresa(db, "Empresa rodada 5 id");
      const outraEmpresa = await empresa(db, "Empresa rodada 5 outra");
      const pacoteId = await pacote(db, empresaId);
      const corrente = await tabela(db, empresaId);
      await db.query(`UPDATE tabelas_preco SET vigencia_fim = CURRENT_DATE WHERE id = $1::uuid`, [corrente]);
      await preco(db, corrente, pacoteId, "10000.00");
      await escopo(db, corrente, pacoteId);
      await publicar(db, corrente);
      const rascunho = await tabela(db, empresaId);
      const futura = (await db.query<{ id: string }>(
        `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
         VALUES ($1::uuid, $2, 'Tabela futura', CURRENT_DATE + 1, CURRENT_DATE + 10, false)
         RETURNING id`,
        [empresaId, codigo("tf")],
      )).rows[0].id;
      await preco(db, futura, pacoteId, "10.00");
      await escopo(db, futura, pacoteId);
      await publicar(db, futura);
      const pacoteAlheio = await pacote(db, outraEmpresa);
      const alheia = await tabela(db, outraEmpresa);
      await preco(db, alheia, pacoteAlheio, "10.00");
      await escopo(db, alheia, pacoteAlheio);
      await publicar(db, alheia);
      const hoje = (await db.query<{ hoje: string }>("SELECT CURRENT_DATE::text AS hoje")).rows[0].hoje;
      const recusa = (tabelaPrecoId: string, empresaDaConsulta: string | null = empresaId) => assert.rejects(
        () => precificarAdicionais({
          data: hoje,
          convidados: 20,
          itens: [],
          ...(empresaDaConsulta ? { empresaId: empresaDaConsulta } : {}),
          tabelaPrecoId,
        }, executor(db)),
        (error: unknown) => error instanceof PricingServiceError && error.code === "TABELA_PRECO_NAO_CONFIGURADA",
      );
      await recusa(rascunho);
      await recusa(futura);
      await recusa(alheia);
      await recusa(corrente, null);
      const aceita = await precificarAdicionais({
        data: hoje, convidados: 20, itens: [], empresaId, tabelaPrecoId: corrente,
      }, executor(db));
      const semId = await precificarAdicionais({
        data: hoje, convidados: 20, itens: [], empresaId,
      }, executor(db));
      assert.equal(aceita.tabelaPreco.id, corrente);
      assert.equal(semId.tabelaPreco.id, corrente);
      assert.equal(semId.valorTotal, 0);
      const sucessora = await tabela(db, empresaId);
      await db.query(
        `UPDATE tabelas_preco SET vigencia_inicio = CURRENT_DATE, vigencia_fim = CURRENT_DATE WHERE id = $1::uuid`,
        [sucessora],
      );
      await preco(db, sucessora, pacoteId, "11000.00");
      await escopo(db, sucessora, pacoteId);
      await db.query("BEGIN");
      try {
        await db.query(
          `UPDATE tabelas_preco SET substituida_por_id = $2::uuid, substituida_em = clock_timestamp() WHERE id = $1::uuid`,
          [corrente, sucessora],
        );
        await publicar(db, sucessora);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      await recusa(corrente);
      const nova = await precificarAdicionais({
        data: hoje, convidados: 20, itens: [], empresaId, tabelaPrecoId: sucessora,
      }, executor(db));
      assert.equal(nova.tabelaPreco.id, sucessora);
    });

    await t.test("down 049 e depois down 048 não deixam a supersessão passar", async () => {
      const guarda = await db.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_trigger
            WHERE tgname = 'tabelas_preco_publicacao_trg'
              AND pg_get_triggerdef(oid) ILIKE '%INSERT%'
         ) AS ok`,
      );
      assert.equal(guarda.rows[0].ok, true);
      await db.query(readFileSync(down049, "utf8"));
      const sem049 = await db.query<{ insert: boolean; trava049: boolean }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgname = 'tabelas_preco_publicacao_trg'
                AND pg_get_triggerdef(oid) ILIKE '%INSERT%'
           ) AS insert,
           EXISTS (
             SELECT 1 FROM pg_proc
              WHERE proname = 'kidmais_048_preparar_supersessao'
                AND pg_get_functiondef(oid) LIKE '%kidmais-048-supersessao%'
           ) AS trava049`,
      );
      assert.equal(sem049.rows[0].insert, false);
      assert.equal(sem049.rows[0].trava049, false);
      const corrente = await db.query<{ id: string }>(
        `SELECT id FROM tabelas_preco
          WHERE publicada_em IS NOT NULL AND substituida_em IS NULL
          LIMIT 1`,
      );
      assert.ok(corrente.rows[0]);
      const outro = await conectarDescartavel({ travar: false });
      try {
        await db.query("BEGIN");
        await db.query("SELECT pg_advisory_xact_lock(hashtext('kidmais-048-down'))");
        await db.query("LOCK TABLE public.tabelas_preco IN SHARE ROW EXCLUSIVE MODE");
        await outro.query("SET lock_timeout = '1500ms'");
        await assert.rejects(
          () => outro.query(
            `UPDATE tabelas_preco
                SET substituida_em = clock_timestamp(),
                    substituida_por_id = id
              WHERE id = $1::uuid`,
            [corrente.rows[0].id],
          ),
          (error: unknown) => /lock timeout|tempo limite/i.test(texto(error)),
        );
        await assert.rejects(
          () => db.query(semTransacaoExplicita(readFileSync(down048, "utf8"))),
          (error: unknown) => /já existe supersessão/.test(texto(error)),
        );
      } finally {
        await db.query("ROLLBACK");
        await encerrarDescartavel(outro, false);
        const falta = await db.query<{ ok: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgname = 'tabelas_preco_publicacao_trg'
                AND pg_get_triggerdef(oid) ILIKE '%INSERT%'
           ) AS ok`,
        );
        if (!falta.rows[0].ok) await db.query(readFileSync(migration049, "utf8"));
      }
      const restaurada = await db.query<{ ok: boolean; coluna: boolean }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgname = 'tabelas_preco_publicacao_trg'
                AND pg_get_triggerdef(oid) ILIKE '%INSERT%'
           ) AS ok,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'tabelas_preco' AND column_name = 'substituida_em'
           ) AS coluna`,
      );
      assert.equal(restaurada.rows[0].ok, true);
      assert.equal(restaurada.rows[0].coluna, true);
      const intacta = await db.query<{ substituida: boolean }>(
        "SELECT substituida_em IS NOT NULL AS substituida FROM tabelas_preco WHERE id = $1::uuid",
        [corrente.rows[0].id],
      );
      assert.equal(intacta.rows[0].substituida, false);
    });
  } finally {
    await encerrarDescartavel(client);
  }
});
