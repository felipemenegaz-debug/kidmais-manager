import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { consultarDisponibilidadeData } from "../disponibilidade/services/availability.service.ts";
import { listarConfiguracoesAgendaAtivas } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import {
  cancelarDesativacao,
  definirSaloesPacote,
  desativarHorarioAPartirDe,
  escoposDaEmpresa,
  lerAgendaEscopo,
  salvarAgendaEscopo,
  type SalvarAgenda,
} from "./configuracao-unidade.ts";

/**
 * 093 no PostgreSQL DESCARTÁVEL (modelo 092 + 093 aplicada aqui): configuração da agenda por escopo (empresa sem
 * unidade agendável), assistente com horários herdados (regras de preço e disponibilidade copiadas), dias da semana e
 * desativação no cálculo, modo livre com o horário técnico por dia, salões só da própria empresa e rollback recusado.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
// Decisão de 25/10/2026: a agenda por salão está escondida; esta prova a exercita liberando-a só aqui.
const PROVA_POR_SALAO = { maisDeUmSalaoLiberada: true };

let client: Client;
let tx: DbExecutor;
const sufixo = randomBytes(3).toString("hex");
let A: string;
let B: string;
let usuario: string;
let pacoteA: string;
const ctx = () => ({ empresaId: A, usuarioId: usuario, requestId: randomUUID() });

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

/** Próxima data (a partir de amanhã) com o dia ISO pedido. */
async function proxima(diaIso: number) {
  const r = await client.query<{ d: string }>(
    `SELECT (CURRENT_DATE + g)::text AS d FROM generate_series(1, 7) g WHERE extract(isodow FROM CURRENT_DATE + g) = $1 LIMIT 1`,
    [diaIso],
  );
  return r.rows[0].d;
}

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

test("093: precheck, migration e postcheck; segunda aplicação é recusada", async () => {
  await client.query(arquivo("database/checks/20261022_093_precheck.sql"));
  await client.query(arquivo("database/migrations/20261022_093_agenda_configuracao_unidade.sql"));
  await client.query(arquivo("database/checks/20261022_093_postcheck.sql"));
  await recusa(client.query(arquivo("database/migrations/20261022_093_agenda_configuracao_unidade.sql")), /093: precheck falhou/);
  await client.query("ROLLBACK").catch(() => undefined);
});

test("fixtures: duas empresas, um usuário e um pacote disponível nos turnos globais", async () => {
  const empresa = async (n: string) => (await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`,
    [`e93${n}${sufixo}`.toLowerCase(), `Buffet 093 ${n}`],
  )).rows[0].id;
  A = await empresa("a");
  B = await empresa("b");
  usuario = (await client.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Ana 093', $2, 'ADMINISTRATIVO', true) RETURNING id::text AS id`,
    [`ana093${sufixo}@exemplo.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`],
  )).rows[0].id;
  pacoteA = (await client.query<{ id: string }>(
    `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos, duracao_minutos)
     VALUES ($1::uuid, $2, 'Pacote 093', 930, true, true, 50, 100, 240) RETURNING id::text AS id`,
    [A, `P93${sufixo}`.toUpperCase()],
  )).rows[0].id;
  await client.query(
    `INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, ativo)
     SELECT $1::uuid, d, c.id, 'DISPONIVEL', CURRENT_DATE - 1, true
       FROM configuracao_agenda c CROSS JOIN generate_series(1, 7) d
      WHERE c.empresa_id IS NULL AND c.codigo IN ('TURNO_1', 'TURNO_2')`,
    [pacoteA],
  );
});

test("sem configuração: um escopo (a empresa) e os horários herdados para o assistente", async () => {
  const escopos = await escoposDaEmpresa(tx, A);
  assert.deepEqual(escopos.map((e) => [e.estabelecimentoId, e.configurado]), [[null, false]]);
  const agenda = await lerAgendaEscopo(tx, A, null);
  assert.equal(agenda.config, null);
  assert.deepEqual(agenda.horarios.map((h) => [h.codigo, h.herdado]), [["TURNO_1", true], ["TURNO_2", true]]);
});

