import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { cenario, dia, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { lerAgendaEscopo, salvarAgendaEscopo, type SalvarAgenda } from "./configuracao-unidade.ts";
import { travarConfiguracaoAgenda } from "./trava-configuracao.ts";
import { lerRegraCapacidadeAgenda } from "../disponibilidade/repositories/disponibilidade.repository.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 2/3, bateria D), no PostgreSQL DESCARTÁVEL (modelo 114), com DUAS
 * conexões reais em READ COMMITTED e uma terceira para observar:
 * - troca primeiro: o save da ida (exclusiva) segura a configuração; a entrada (compartilhada) ESPERA (pg_blocking_pids
 *   aponta o save, capturado antes da consulta bloqueante terminar) e, depois do COMMIT, lê POR_SALAO;
 * - reserva primeiro: a entrada lê POR_HORARIO e grava a festa sob a compartilhada; o save ESPERA e, depois do COMMIT da
 *   entrada, grava a ida; a festa fica sem salão (curinga). Nenhum deadlock nas duas ordens;
 * - leitura final por uma terceira conexão.
 */
let a: Client, b: Client, c3: Client, obs: Client;
const exec = (c: Client): DbExecutor => ({ async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await c.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } });
const TODOS = [1, 2, 3, 4, 5, 6, 7];

// Só a primeira toma a trava de sessão das provas (exclusão entre suítes); as outras duas não, senão esperariam por ela.
test.before(async () => { a = await conectarDescartavel(); b = await conectarDescartavel({ travar: false }); c3 = await conectarDescartavel({ travar: false }); obs = await conectarDescartavel({ travar: false }); });
test.after(async () => { for (const c of [a, b, c3, obs]) if (c) await encerrarDescartavel(c); });

const pid = async (c: Client) => Number((await c.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]!.p);
/** Espera (no observador) até `alvo` estar bloqueado por `por`; devolve os bloqueadores vistos. */
async function esperaPor(alvo: number, por: number) {
  for (let i = 0; i < 200; i++) {
    const r = await obs.query<{ b: number[] }>("SELECT pg_blocking_pids($1) AS b", [alvo]);
    const bloqueadores = r.rows[0]!.b.map(Number);
    if (bloqueadores.includes(por)) return bloqueadores;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  throw new Error(`pid ${alvo} não ficou esperando ${por}`);
}

/** Espera até `alvo` estar bloqueado por algum dos `candidatos` (fila de tupla: o primeiro na fila também bloqueia). */
async function esperaPorAlgum(alvo: number, candidatos: number[]) {
  for (let i = 0; i < 200; i++) {
    const b = (await obs.query<{ b: number[] }>("SELECT pg_blocking_pids($1) AS b", [alvo])).rows[0]!.b.map(Number);
    if (b.some((p) => candidatos.includes(p))) return b;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  throw new Error(`pid ${alvo} não ficou esperando ${candidatos.join("/")}`);
}

async function umSalao(c: Cenario) {
  const ex = exec(a);
  const entrada: SalvarAgenda = { versaoEsperada: null, estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: null,
    intervaloMinimoMinutos: 0, saloes: [], horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: [] }] };
  await a.query("BEGIN");
  await salvarAgendaEscopo(ex, { ...entrada, versaoEsperada: (await lerAgendaEscopo(ex, c.empresa, null)).versaoAgenda }, ctx(c), "CONFIGURACOES");
  await a.query("COMMIT");
  return lerAgendaEscopo(ex, c.empresa, null);
}
const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() });
const ida = (agenda: Awaited<ReturnType<typeof lerAgendaEscopo>>): SalvarAgenda => ({
  versaoEsperada: agenda.versaoAgenda, estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_SALAO", limiteFestasDia: null, intervaloMinimoMinutos: 0,
  saloes: [{ nome: "S1", capacidadeConvidados: null }, { nome: "S2", capacidadeConvidados: null }],
  horarios: agenda.horarios.map((h) => ({ id: h.id, nome: h.nome, inicio: h.inicio, fim: h.fim, dias: h.dias, capacidade: 2, saloes: ["S1", "S2"] })),
});

