import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { estruturaFesta019Sql } from "../festas/estrutura-019.ts";
import { cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { consultarDisponibilidadeData } from "../disponibilidade/services/availability.service.ts";
import { verificarConflitoAgendaParaConfirmacao } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { escolherSalao, escolherSalaoDaFesta } from "./salao-festa.ts";
import { revalidarHorarioSelecionado } from "../disponibilidade/services/availability.service.ts";

/**
 * 094 no PostgreSQL DESCARTÁVEL (modelo 093 + 094 aplicada aqui): a regra de conflito do banco (gatilhos da 019/062
 * com o corpo da 094) e o cálculo em TypeScript passam a respeitar a configuração da 093 — capacidade por horário,
 * horários diferentes sobrepostos em conflito, limite do dia, capacidade por salão com intervalo e escolha automática
 * do salão — e a empresa sem configuração continua com a regra de antes. Módulo Festa válido com o conjunto 094.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
let a: Client;
let tx: DbExecutor;
const D = dia(40);

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

async function horario(c: Cenario, codigo: string, inicio: string, fim: string, capacidade = 1) {
  return id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ($1, $1, $2, $3, 0, 30, 1, $4::uuid, $5) RETURNING id`, [codigo, inicio, fim, c.empresa, capacidade]);
}

async function configurar(c: Cenario, tipo: "POR_HORARIO" | "POR_SALAO", limite: number | null, intervalo: number) {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', $2, $3, $4, $5::uuid)`, [c.empresa, tipo, limite, intervalo, c.usuario]);
}

/** Festa gravada e confirmada numa transação: os gatilhos diferidos conferem a agenda no COMMIT. */
async function confirmada(c: Cenario, cfg: string, inicio: string, fim: string, salao: string | null = null) {
  await a.query("BEGIN");
  try {
    const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
        SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $7::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid RETURNING fechamentos.id`,
      [D, inicio, fim, cfg, c.empresa, c.pacote, salao]);
    await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    await a.query("COMMIT");
    return f;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  }
}

test.before(async () => {
  a = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await a.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } };
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("094: precheck, migration e postcheck; segunda aplicação recusada; módulo Festa válido com o conjunto 094", async () => {
  await a.query(arquivo("database/checks/20261022_094_precheck.sql"));
  await a.query(arquivo("database/migrations/20261022_094_agenda_capacidade.sql"));
  await a.query(arquivo("database/checks/20261022_094_postcheck.sql"));
  await recusa(a.query(arquivo("database/migrations/20261022_094_agenda_capacidade.sql")), /094: precheck falhou/);
  await a.query("ROLLBACK").catch(() => undefined);
  assert.equal((await a.query<{ valida: boolean }>(estruturaFesta019Sql)).rows[0].valida, true);
});

test("sem configuração: a regra de antes (qualquer sobreposição é conflito)", async () => {
  const c = await cenario(a, 0);
  const cfg = await horario(c, "TARDE_SEM", "15:00", "19:00", 3);
  await confirmada(c, cfg, "15:00", "19:00");
  await recusa(confirmada(c, cfg, "15:00", "19:00"), /Conflito/);
});

test("por horário: capacidade no mesmo horário, horários diferentes sobrepostos em conflito, limite do dia", async () => {
  const c = await cenario(a, 0);
  await configurar(c, "POR_HORARIO", 3, 60);
  const tarde = await horario(c, "TARDE", "15:00", "19:00", 2);
  const noite = await horario(c, "NOITE", "18:00", "22:00", 2);
  const manha = await horario(c, "MANHA", "08:00", "10:00", 2);
  await confirmada(c, tarde, "15:00", "19:00");
  await confirmada(c, tarde, "15:00", "19:00");
  await recusa(confirmada(c, tarde, "15:00", "19:00"), /Conflito/);
  await recusa(confirmada(c, noite, "18:00", "22:00"), /Conflito/);
  await confirmada(c, manha, "08:00", "10:00");
  await recusa(confirmada(c, manha, "08:00", "10:00"), /Conflito/, );
  // O cálculo em TypeScript enxerga o mesmo: tarde lotada; o dia chegou ao limite (3).
  const agenda = await consultarDisponibilidadeData(D, tx, undefined, { empresaId: c.empresa, estabelecimentoId: null });
  assert.equal(agenda.periodos.find((p) => p.codigo === "TARDE")?.status, "INDISPONIVEL");
  assert.equal(agenda.periodos.every((p) => p.status === "INDISPONIVEL"), true, "limite do dia");
});

test("por salão: só o mesmo salão conflita, com o intervalo; o sistema escolhe o salão livre", async () => {
  const c = await cenario(a, 0);
  await configurar(c, "POR_SALAO", null, 60);
  const s1 = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem) VALUES ($1::uuid, 'Principal', 1) RETURNING id`, [c.empresa]);
  const s2 = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem) VALUES ($1::uuid, 'Kids', 2) RETURNING id`, [c.empresa]);
  const tarde = await horario(c, "TARDE_S", "15:00", "19:00", 1);
  await confirmada(c, tarde, "15:00", "19:00", s1);
  await confirmada(c, tarde, "15:00", "19:00", s2);
  await recusa(confirmada(c, tarde, "19:30", "21:00", s1), /Conflito/);
  await confirmada(c, tarde, "20:00", "22:00", s1);
  // Salão de outra empresa é recusado pela guarda.
  const outra = await cenario(a, 0);
  const cfgOutra = await horario(outra, "TARDE_O", "15:00", "19:00", 1);
  await recusa(confirmada(outra, cfgOutra, "08:00", "09:00", s1), /094: salão de outra empresa/);
  // Escolha automática: 15–19 sem salão livre; 08–10 recebe o primeiro (Principal).
  const proposta = async (inicio: string, fim: string) => id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
      SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid RETURNING fechamentos.id`,
    [D, inicio, fim, tarde, c.empresa, c.pacote]);
  const cheia = await proposta("15:00", "19:00");
  assert.equal(await escolherSalaoDaFesta(tx, cheia), null);
  const conflito = await verificarConflitoAgendaParaConfirmacao({ fechamentoId: cheia, data: D, horarioInicio: "15:00", horarioFim: "19:00" }, tx);
  assert.equal(conflito.fechamentoConfirmado, true, "sem salão livre, a confirmação acusa conflito");
  const livre = await proposta("08:00", "10:00");
  assert.equal(await escolherSalaoDaFesta(tx, livre), s1);
  assert.equal((await verificarConflitoAgendaParaConfirmacao({ fechamentoId: livre, data: D, horarioInicio: "08:00", horarioFim: "10:00" }, tx)).fechamentoConfirmado, false);
  // Cálculo em TypeScript: 15–19 sem salão livre.
  const agenda = await consultarDisponibilidadeData(D, tx, undefined, { empresaId: c.empresa, estabelecimentoId: null });
  assert.equal(agenda.periodos.find((p) => p.codigo === "TARDE_S")?.status, "INDISPONIVEL");
});