test("assistente: cria horários próprios, copia as regras dos herdados, liga salões e vale no cálculo", async () => {
  const lida = await lerAgendaEscopo(tx, A, null);
  const herdados = lida.horarios;
  const entrada: SalvarAgenda = {
    // Plano rev. 1.1: a versão da leitura que pré-preencheu o assistente; o segundo envio (abaixo) recebe AGENDA_JA_CONFIGURADA.
    versaoEsperada: lida.versaoAgenda,
    estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_SALAO", limiteFestasDia: 4, intervaloMinimoMinutos: 60,
    saloes: [{ nome: "Salão Principal", capacidadeConvidados: 120 }, { nome: "Salão Kids", capacidadeConvidados: 60 }],
    horarios: [
      { id: herdados[0].id, nome: "Almoço", inicio: "11:00", fim: "15:00", dias: [5, 6, 7], capacidade: 1, saloes: ["Salão Principal", "Salão Kids"] },
      { id: herdados[1].id, nome: "Noite", inicio: "17:00", fim: "21:00", dias: [1, 2, 3, 4, 5, 6], capacidade: 1, saloes: ["Salão Principal"] },
      { nome: "Manhã", inicio: "08:00", fim: "10:30", dias: [6, 7], capacidade: 1, saloes: ["Salão Kids"] },
    ],
  };
  const agenda = await emTransacao(() => salvarAgendaEscopo(tx, entrada, ctx(), "ASSISTENTE", PROVA_POR_SALAO));
  assert.equal(agenda.config?.capacidadeTipo, "POR_SALAO");
  assert.equal(agenda.config?.configuradoPor, "Ana 093");
  assert.deepEqual(agenda.horarios.map((h) => [h.codigo, h.herdado, h.dias.join("")]), [["TURNO_1", false, "567"], ["TURNO_2", false, "123456"], ["HORARIO_3", false, "67"]]);
  assert.equal(agenda.saloes.length, 2);
  assert.equal(agenda.horarios[0].saloes.length, 2);
  // Regras: o pacote continua disponível nos turnos copiados; todo horário novo tem categoria de preço em cada dia.
  const regras = await client.query<{ codigo: string; disp: number; cat: number }>(
    `SELECT c.codigo,
            (SELECT count(*)::int FROM regras_disponibilidade_pacote r WHERE r.configuracao_agenda_id = c.id AND r.pacote_id = $2::uuid) AS disp,
            (SELECT count(*)::int FROM regras_categoria_horario r WHERE r.configuracao_agenda_id = c.id AND r.ativo) AS cat
       FROM configuracao_agenda c WHERE c.empresa_id = $1::uuid AND c.ativo ORDER BY c.ordem_exibicao`,
    [A, pacoteA],
  );
  assert.deepEqual(regras.rows.map((r) => [r.codigo, r.disp, r.cat >= 2]), [["TURNO_1", 7, true], ["TURNO_2", 7, true], ["HORARIO_3", 0, true]]);
  // O cálculo usa os horários da empresa e respeita os dias: segunda só tem Noite; sábado tem os três.
  const segunda = await consultarDisponibilidadeData(await proxima(1), tx, undefined, { empresaId: A, estabelecimentoId: null });
  assert.deepEqual(segunda.periodos.map((p) => p.codigo), ["TURNO_2"]);
  const sabado = await consultarDisponibilidadeData(await proxima(6), tx, undefined, { empresaId: A, estabelecimentoId: null });
  assert.deepEqual(sabado.periodos.map((p) => p.codigo), ["TURNO_1", "TURNO_2", "HORARIO_3"]);
  // A outra empresa continua com os turnos globais.
  assert.deepEqual((await listarConfiguracoesAgendaAtivas(tx, { empresaId: B, estabelecimentoId: null })).map((c) => c.codigo), ["TURNO_1", "TURNO_2"]);
  // O assistente não reconfigura uma unidade já configurada.
  await recusa(emTransacao(() => salvarAgendaEscopo(tx, entrada, ctx(), "ASSISTENTE", PROVA_POR_SALAO)), /já foi configurada/);
});

