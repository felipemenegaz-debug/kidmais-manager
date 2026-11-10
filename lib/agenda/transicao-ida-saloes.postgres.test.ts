import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { cenario, dia, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { criarSalaoCombinado, lerAgendaEscopo, salvarAgendaEscopo, type SalvarAgenda } from "./configuracao-unidade.ts";
import { trocarSalaoDaFesta } from "./troca-salao.ts";
import { estadoCombinados } from "./estado-combinados.ts";
import { travarConfiguracaoAgenda } from "./trava-configuracao.ts";
import { lerRegraCapacidadeAgenda, listarFechamentosConfirmadosPorPeriodo } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { ocupacaoImpedeCandidato } from "../disponibilidade/services/availability.service.ts";

/**
 * Plano "liberar agenda com mais de um salão" (bateria C, transição sequencial), pelos serviços reais no PostgreSQL
 * DESCARTÁVEL (estado atual): a festa marcada em POR_HORARIO continua sem salão depois da ida (a troca não atribui) e,
 * como curinga, ocupa S1, S2 e o combinado S1+S2 no mesmo intervalo (com o intervalo mínimo); outra data e outra empresa
 * seguem livres. Depois da atribuição avulsa (B7, festa sem contrato) só o recurso disjunto (S2) fica livre; cancelada,
 * nada ocupa. Cada candidato é conferido no SQL (kidmais094_conflito_ocupacao) e no Core (ocupacaoImpedeCandidato), que
 * precisam concordar.
 */
let a: Client;
let tx: DbExecutor;
const TODOS = [1, 2, 3, 4, 5, 6, 7];
const D = dia(70);

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
const min = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));

async function salvar(c: Cenario, entrada: Omit<SalvarAgenda, "versaoEsperada">, liberada = false) {
  return emTransacao(async () => salvarAgendaEscopo(tx, { ...entrada, versaoEsperada: (await lerAgendaEscopo(tx, c.empresa, null)).versaoAgenda },
    ctx(c), "CONFIGURACOES", { maisDeUmSalaoLiberada: liberada }));
}

/** A 114 exige a trava da configuração nos gatilhos de fechamentos: a fixture a toma como a entrada administrativa. */
async function travada<T>(c: Cenario, fn: () => Promise<T>) {
  return emTransacao(async () => { await travarConfiguracaoAgenda(tx, c.empresa, { modo: "COMPARTILHADA", linha: "JA_TRAVADA" }); return fn(); });
}

/** Festa confirmada SEM salão, como as marcadas na agenda "um salão" (salao_id nulo não passa pela guarda de escritores). */
const festaSemSalao = (c: Cenario, cfg: string, data: string) => travada(c, async () => {
  const r = await a.query<{ id: string }>(
    `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid RETURNING fechamentos.id::text AS id`,
    [data, cfg, c.empresa, c.pacote]);
  const id = r.rows[0]!.id;
  await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [id]);
  return id;
});

/** SQL e Core para um candidato; devolve o resultado (iguais, senão reprova). */
async function conflito(empresa: string, cfg: string, data: string, ini: string, fim: string, salao: string) {
  const sql = (await a.query<{ x: boolean }>(`SELECT kidmais094_conflito_ocupacao($1::uuid, $2::date, $3::time, $4::time, $5::uuid, NULL, $6::uuid, $7::uuid) AS x`,
    [randomUUID(), data, ini, fim, empresa, cfg, salao])).rows[0]!.x;
  const escopo = { empresaId: empresa, estabelecimentoId: null };
  const regra = await lerRegraCapacidadeAgenda(tx, escopo, { incluirCombinados: true });
  const ocupacoes = await listarFechamentosConfirmadosPorPeriodo(data, data, tx, escopo);
  const core = ocupacaoImpedeCandidato(regra, cfg, { inicioMinutos: min(ini), fimMinutos: min(fim) }, ocupacoes, [salao]);
  assert.equal(core, sql, `Core × SQL ${data} ${ini}–${fim} (Core ${core}, SQL ${sql})`);
  return sql;
}