/** A entrada pública (KEY_SHARE + compartilhada) lê o tipo da regra e grava a festa sem salão (como em POR_HORARIO). */
async function entrada(c: Cenario, cfg: string, data: string, conexao: Client = b) {
  const ex = exec(conexao);
  await travarConfiguracaoAgenda(ex, c.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
  const tipo = (await lerRegraCapacidadeAgenda(ex, { empresaId: c.empresa, estabelecimentoId: null }))?.capacidadeTipo ?? null;
  await conexao.query(
    `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid`,
    [data, cfg, c.empresa, c.pacote]);
  return tipo;
}

test("D: troca primeiro — a entrada espera a exclusiva do save e, depois do COMMIT, lê POR_SALAO; sem deadlock", async () => {
  const c = await cenario(a, 0);
  const agenda = await umSalao(c);
  const [pa, pb] = [await pid(a), await pid(b)];
  await a.query("BEGIN");
  await travarConfiguracaoAgenda(exec(a), c.empresa, { modo: "EXCLUSIVA", linha: "JA_TRAVADA" });
  await b.query("BEGIN");
  const reserva = entrada(c, agenda.horarios[0]!.id, dia(90));
  assert.ok((await esperaPor(pb, pa)).includes(pa), "a entrada espera o save");
  await salvarAgendaEscopo(exec(a), ida(agenda), ctx(c), "CONFIGURACOES", { maisDeUmSalaoLiberada: true });
  await a.query("COMMIT");
  assert.equal(await reserva, "POR_SALAO", "a entrada decide com a regra nova");
  await b.query("COMMIT");
  const final = await obs.query<{ tipo: string; festas: number }>(
    `SELECT (SELECT capacidade_tipo FROM agenda_escopo_config WHERE empresa_id = $1::uuid LIMIT 1) AS tipo,
            (SELECT count(*)::int FROM fechamentos WHERE empresa_id = $1::uuid) AS festas`, [c.empresa]);
  assert.deepEqual(final.rows[0], { tipo: "POR_SALAO", festas: 1 });
});

test("D: reserva primeiro — o save espera a compartilhada da entrada; a festa fica sem salão (curinga); sem deadlock", async () => {
  const c = await cenario(a, 0);
  const agenda = await umSalao(c);
  const [pa, pb] = [await pid(a), await pid(b)];
  await b.query("BEGIN");
  assert.equal(await entrada(c, agenda.horarios[0]!.id, dia(91)), "POR_HORARIO");
  await a.query("BEGIN");
  const save = salvarAgendaEscopo(exec(a), ida(agenda), ctx(c), "CONFIGURACOES", { maisDeUmSalaoLiberada: true });
  assert.ok((await esperaPor(pa, pb)).includes(pb), "o save espera a entrada");
  await b.query("COMMIT");
  const depois = await save;
  await a.query("COMMIT");
  assert.equal(depois.config?.capacidadeTipo, "POR_SALAO");
  const festa = await obs.query<{ salao: string | null; tipo: string }>(
    `SELECT f.salao_id::text AS salao, (SELECT capacidade_tipo FROM agenda_escopo_config WHERE empresa_id = $1::uuid LIMIT 1) AS tipo
       FROM fechamentos f WHERE f.empresa_id = $1::uuid`, [c.empresa]);
  assert.deepEqual(festa.rows, [{ salao: null, tipo: "POR_SALAO" }]);
});

/** Rodada 2 (P2 do Astra, rev. 3 item 5): o grafo de espera visto pelo observador não fecha ciclo. */
async function semCiclo(pids: number[]) {
  const grafo = new Map<number, number[]>();
  for (const p of pids) grafo.set(p, (await obs.query<{ b: number[] }>("SELECT pg_blocking_pids($1) AS b", [p])).rows[0]!.b.map(Number));
  const visita = (p: number, caminho: Set<number>): boolean => {
    if (caminho.has(p)) return true;
    const proximo = new Set(caminho).add(p);
    return (grafo.get(p) ?? []).some((q) => visita(q, proximo));
  };
  for (const p of pids) assert.equal(visita(p, new Set()), false, `ciclo no grafo de espera: ${JSON.stringify([...grafo])}`);
  return grafo;
}

test("D (rodada 2): fila de três na advisory — escritor com a compartilhada, save enfileirado na exclusiva, nova compartilhada atrás do save; sem ciclo nem deadlock", async () => {
  const c = await cenario(a, 0);
  const agenda = await umSalao(c);
  const cfg = agenda.horarios[0]!.id;
  const [pa, pb, pc] = [await pid(a), await pid(b), await pid(c3)];
  // Sem FOR UPDATE administrativo concorrente: só a fila da advisory.
  await a.query("BEGIN");
  assert.equal(await entrada(c, cfg, dia(92), a), "POR_HORARIO", "1º: escritor ativo com a compartilhada");
  await b.query("BEGIN");
  const save = salvarAgendaEscopo(exec(b), ida(agenda), ctx(c), "CONFIGURACOES", { maisDeUmSalaoLiberada: true });
  assert.ok((await esperaPor(pb, pa)).includes(pa), "2º: o save espera o escritor na exclusiva");
  await c3.query("BEGIN");
  const terceira = entrada(c, cfg, dia(93), c3);
  assert.ok((await esperaPor(pc, pb)).includes(pb), "3º: a nova compartilhada fica atrás do save enfileirado");
  const grafo = await semCiclo([pa, pb, pc]);
  assert.deepEqual(grafo.get(pa), [], "o escritor ativo não espera ninguém");
  await a.query("COMMIT");
  const depois = await save;
  assert.equal(depois.config?.capacidadeTipo, "POR_SALAO");
  assert.ok((await esperaPor(pc, pb)).includes(pb), "a terceira continua atrás do save até o COMMIT dele");
  await b.query("COMMIT");
  assert.equal(await terceira, "POR_SALAO", "a terceira decide com a regra nova");
  await c3.query("COMMIT");
  const final = await obs.query<{ data: string; salao: string | null }>(
    `SELECT to_char(data_evento, 'YYYY-MM-DD') AS data, salao_id::text AS salao FROM fechamentos WHERE empresa_id = $1::uuid ORDER BY data_evento`, [c.empresa]);
  assert.deepEqual(final.rows, [{ data: dia(92), salao: null }, { data: dia(93), salao: null }]);
});

test("D (rodada 2, variante administrativa, prova separada): save esperando em empresas FOR UPDATE antes da configuração × entrada pública KEY SHARE; sem ciclo nem deadlock", async () => {
  const c = await cenario(a, 0);
  const agenda = await umSalao(c);
  const cfg = agenda.horarios[0]!.id;
  const [pa, pb, pc] = [await pid(a), await pid(b), await pid(c3)];
  // 1º: entrada administrativa sob o tenant (empresa FOR UPDATE → compartilhada → festa).
  await a.query("BEGIN");
  await a.query(`SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE`, [c.empresa]);
  assert.equal(await entrada(c, cfg, dia(94), a), "POR_HORARIO");
  // 2º: save pelo tenant — espera na LINHA da empresa, sem chegar à configuração.
  await b.query("BEGIN");
  const save = (async () => {
    await b.query(`SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE`, [c.empresa]);
    return salvarAgendaEscopo(exec(b), ida(agenda), ctx(c), "CONFIGURACOES", { maisDeUmSalaoLiberada: true });
  })();
  assert.ok((await esperaPor(pb, pa)).includes(pa), "o save espera a linha da empresa");
  const travasDoSave = await obs.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted`, [pb]);
  assert.equal(travasDoSave.rows[0]!.n, 0, "o save ainda não segura nenhuma advisory");
  // 3º: entrada pública (KEY SHARE + compartilhada) também espera.
  await c3.query("BEGIN");
  const publica = entrada(c, cfg, dia(95), c3);
  // A pública espera a linha da empresa: atrás da administrativa ou do save que já está na fila da tupla.
  await esperaPorAlgum(pc, [pa, pb]);
  await semCiclo([pa, pb, pc]);
  await a.query("COMMIT");
  await save;
  await b.query("COMMIT");
  assert.equal(await publica, "POR_SALAO");
  await c3.query("COMMIT");
  const final = await obs.query<{ n: number }>(`SELECT count(*)::int AS n FROM fechamentos WHERE empresa_id = $1::uuid`, [c.empresa]);
  assert.equal(final.rows[0]!.n, 2);
});