test("desativar a partir de uma data: some do cálculo na data; cancelável antes; passado recusado", async () => {
  const noite = (await lerAgendaEscopo(tx, A, null)).horarios.find((h) => h.codigo === "TURNO_2")!;
  const terca = await proxima(2);
  await recusa(emTransacao(() => desativarHorarioAPartirDe(tx, ctx(), noite.id, "2020-01-01")), /a partir de hoje/);
  const r = await emTransacao(() => desativarHorarioAPartirDe(tx, ctx(), noite.id, terca));
  assert.equal(r.festasMantidas, 0);
  const dia = await consultarDisponibilidadeData(terca, tx, undefined, { empresaId: A, estabelecimentoId: null });
  assert.equal(dia.periodos.some((p) => p.codigo === "TURNO_2"), false);
  await emTransacao(() => cancelarDesativacao(tx, ctx(), noite.id));
  const depois = await consultarDisponibilidadeData(terca, tx, undefined, { empresaId: A, estabelecimentoId: null });
  assert.equal(depois.periodos.some((p) => p.codigo === "TURNO_2"), true);
});

test("troca para horário livre: horário técnico com regras por dia, fora da lista de horários fixos", async () => {
  const atual = await lerAgendaEscopo(tx, A, null);
  await emTransacao(() => salvarAgendaEscopo(tx, {
    versaoEsperada: atual.versaoAgenda,
    estabelecimentoId: null, modo: "LIVRE", capacidadeTipo: "POR_SALAO", limiteFestasDia: 3, intervaloMinimoMinutos: 30,
    saloes: atual.saloes.map((s) => ({ id: s.id, nome: s.nome, capacidadeConvidados: s.capacidadeConvidados })),
    horarios: atual.horarios.map((h) => ({ id: h.id, nome: h.nome, inicio: h.inicio, fim: h.fim, dias: h.dias, capacidade: h.capacidade,
      saloes: atual.saloes.filter((s) => h.saloes.includes(s.id)).map((s) => s.nome) })),
  }, ctx(), "CONFIGURACOES"));
  const livre = await client.query<{ id: string; cat: number; disp: number }>(
    `SELECT c.id::text AS id,
            (SELECT count(*)::int FROM regras_categoria_horario r WHERE r.configuracao_agenda_id = c.id AND r.ativo) AS cat,
            (SELECT count(*)::int FROM regras_disponibilidade_pacote r WHERE r.configuracao_agenda_id = c.id AND r.pacote_id = $2::uuid) AS disp
       FROM configuracao_agenda c WHERE c.empresa_id = $1::uuid AND c.horario_livre AND c.ativo`,
    [A, pacoteA],
  );
  assert.equal(livre.rows.length, 1);
  assert.equal(livre.rows[0].cat, 7);
  assert.equal(livre.rows[0].disp, 7);
  assert.equal((await listarConfiguracoesAgendaAtivas(tx, { empresaId: A, estabelecimentoId: null })).some((c) => c.codigo === "HORARIO_LIVRE"), false);
});

test("salões só da própria empresa; rollback recusado com configuração", async () => {
  const salaoA = (await lerAgendaEscopo(tx, A, null)).saloes[0].id;
  const pacoteB = (await client.query<{ id: string }>(
    `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
     VALUES ($1::uuid, $2, 'Pacote 093 B', 931, true, true, 10, 20) RETURNING id::text AS id`,
    [B, `P93B${sufixo}`.toUpperCase()],
  )).rows[0].id;
  await recusa(emTransacao(() => definirSaloesPacote(tx, B, pacoteB, [salaoA])), /salões desta empresa/);
  await recusa(emTransacao(async () => { await client.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [pacoteB, salaoA]); }), /093: salão de outra empresa/);
  await emTransacao(() => definirSaloesPacote(tx, A, pacoteA, [salaoA]));
  assert.equal((await client.query(`SELECT 1 FROM pacote_saloes WHERE pacote_id = $1::uuid`, [pacoteA])).rowCount, 1);
  await recusa(client.query(arquivo("database/rollback/20261022_093_agenda_configuracao_unidade_down.sql")), /093 rollback: há configuração/);
  await client.query("ROLLBACK").catch(() => undefined);
});
