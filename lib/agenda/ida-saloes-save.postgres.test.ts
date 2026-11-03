import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { cenario, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { lerAgendaEscopo, salvarAgendaEscopo, type AgendaEscopo, type SalvarAgenda } from "./configuracao-unidade.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 3, P2 do save; bateria C' e parte da E), pelo serviço real no
 * PostgreSQL DESCARTÁVEL (estado atual): a ida POR_HORARIO → POR_SALAO só muda o tipo, cria salões novos e vínculos.
 * Cada campo fora disso, mudado JUNTO com uma ida válida, recusa sem gravar nada (retrato das tabelas da agenda da
 * empresa antes = depois). Versão obsoleta recusa com AGENDA_MUDOU antes da comparação; sem a liberação, a ida recusa.
 * Controle: a mesma ida sem a mudança extra é gravada.
 */
let a: Client;
let tx: DbExecutor;
const LIBERADA = { maisDeUmSalaoLiberada: true };
const TODOS = [1, 2, 3, 4, 5, 6, 7];

test.before(async () => {
  a = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await a.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } };
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

async function emTransacao<T>(fn: () => Promise<T>) {
  await a.query("BEGIN");
  try { const r = await fn(); await a.query("COMMIT"); return r; } catch (error) { await a.query("ROLLBACK"); throw error; }
}
const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() });

/** Tudo o que o save da agenda grava para a empresa, em forma comparável. */
async function retrato(empresa: string) {
  const r = await a.query<{ j: unknown }>(
    `SELECT jsonb_build_object(
       'config', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM configuracao_agenda c WHERE c.empresa_id = $1::uuid),
       'saloes', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM agenda_saloes s WHERE s.empresa_id = $1::uuid),
       'escopo', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM agenda_escopo_config e WHERE e.empresa_id = $1::uuid),
       'vinculos', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.configuracao_agenda_id, v.salao_id) FROM configuracao_agenda_saloes v
                     JOIN configuracao_agenda c ON c.id = v.configuracao_agenda_id WHERE c.empresa_id = $1::uuid),
       'categorias', (SELECT count(*) FROM regras_categoria_horario r JOIN configuracao_agenda c ON c.id = r.configuracao_agenda_id WHERE c.empresa_id = $1::uuid)
     ) AS j`, [empresa]);
  return r.rows[0]!.j;
}

/** Empresa com agenda "um salão" (dois horários fixos) já gravada; devolve a agenda lida. */
async function agendaUmSalao() {
  const c = await cenario(a, 0);
  const base: SalvarAgenda = {
    versaoEsperada: null, estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: 4, intervaloMinimoMinutos: 30, saloes: [],
    horarios: [
      { nome: "Manhã", inicio: "09:00", fim: "12:00", dias: TODOS, capacidade: 1, saloes: [] },
      { nome: "Tarde", inicio: "15:00", fim: "19:00", dias: [6, 7], capacidade: 1, saloes: [] },
    ],
  };
  await emTransacao(async () => salvarAgendaEscopo(tx, { ...base, versaoEsperada: (await lerAgendaEscopo(tx, c.empresa, null)).versaoAgenda }, ctx(c), "CONFIGURACOES"));
  return { c, agenda: await lerAgendaEscopo(tx, c.empresa, null) };
}

/** A ida válida a partir da agenda lida: mesmo modo, limite, intervalo e horários; dois salões novos em todos. */
function ida(agenda: AgendaEscopo): SalvarAgenda {
  const cfg = agenda.config!;
  return {
    versaoEsperada: agenda.versaoAgenda, estabelecimentoId: null, modo: cfg.modo, capacidadeTipo: "POR_SALAO",
    limiteFestasDia: cfg.limiteFestasDia, intervaloMinimoMinutos: cfg.intervaloMinimoMinutos,
    saloes: [{ nome: "Salão Ônix", capacidadeConvidados: 80 }, { nome: "Salão Jade", capacidadeConvidados: null }],
    horarios: agenda.horarios.map((h) => ({ id: h.id, nome: h.nome, inicio: h.inicio, fim: h.fim, dias: h.dias, capacidade: 2, saloes: ["Salão Ônix", "Salão Jade"] })),
  };
}