test("parecer do Astra P1: horário só S1 × pacote só S2 — sem salão possível, a revalidação e a escolha recusam", async () => {
  const c = await cenario(a, 0);
  await configurar(c, "POR_SALAO", null, 0);
  const s1 = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem) VALUES ($1::uuid, 'S1', 1) RETURNING id`, [c.empresa]);
  const s2 = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem) VALUES ($1::uuid, 'S2', 2) RETURNING id`, [c.empresa]);
  const cfg = await horario(c, "TARDE_P1", "15:00", "19:00", 1);
  await a.query(`INSERT INTO configuracao_agenda_saloes (configuracao_agenda_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [cfg, s1]);
  await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [c.pacote, s2]);
  const codigo = (await a.query<{ codigo: string }>(`SELECT codigo FROM pacotes WHERE id = $1::uuid`, [c.pacote])).rows[0].codigo;
  await recusa(revalidarHorarioSelecionado({ data: D, configuracaoId: cfg, inicio: "15:00", fim: "19:00", ajusteMinutos: 0, pacoteCodigo: codigo }, tx,
    { empresaId: c.empresa, estabelecimentoId: null }), /não está mais disponível/);
  const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid RETURNING fechamentos.id`,
    [D, cfg, c.empresa, c.pacote]);
  assert.deepEqual(await escolherSalao(tx, f), { exigido: true, salao: null }, "exigido e sem salão: quem confirma recusa");
});

test("parecer do Astra P2: o destino de uma remarcação não conta a mesma festa duas vezes (contagem por fechamento)", async () => {
  const sql = arquivo("database/migrations/20261022_094_agenda_capacidade.sql");
  assert.ok(sql.includes("RETURN (SELECT count(DISTINCT o.fechamento_id) FROM kidmais094_ocupacoes"));
  const down = arquivo("database/rollback/20261022_094_agenda_capacidade_down.sql");
  assert.ok(down.includes("festas simultâneas no mesmo recurso (incompatíveis com a 062)"));
});

test("rollback da 094 recusado enquanto houver festa com salão", async () => {
  await recusa(a.query(arquivo("database/rollback/20261022_094_agenda_capacidade_down.sql")), /094 rollback: há festas com salão/);
  await a.query("ROLLBACK").catch(() => undefined);
});