test("C: festa de antes da ida fica sem salão e ocupa S1, S2 e S1+S2 (curinga); atribuída, só S2 livra; cancelada, nada ocupa", async () => {
  const c = await cenario(a, 0);
  const outra = await cenario(a, 0);
  const horarios = [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: [] as string[] }];
  // Com a 114 (validação da revisão recriada), a instalação dos combinados continua NOVA (defeito achado no F5).
  assert.equal((await estadoCombinados(tx)).estado, "NOVA");
  const umSalao = await salvar(c, { estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: null, intervaloMinimoMinutos: 60, saloes: [], horarios });
  const tarde = umSalao.horarios.find((h) => h.nome === "Tarde")!;
  const p0 = await festaSemSalao(c, tarde.id, D);

  const porSalao = await salvar(c, {
    estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_SALAO", limiteFestasDia: null, intervaloMinimoMinutos: 60,
    saloes: [{ nome: "S1", capacidadeConvidados: null }, { nome: "S2", capacidadeConvidados: null }],
    horarios: [{ id: tarde.id, nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 2, saloes: ["S1", "S2"] }],
  }, true);
  assert.equal(porSalao.config?.capacidadeTipo, "POR_SALAO");
  const s = Object.fromEntries(porSalao.saloes.map((x) => [x.nome, x.id!]));
  await emTransacao(() => criarSalaoCombinado(tx, ctx(c), { estabelecimentoId: null, nome: "S1+S2", capacidadeConvidados: null, membros: [s.S1!, s.S2!] }));
  const ab = (await a.query<{ id: string }>(`SELECT id::text AS id FROM agenda_saloes WHERE empresa_id = $1::uuid AND combinado`, [c.empresa])).rows[0]!.id;
  // Como na tela: o combinado entra nos salões do horário (save normal, já em POR_SALAO); senão o Core o trata como fora do horário.
  await salvar(c, {
    estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_SALAO", limiteFestasDia: null, intervaloMinimoMinutos: 60,
    saloes: [{ id: s.S1!, nome: "S1", capacidadeConvidados: null }, { id: s.S2!, nome: "S2", capacidadeConvidados: null }],
    horarios: [{ id: tarde.id, nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 3, saloes: ["S1", "S2", "S1+S2"] }],
  });
  assert.equal((await a.query(`SELECT salao_id FROM fechamentos WHERE id = $1::uuid`, [p0])).rows[0].salao_id, null, "a ida não atribui salão");

  // Curinga: mesmo intervalo e a borda do intervalo mínimo (19:30 < 19:00 + 60) ocupam todos; longe, outra data e outra empresa, livres.
  for (const salao of [s.S1!, s.S2!, ab]) {
    assert.equal(await conflito(c.empresa, tarde.id, D, "15:00", "19:00", salao), true, "mesmo horário");
    assert.equal(await conflito(c.empresa, tarde.id, D, "19:30", "21:00", salao), true, "dentro do intervalo mínimo");
    assert.equal(await conflito(c.empresa, tarde.id, D, "21:00", "23:00", salao), false, "fora do intervalo");
    assert.equal(await conflito(c.empresa, tarde.id, dia(71), "15:00", "19:00", salao), false, "outra data");
    assert.equal(await conflito(outra.empresa, tarde.id, D, "15:00", "19:00", salao), false, "outra empresa");
  }
  // Borda exata (fim + intervalo = início): SQL e Core concordam (a função conflito já exige).
  await conflito(c.empresa, tarde.id, D, "20:00", "22:00", s.S1!);

  // Atribuição avulsa (B7; festa sem contrato): S1 e o combinado seguem ocupados; S2 livra.
  await travada(c, () => trocarSalaoDaFesta(tx, ctx(c), p0, s.S1!));
  assert.equal((await a.query(`SELECT salao_id::text AS s FROM fechamentos WHERE id = $1::uuid`, [p0])).rows[0].s, s.S1);
  assert.equal(await conflito(c.empresa, tarde.id, D, "15:00", "19:00", s.S1!), true);
  assert.equal(await conflito(c.empresa, tarde.id, D, "15:00", "19:00", ab), true);
  assert.equal(await conflito(c.empresa, tarde.id, D, "15:00", "19:00", s.S2!), false, "recurso disjunto livre");

  // Cancelada, não ocupa.
  await travada(c, () => a.query(`UPDATE fechamentos SET status = 'CANCELADO' WHERE id = $1::uuid`, [p0]));
  for (const salao of [s.S1!, s.S2!, ab]) assert.equal(await conflito(c.empresa, tarde.id, D, "15:00", "19:00", salao), false, "cancelada");
});