const MUDANCAS: Array<[string, (p: SalvarAgenda) => SalvarAgenda]> = [
  ["modo", (p) => ({ ...p, modo: "LIVRE" })],
  ["limite de festas por dia", (p) => ({ ...p, limiteFestasDia: 5 })],
  ["limite removido", (p) => ({ ...p, limiteFestasDia: null })],
  ["intervalo", (p) => ({ ...p, intervaloMinimoMinutos: 60 })],
  ["nome do horário", (p) => ({ ...p, horarios: p.horarios.map((h, i) => (i === 0 ? { ...h, nome: "Manhãzinha" } : h)) })],
  ["início do horário", (p) => ({ ...p, horarios: p.horarios.map((h, i) => (i === 0 ? { ...h, inicio: "09:30" } : h)) })],
  ["fim do horário", (p) => ({ ...p, horarios: p.horarios.map((h, i) => (i === 1 ? { ...h, fim: "20:00" } : h)) })],
  ["dias do horário", (p) => ({ ...p, horarios: p.horarios.map((h, i) => (i === 1 ? { ...h, dias: [5, 6, 7] } : h)) })],
  ["capacidade fora da regra dos vínculos", (p) => ({ ...p, horarios: p.horarios.map((h, i) => (i === 0 ? { ...h, capacidade: 1 } : h)) })],
  ["horário novo", (p) => ({ ...p, horarios: [...p.horarios, { nome: "Noite", inicio: "20:00", fim: "23:00", dias: TODOS, capacidade: 2, saloes: ["Salão Ônix", "Salão Jade"] }] })],
  ["horário removido", (p) => ({ ...p, horarios: p.horarios.slice(1) })],
  ["horário trocado de id", (p) => ({ ...p, horarios: p.horarios.map((h, i) => (i === 0 ? { ...h, id: randomUUID() } : h)) })],
  ["salão novo com id", (p) => ({ ...p, saloes: p.saloes.map((s, i) => (i === 0 ? { ...s, id: randomUUID() } : s)) })],
];

test("C': ida válida com uma mudança a mais recusa sem gravar nada (um caso por campo)", async () => {
  const { c, agenda } = await agendaUmSalao();
  const antes = await retrato(c.empresa);
  for (const [campo, mudar] of MUDANCAS) {
    await assert.rejects(emTransacao(() => salvarAgendaEscopo(tx, mudar(ida(agenda)), ctx(c), "CONFIGURACOES", LIBERADA)),
      (e: unknown) => (e as { code?: string }).code === "DADOS_INVALIDOS", campo);
    assert.deepEqual(await retrato(c.empresa), antes, `nada gravado: ${campo}`);
  }
});

test("C'/E: versão obsoleta recusa com AGENDA_MUDOU; sem a liberação a ida recusa; nada gravado", async () => {
  const { c, agenda } = await agendaUmSalao();
  const antes = await retrato(c.empresa);
  await assert.rejects(emTransacao(() => salvarAgendaEscopo(tx, { ...ida(agenda), versaoEsperada: "0" }, ctx(c), "CONFIGURACOES", LIBERADA)),
    (e: unknown) => (e as { code?: string }).code === "AGENDA_MUDOU");
  // Obsoleta E com mudança proibida: AGENDA_MUDOU tem precedência.
  await assert.rejects(emTransacao(() => salvarAgendaEscopo(tx, { ...ida(agenda), versaoEsperada: "0", modo: "LIVRE" }, ctx(c), "CONFIGURACOES", LIBERADA)),
    (e: unknown) => (e as { code?: string }).code === "AGENDA_MUDOU");
  await assert.rejects(emTransacao(() => salvarAgendaEscopo(tx, ida(agenda), ctx(c), "CONFIGURACOES", { maisDeUmSalaoLiberada: false })),
    /ainda não está disponível/);
  assert.deepEqual(await retrato(c.empresa), antes, "nada gravado");
  // D-LIB-1: a tela recebe a liberação pela leitura do servidor (mesma env que o save confere), nunca um valor fixo.
  const original = process.env.AGENDA_MAIS_DE_UM_SALAO;
  try {
    for (const [valor, esperado] of [[undefined, false], ["false", false], ["TRUE", false], ["true", true]] as const) {
      if (valor === undefined) delete process.env.AGENDA_MAIS_DE_UM_SALAO; else process.env.AGENDA_MAIS_DE_UM_SALAO = valor;
      assert.equal((await lerAgendaEscopo(tx, c.empresa, null)).maisDeUmSalaoLiberado, esperado, `leitura com AGENDA_MAIS_DE_UM_SALAO=${valor}`);
    }
  } finally {
    if (original === undefined) delete process.env.AGENDA_MAIS_DE_UM_SALAO; else process.env.AGENDA_MAIS_DE_UM_SALAO = original;
  }
});

test("C' (controle): a ida válida grava POR_SALAO com os salões novos e os vínculos; os horários mantêm id, nome, início, fim e dias", async () => {
  const { c, agenda } = await agendaUmSalao();
  const depois = await emTransacao(() => salvarAgendaEscopo(tx, ida(agenda), ctx(c), "CONFIGURACOES", LIBERADA));
  assert.equal(depois.config?.capacidadeTipo, "POR_SALAO");
  assert.equal(depois.config?.modo, agenda.config!.modo);
  assert.equal(depois.config?.limiteFestasDia, agenda.config!.limiteFestasDia);
  assert.equal(depois.config?.intervaloMinimoMinutos, agenda.config!.intervaloMinimoMinutos);
  assert.deepEqual(depois.saloes.map((s) => s.nome).sort(), ["Salão Jade", "Salão Ônix"]);
  const forma = (h: AgendaEscopo["horarios"][number]) => [h.id, h.nome, h.inicio, h.fim, [...h.dias].sort().join(",")].join("|");
  assert.deepEqual(depois.horarios.map(forma).sort(), agenda.horarios.map(forma).sort());
  for (const h of depois.horarios) assert.equal(h.saloes.length, 2, `vínculos de ${h.nome}`);
});
