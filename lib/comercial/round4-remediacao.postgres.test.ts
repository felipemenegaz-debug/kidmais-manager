import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { gravarFaixasPacote } from "./pacote-precos.ts";
import { salvarPacoteComercial } from "./pacote-comercial.ts";
import { definirCategoriasPacoteAdmin, definirDisponibilidadePacoteAdmin } from "./pacotes-admin.ts";
import { calcularResumoComercial } from "./services/pricing.service.ts";
import { PricingServiceError } from "./services/errors.ts";
import { simularTabelaPublicada } from "./tabelas-preco-admin.ts";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel } from "./postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration048 = resolve(root, "database/migrations/20260927_048_supersessao_tabela_publicada.sql");
const precheck048 = resolve(root, "database/checks/20260927_048_precheck.sql");
const postcheck048 = resolve(root, "database/checks/20260927_048_postcheck.sql");
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
  return {
    empresaId,
    usuarioId: randomUUID(),
    requestId: randomUUID(),
    motivo: "PACOTE_EDITADO",
  };
}

async function empresa(db: Client, nome: string) {
  const criada = await db.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`,
    [codigo("e4"), nome],
  );
  return criada.rows[0].id;
}

async function pacote(db: Client, empresaId: string, nome = "Pacote rodada 4") {
  const criado = await db.query<{ id: string }>(
    `INSERT INTO pacotes (
       empresa_id, codigo, nome, ordem_exibicao, ativo, vigente,
       duracao_minutos, convidados_minimos, convidados_maximos
     ) VALUES ($1::uuid, $2, $3, $4, true, true, 180, 20, 30) RETURNING id`,
    [empresaId, codigo("p4"), nome, 400 + Math.floor(Math.random() * 8000)],
  );
  return criado.rows[0].id;
}

async function tabela(db: Client, empresaId: string) {
  const criada = await db.query<{ id: string }>(
    `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
     VALUES ($1::uuid, $2, 'Tabela rodada 4', CURRENT_DATE, NULL, false)
     RETURNING id`,
    [empresaId, codigo("t4")],
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

async function agendaDoDia(db: Client) {
  const achou = await db.query<{ id: string }>(
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
  if (achou.rows[0]) return achou.rows[0].id;
  const base = await db.query<{ id: string }>(
    "SELECT id FROM configuracao_agenda WHERE ativo ORDER BY codigo LIMIT 1",
  );
  if (!base.rows[0]) throw new Error("sem horário de agenda");
  await db.query(
    `INSERT INTO regras_categoria_horario (dia_semana, configuracao_agenda_id, categoria_horario, vigencia_inicio)
     VALUES (EXTRACT(ISODOW FROM CURRENT_DATE)::smallint, $1::uuid, 'PADRAO', CURRENT_DATE)
     ON CONFLICT (dia_semana, configuracao_agenda_id, vigencia_inicio)
     DO UPDATE SET ativo = true, vigencia_fim = NULL`,
    [base.rows[0].id],
  );
  return base.rows[0].id;
}

async function duasAgendas(db: Client) {
  const agendas = await db.query<{ id: string }>(
    "SELECT id FROM configuracao_agenda WHERE ativo ORDER BY codigo LIMIT 2",
  );
  if (agendas.rows.length >= 2) return [agendas.rows[0].id, agendas.rows[1].id];
  const extra = await db.query<{ id: string }>(
    `INSERT INTO configuracao_agenda (
       codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao
     ) VALUES ($1, 'Noite rodada 4', TIME '18:00', TIME '22:00', 32000) RETURNING id`,
    [codigo("h4")],
  );
  const manha = agendas.rows[0]?.id ?? extra.rows[0].id;
  return [manha, extra.rows[0].id];
}

test("remediação da rodada 4 no postgres descartável", { timeout: 180_000 }, async (t) => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());
    assert.equal(process.env.KIDMAIS_POSTGRES_DESCARTAVEL, "kidmais_pacotes_v1_descartavel");
    assert.equal(process.env.DATABASE_URL, undefined);

    const tem048 = await db.query<{ ok: boolean }>(
      "SELECT to_regprocedure('public.kidmais_048_recusar_ciclo(uuid,uuid)') IS NOT NULL AS ok",
    );
    if (!tem048.rows[0].ok) {
      await db.query(readFileSync(precheck048, "utf8"));
      await db.query(readFileSync(migration048, "utf8"));
      await db.query(readFileSync(postcheck048, "utf8"));
    }
    const tem049 = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgname = 'tabelas_preco_publicacao_trg'
            AND pg_get_triggerdef(oid) ILIKE '%INSERT%'
       ) AS ok`,
    );
    if (!tem049.rows[0].ok) await db.query(readFileSync(migration049, "utf8"));
    const guarda = await db.query<{ ok: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM pg_trigger
            WHERE tgname = 'tabelas_preco_publicacao_trg'
              AND pg_get_triggerdef(oid) ILIKE '%INSERT%'
              AND pg_get_triggerdef(oid) ILIKE '%UPDATE%'
         )
         AND EXISTS (
           SELECT 1 FROM pg_proc
            WHERE proname = 'kidmais_035_preservar_tabela_publicada'
              AND pg_get_functiondef(oid) LIKE '%TG_OP = ''UPDATE''%'
              AND pg_get_functiondef(oid) LIKE '%kidmais_047_lacunas_escopo%'
              AND pg_get_functiondef(oid) LIKE '%substituida_em IS NULL%'
              AND pg_get_functiondef(oid) LIKE '%kidmais_037_trava_publicacao%'
         )
         AND EXISTS (
           SELECT 1 FROM pg_proc
            WHERE proname = 'kidmais_048_preparar_supersessao'
              AND pg_get_functiondef(oid) LIKE '%kidmais-048-supersessao%'
         )
       ) AS ok`,
    );
    assert.equal(guarda.rows[0].ok, true);

    await t.test("contratação usa a sucessora no pacote e nos adicionais", async () => {
      const empresaId = await empresa(db, "Empresa rodada 4 sucessora");
      const pacoteId = await pacote(db, empresaId);
      const atualId = await tabela(db, empresaId);
      const precoId = await preco(db, atualId, pacoteId, "10000.00");
      await escopo(db, atualId, pacoteId);
      const adicionalCodigo = codigo("A4").toUpperCase();
      const categoriaCodigo = codigo("ac");
      const categoriaAdicional = await db.query<{ id: string }>(
        `INSERT INTO adicional_categorias (codigo, nome) VALUES ($1, 'Festa rodada 4') RETURNING id`,
        [categoriaCodigo],
      );
      const adicional = await db.query<{ id: string }>(
        `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao)
         VALUES ($1::uuid, $2, 'Adicional rodada 4', $3, $4::uuid, 'PACOTE', 1) RETURNING id`,
        [empresaId, adicionalCodigo, categoriaCodigo, categoriaAdicional.rows[0].id],
      );
      await db.query(
        `INSERT INTO precos_adicional (tabela_preco_id, adicional_id, convidados_min, convidados_max, valor)
         VALUES ($1::uuid, $2::uuid, 1, NULL, 25)`,
        [atualId, adicional.rows[0].id],
      );
      await db.query(
        `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade) VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
        [pacoteId, adicional.rows[0].id],
      );
      await publicar(db, atualId);
      const agendaId = await agendaDoDia(db);
      await db.query(
        `INSERT INTO regras_disponibilidade_pacote (
           pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio
         ) VALUES (
           $1::uuid, EXTRACT(ISODOW FROM CURRENT_DATE)::smallint, $2::uuid, 'DISPONIVEL', CURRENT_DATE
         )`,
        [pacoteId, agendaId],
      );
      const hoje = (await db.query<{ hoje: string }>("SELECT CURRENT_DATE::text AS hoje")).rows[0].hoje;
      await db.query("BEGIN");
      try {
        await gravarFaixasPacote(executor(db), empresaId, pacoteId, [
          { convidadosMin: 20, convidadosMax: 30, valor: "11000.00" },
        ], { minimo: 20, maximo: 30 }, contexto(empresaId));
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      const vazio = await calcularResumoComercial({
        data: hoje,
        configuracaoAgendaId: agendaId,
        pacoteId,
        convidados: 20,
        adicionais: [],
      }, executor(db));
      const comExtra = await calcularResumoComercial({
        data: hoje,
        configuracaoAgendaId: agendaId,
        pacoteId,
        convidados: 20,
        adicionais: [{ codigo: adicionalCodigo, quantidade: 1 }],
      }, executor(db));
      assert.equal(vazio.adicionais.tabelaPreco.id, vazio.pacote.tabelaPreco.id);
      assert.equal(comExtra.adicionais.tabelaPreco.id, vazio.pacote.tabelaPreco.id);
      assert.notEqual(vazio.pacote.tabelaPreco.id, atualId);
      assert.equal(vazio.adicionais.valorTotal, 0);
      assert.equal(vazio.valorTabelaPacoteAplicado, 11000);
      assert.equal(comExtra.valorAdicionais, 25);
      assert.equal(comExtra.valorTotalTabela, 11025);
      const antigo = await db.query<{ valor: string; substituida: boolean }>(
        `SELECT pp.valor::text AS valor, t.substituida_em IS NOT NULL AS substituida
           FROM precos_pacote pp
           JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
          WHERE pp.id = $1::uuid`,
        [precoId],
      );
      assert.equal(antigo.rows[0].valor, "10000.00");
      assert.equal(antigo.rows[0].substituida, true);
      const simulacao = await simularTabelaPublicada(executor(db), {
        empresaId,
        data: hoje,
        pacoteId,
        convidados: 20,
        categoriaHorario: "GERAL",
        sobConsulta: false,
      });
      assert.deepEqual(simulacao, { tipo: "PRECO", centavos: 1_100_000 });
    });

    await t.test("empresa sem tabela corrente não usa o preço legado", async () => {
      const empresaId = await empresa(db, "Empresa rodada 4 sem tabela");
      const pacoteId = await pacote(db, empresaId);
      const agendaId = await agendaDoDia(db);
      const hoje = (await db.query<{ hoje: string }>("SELECT CURRENT_DATE::text AS hoje")).rows[0].hoje;
      await assert.rejects(
        () => calcularResumoComercial({
          data: hoje,
          configuracaoAgendaId: agendaId,
          pacoteId,
          convidados: 20,
          adicionais: [],
        }, executor(db)),
        (error: unknown) => error instanceof PricingServiceError && error.code === "TABELA_PRECO_NAO_CONFIGURADA",
      );
    });

    await t.test("simulação ignora tabela substituída", async () => {
      const empresaId = await empresa(db, "Empresa rodada 4 simulação");
      const antigoId = await pacote(db, empresaId, "Pacote histórico");
      const outroId = await pacote(db, empresaId, "Pacote da sucessora");
      const anterior = await tabela(db, empresaId);
      await preco(db, anterior, antigoId, "10000.00");
      await escopo(db, anterior, antigoId);
      const sucessora = await tabela(db, empresaId);
      await preco(db, sucessora, outroId, "10.00");
      await escopo(db, sucessora, outroId);
      await publicar(db, anterior);
      await db.query("BEGIN");
      try {
        await db.query(
          `UPDATE tabelas_preco
              SET substituida_por_id = $2::uuid, substituida_em = clock_timestamp()
            WHERE id = $1::uuid`,
          [anterior, sucessora],
        );
        await publicar(db, sucessora);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      const hoje = (await db.query<{ hoje: string }>("SELECT CURRENT_DATE::text AS hoje")).rows[0].hoje;
      const simulacao = await simularTabelaPublicada(executor(db), {
        empresaId,
        data: hoje,
        pacoteId: antigoId,
        convidados: 20,
        categoriaHorario: "GERAL",
        sobConsulta: false,
      });
      assert.deepEqual(simulacao, { tipo: "AUSENTE" });
      const historico = await db.query<{ valor: string }>(
        "SELECT valor::text AS valor FROM precos_pacote WHERE tabela_preco_id = $1::uuid AND pacote_id = $2::uuid",
        [anterior, antigoId],
      );
      assert.equal(historico.rows[0].valor, "10000.00");
    });

    await t.test("revisão só de nome conserva o preço e o rollback desfaz a cópia", async () => {
      const empresaId = await empresa(db, "Empresa rodada 4 revisão");
      const pacoteId = await pacote(db, empresaId, "Nome antigo");
      const tabelaId = await tabela(db, empresaId);
      const precoId = await preco(db, tabelaId, pacoteId, "10000.00");
      await escopo(db, tabelaId, pacoteId);
      await publicar(db, tabelaId);
      const agendaId = await agendaDoDia(db);
      await db.query(
        `INSERT INTO fechamentos (
           data_evento, horario_inicio, horario_fim, configuracao_agenda_id,
           empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
           categoria_horario, categoria_preco_aplicada,
           convidados, convidados_faturados,
           valor_pacote_base, desconto_percentual, valor_desconto_pacote, valor_pacote_aplicado,
           valor_adicionais, valor_tabela, status, origem_fechamento
         ) VALUES (
           CURRENT_DATE, TIME '10:00', TIME '14:00', $1::uuid,
           (SELECT p.empresa_id FROM pacotes p WHERE p.id = $2::uuid), $2::uuid, $3::uuid, $4::uuid,
           'PADRAO', 'PADRAO', 20, 20,
           10000, 0, 0, 10000, 0, 10000, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS'
         )`,
        [agendaId, pacoteId, tabelaId, precoId],
      );
      await db.query("BEGIN");
      let falhou = false;
      try {
        await salvarPacoteComercial(executor(db), {
          id: pacoteId,
          nome: "Nome que não fica",
          descricao: null,
          duracaoMinutos: 180,
          convidadosMinimos: 20,
          convidadosMaximos: 30,
          disponibilidade: [{ dia: 1, horarioId: randomUUID() }],
          faixas: null,
          categorias: [],
        }, contexto(empresaId));
      } catch (error) {
        falhou = true;
        assert.match(texto(error), /horários que o calendário já usa/);
      } finally {
        await db.query("ROLLBACK");
      }
      assert.equal(falhou, true);
      const depoisFalha = await db.query<{ pacotes: number; vigente: boolean; valor: string; substituida: boolean }>(
        `SELECT
           (SELECT count(*)::int FROM pacotes WHERE empresa_id = $1::uuid) AS pacotes,
           p.vigente,
           pp.valor::text AS valor,
           t.substituida_em IS NOT NULL AS substituida
         FROM pacotes p
         JOIN precos_pacote pp ON pp.id = $2::uuid
         JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
        WHERE p.id = $3::uuid`,
        [empresaId, precoId, pacoteId],
      );
      assert.equal(depoisFalha.rows[0].pacotes, 1);
      assert.equal(depoisFalha.rows[0].vigente, true);
      assert.equal(depoisFalha.rows[0].valor, "10000.00");
      assert.equal(depoisFalha.rows[0].substituida, false);

      await db.query("BEGIN");
      try {
        await salvarPacoteComercial(executor(db), {
          id: pacoteId,
          nome: "Nome novo",
          descricao: null,
          duracaoMinutos: 180,
          convidadosMinimos: 20,
          convidadosMaximos: 30,
          disponibilidade: [{ dia: 1, horarioId: agendaId }],
          faixas: null,
          categorias: [],
        }, contexto(empresaId));
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      const revisao = await db.query<{ id: string; valor: string }>(
        `SELECT p.id, pp.valor::text AS valor
           FROM pacotes p
           JOIN precos_pacote pp ON pp.pacote_id = p.id AND pp.ativo
           JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
          WHERE p.empresa_id = $1::uuid
            AND p.vigente
            AND p.nome = 'Nome novo'
            AND t.publicada_em IS NOT NULL
            AND t.substituida_em IS NULL`,
        [empresaId],
      );
      assert.equal(revisao.rows.length, 1);
      assert.equal(revisao.rows[0].valor, "10000.00");
      assert.notEqual(revisao.rows[0].id, pacoteId);
      const origem = await db.query<{ vigente: boolean; valor: string }>(
        `SELECT p.vigente, pp.valor::text AS valor
           FROM pacotes p
           JOIN precos_pacote pp ON pp.id = $2::uuid
          WHERE p.id = $1::uuid`,
        [pacoteId, precoId],
      );
      assert.equal(origem.rows[0].vigente, false);
      assert.equal(origem.rows[0].valor, "10000.00");
    });

    await t.test("down concorrente não apaga a supersessão nem a guarda", async () => {
      const empresaId = await empresa(db, "Empresa rodada 4 down");
      const pacoteId = await pacote(db, empresaId);
      const anterior = await tabela(db, empresaId);
      await preco(db, anterior, pacoteId, "10000.00");
      await escopo(db, anterior, pacoteId);
      await publicar(db, anterior);
      const sucessora = await tabela(db, empresaId);
      const outro = await conectarDescartavel({ travar: false });
      const b = outro as unknown as Client;
      try {
        await db.query("BEGIN");
        await db.query("SELECT pg_advisory_xact_lock(hashtext('kidmais-048-supersessao'))");
        await b.query("BEGIN");
        await b.query("SET lock_timeout = '1500ms'");
        let bloqueou = "";
        try {
          await b.query(
            `UPDATE tabelas_preco
                SET substituida_por_id = $2::uuid, substituida_em = clock_timestamp()
              WHERE id = $1::uuid`,
            [anterior, sucessora],
          );
          bloqueou = "passou";
        } catch (error) {
          bloqueou = texto(error);
        }
        const vista = await db.query<{ limpa: boolean }>(
          "SELECT substituida_em IS NULL AS limpa FROM tabelas_preco WHERE id = $1::uuid",
          [anterior],
        );
        assert.match(bloqueou, /lock timeout|tempo limite/i);
        assert.equal(vista.rows[0].limpa, true);
        await b.query("ROLLBACK");
        await db.query("ROLLBACK");
      } finally {
        await encerrarDescartavel(outro);
      }
      const segue = await db.query<{ ok: boolean }>(
        `SELECT (
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'tabelas_preco' AND column_name = 'substituida_em')
           AND to_regprocedure('public.kidmais_048_preparar_supersessao()') IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgname = 'tabelas_preco_publicacao_trg'
                AND pg_get_triggerdef(oid) ILIKE '%INSERT%'
           )
         ) AS ok`,
      );
      assert.equal(segue.rows[0].ok, true);
    });

    await t.test("insert direto já publicado não cria segunda corrente", async () => {
      const empresaId = await empresa(db, "Empresa rodada 4 insert");
      const pacoteId = await pacote(db, empresaId);
      const atualId = await tabela(db, empresaId);
      await preco(db, atualId, pacoteId, "10000.00");
      await escopo(db, atualId, pacoteId);
      await publicar(db, atualId);
      const marca = codigo("mal");
      await db.query("BEGIN");
      let message = "";
      let passou = false;
      try {
        await db.query(
          `INSERT INTO tabelas_preco (
             empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa, publicada_em
           ) VALUES (
             $1::uuid, $2, 'Insert malicioso', CURRENT_DATE, NULL, false, clock_timestamp()
           )`,
          [empresaId, marca],
        );
        passou = true;
        await db.query("COMMIT");
      } catch (error) {
        message = texto(error);
        await db.query("ROLLBACK");
      }
      assert.equal(passou, false);
      assert.match(message, /escopo declarado incompleto|035:|047:/);
      const ficou = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tabelas_preco WHERE codigo = $1",
        [marca],
      );
      const correntes = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM tabelas_preco
          WHERE empresa_id = $1::uuid
            AND publicada_em IS NOT NULL
            AND substituida_em IS NULL`,
        [empresaId],
      );
      assert.equal(ficou.rows[0].n, 0);
      assert.equal(correntes.rows[0].n, 1);
    });

    await t.test("disponibilidade guarda o par real e categoria sem itens aceita todos", async () => {
      const empresaId = await empresa(db, "Empresa rodada 4 pares");
      const pacoteId = await pacote(db, empresaId);
      const [manha, noite] = await duasAgendas(db);
      await definirDisponibilidadePacoteAdmin(executor(db), pacoteId, {
        disponibilidade: [
          { dia: 1, horarioId: manha },
          { dia: 6, horarioId: noite },
        ],
      }, contexto(empresaId));
      const pares = await db.query<{ dia: number; horario: string }>(
        `SELECT dia_semana AS dia, configuracao_agenda_id AS horario
           FROM regras_disponibilidade_pacote
          WHERE pacote_id = $1::uuid AND ativo
          ORDER BY dia_semana`,
        [pacoteId],
      );
      assert.deepEqual(pares.rows.map((par) => ({ dia: Number(par.dia), horario: par.horario })), [
        { dia: 1, horario: manha },
        { dia: 6, horario: noite },
      ]);
      const categoria = await db.query<{ id: string }>(
        `INSERT INTO buffet_categorias (codigo, nome) VALUES ($1, 'Categoria rodada 4') RETURNING id`,
        [codigo("c4")],
      );
      await db.query(
        `INSERT INTO buffet_itens (categoria_id, codigo, nome) VALUES ($1::uuid, 'item', 'Item ativo')`,
        [categoria.rows[0].id],
      );
      await definirCategoriasPacoteAdmin(
        executor(db),
        pacoteId,
        [{ categoriaId: categoria.rows[0].id, escolhas: 1 }],
        contexto(empresaId),
      );
      const modo = await db.query<{ modo: string; itens: number }>(
        `SELECT c.modo_itens AS modo,
                (SELECT count(*)::int FROM pacote_buffet_itens i
                  WHERE i.pacote_id = c.pacote_id AND i.categoria_id = c.categoria_id) AS itens
           FROM pacote_buffet_categorias c
          WHERE c.pacote_id = $1::uuid AND c.categoria_id = $2::uuid AND c.ativo`,
        [pacoteId, categoria.rows[0].id],
      );
      assert.equal(modo.rows[0].modo, "TODOS_ATIVOS");
      assert.equal(modo.rows[0].itens, 0);
      const possiveis = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM buffet_itens WHERE categoria_id = $1::uuid AND ativo",
        [categoria.rows[0].id],
      );
      assert.equal(possiveis.rows[0].n, 1);
    });
  } finally {
    await encerrarDescartavel(client);
  }
});
