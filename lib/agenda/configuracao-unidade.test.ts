import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../db/contracts.ts";
import { horarioValeNaData } from "../disponibilidade/services/availability.service.ts";
import { exigirIdaSoComSaloes, exigirTipoDeAgendaLiberado, salvarAgendaEscopo, type AgendaEscopo, type SalvarAgenda } from "./configuracao-unidade.ts";
import { maisDeUmSalaoLiberado } from "./saloes-liberacao-servidor.ts";
import { AVISO_IDA_HORARIOS_HERDADOS, AVISO_IDA_SO_SALOES } from "./saloes-liberacao.ts";

// 093 (etapa 2a): dias da semana, desativação datada e validação antes de qualquer escrita.
test("o horário vale só nos dias dele e até a véspera da desativação", () => {
  // 2026-10-24 é sábado (6), 2026-10-26 é segunda (1).
  assert.equal(horarioValeNaData({ diasSemana: null, desativadoAPartirDe: null }, "2026-10-26"), true);
  assert.equal(horarioValeNaData({ diasSemana: [5, 6, 7], desativadoAPartirDe: null }, "2026-10-24"), true);
  assert.equal(horarioValeNaData({ diasSemana: [5, 6, 7], desativadoAPartirDe: null }, "2026-10-26"), false);
  assert.equal(horarioValeNaData({ diasSemana: [7], desativadoAPartirDe: null }, "2026-10-25"), true, "domingo é 7");
  assert.equal(horarioValeNaData({ diasSemana: null, desativadoAPartirDe: "2026-11-23" }, "2026-11-22"), true);
  assert.equal(horarioValeNaData({ diasSemana: null, desativadoAPartirDe: "2026-11-23" }, "2026-11-23"), false);
});

const semBanco: DbExecutor = { async query() { throw new Error("o banco não deveria ser consultado"); } };
const ctx = { empresaId: "11111111-1111-4111-8111-111111111111", usuarioId: "u", requestId: "r" };
const base: SalvarAgenda = {
  estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: 3, intervaloMinimoMinutos: 60,
  saloes: [], horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: [6], capacidade: 1, saloes: [] }], versaoEsperada: null,
};

test("entrada inválida é recusada antes de consultar o banco", async () => {
  const casos: Array<[Partial<SalvarAgenda>, RegExp]> = [
    [{ horarios: [] }, /pelo menos um horário/],
    [{ horarios: [{ ...base.horarios[0], inicio: "19:00", fim: "15:00" }] }, /depois do início/],
    [{ horarios: [{ ...base.horarios[0], dias: [] }] }, /dias do horário/],
    [{ horarios: [{ ...base.horarios[0], capacidade: 0 }] }, /1 a 20 festas/],
    // Decisão de Felipe (25/10/2026): com um salão, nunca duas festas no mesmo horário.
    [{ horarios: [{ ...base.horarios[0], capacidade: 2 }] }, /uma festa por vez/],
    [{ capacidadeTipo: "POR_SALAO" }, /pelo menos um salão/],
    [{ capacidadeTipo: "POR_SALAO", saloes: [{ nome: "Kids", capacidadeConvidados: null }] }, /salões do horário Tarde/],
    [{ saloes: [{ nome: "Kids", capacidadeConvidados: null }, { nome: "kids ", capacidadeConvidados: null }] }, /nome diferente/],
    [{ limiteFestasDia: 0 }, /entre 1 e 50/],
    [{ intervaloMinimoMinutos: 600 }, /até 8 horas/],
  ];
  for (const [mudanca, erro] of casos) {
    await assert.rejects(salvarAgendaEscopo(semBanco, { ...base, ...mudanca }, ctx, "CONFIGURACOES"), erro);
  }
  // No modo livre não é preciso cadastrar horário fixo.
  await assert.rejects(salvarAgendaEscopo(semBanco, { ...base, modo: "LIVRE", horarios: [] }, ctx, "CONFIGURACOES"), /banco não deveria/);
});

test("agenda com mais de um salão: só quem já está nela continua, até ser liberada", () => {
  assert.throws(() => exigirTipoDeAgendaLiberado("POR_SALAO", null, false), /ainda não está disponível/, "primeira configuração");
  assert.throws(() => exigirTipoDeAgendaLiberado("POR_SALAO", "POR_HORARIO", false), /ainda não está disponível/, "troca de um salão para vários");
  assert.doesNotThrow(() => exigirTipoDeAgendaLiberado("POR_SALAO", "POR_SALAO", false), "quem já está por salão segue editando");
  assert.throws(() => exigirTipoDeAgendaLiberado("POR_HORARIO", "POR_SALAO", false), /ainda não está disponível pela tela/, "voltar a um salão fica bloqueado por ora");
  assert.throws(() => exigirTipoDeAgendaLiberado("POR_HORARIO", "POR_SALAO", true), /ainda não está disponível pela tela/, "a volta segue bloqueada com a ida liberada");
  assert.doesNotThrow(() => exigirTipoDeAgendaLiberado("POR_SALAO", "POR_HORARIO", true), "quando liberada, qualquer um escolhe");
  assert.doesNotThrow(() => exigirTipoDeAgendaLiberado("POR_SALAO", null, true), "primeira configuração liberada");
});

// D-LIB-1 (31/10/2026): env de runtime lida só no servidor; só "true" libera.
test("liberação da ida: env AGENDA_MAIS_DE_UM_SALAO, padrão desligado", () => {
  assert.equal(maisDeUmSalaoLiberado({}), false, "ausente");
  for (const v of ["", "1", "TRUE", "True", "yes", "on", " true", "true ", "false"]) assert.equal(maisDeUmSalaoLiberado({ AGENDA_MAIS_DE_UM_SALAO: v }), false, JSON.stringify(v));
  assert.equal(maisDeUmSalaoLiberado({ AGENDA_MAIS_DE_UM_SALAO: "true" }), true);
  assert.equal(maisDeUmSalaoLiberado({ NODE_ENV: "production", AGENDA_MAIS_DE_UM_SALAO: undefined }), false, "não usa NODE_ENV");
});

// Plano "liberar mais de um salão" (rev. 3, P2 do save): a ida só aceita tipo + salões novos + vínculos novos.
test("ida a mais de um salão: comparação fechada, um caso por campo", () => {
  const antes = {
    escopo: { estabelecimentoId: null, nome: "Unidade", configurado: true },
    config: { modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: 4, intervaloMinimoMinutos: 60, configuradoPor: null, configuradoEm: "2026-10-31" },
    saloes: [{ id: "s1", nome: "Salão 1", capacidadeConvidados: 80 }],
    combinados: [],
    horarios: [
      { id: "h1", codigo: "TURNO_1", nome: "Manhã", inicio: "10:00", fim: "14:00", dias: [6, 7], capacidade: 1, desativadoAPartirDe: null, saloes: [], herdado: false, festasFuturas: { quantidade: 2, proxima: null, ultima: null } },
      { id: "h2", codigo: "TURNO_2", nome: "Tarde", inicio: "15:00", fim: "19:00", dias: [6, 7], capacidade: 1, desativadoAPartirDe: null, saloes: [], herdado: false, festasFuturas: { quantidade: 0, proxima: null, ultima: null } },
    ],
    versaoAgenda: "v", maisDeUmSalaoLiberado: true,
  } as AgendaEscopo;
  const ida = (): SalvarAgenda => ({
    estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_SALAO", limiteFestasDia: 4, intervaloMinimoMinutos: 60,
    saloes: [{ id: "s1", nome: "Salão 1", capacidadeConvidados: 80 }, { nome: "Salão 2", capacidadeConvidados: 60 }],
    horarios: [
      { id: "h1", nome: "Manhã", inicio: "10:00", fim: "14:00", dias: [7, 6], capacidade: 2, saloes: ["Salão 1", "Salão 2"] },
      { id: "h2", nome: "Tarde", inicio: "15:00", fim: "19:00", dias: [6, 7], capacidade: 1, saloes: ["Salão 2"] },
    ],
    versaoEsperada: "v",
  });
  assert.doesNotThrow(() => exigirIdaSoComSaloes(ida(), antes), "esperado: tipo + salão novo + vínculos novos");
  assert.doesNotThrow(() => exigirIdaSoComSaloes({ ...ida(), capacidadeTipo: "POR_HORARIO", modo: "LIVRE" }, antes), "fora da ida, nada muda");
  assert.doesNotThrow(() => exigirIdaSoComSaloes(ida(), { ...antes, config: { ...antes.config!, capacidadeTipo: "POR_SALAO" } }), "quem já está por salão edita livre");
  const recusas: Array<[string, (x: SalvarAgenda) => void]> = [
    ["modo", (x) => { x.modo = "LIVRE"; }],
    ["limite do dia", (x) => { x.limiteFestasDia = 5; }],
    ["limite removido", (x) => { x.limiteFestasDia = null; }],
    ["intervalo", (x) => { x.intervaloMinimoMinutos = 30; }],
    ["salão existente omitido", (x) => { x.saloes = x.saloes.slice(1); }],
    ["salão existente renomeado", (x) => { x.saloes[0] = { ...x.saloes[0]!, nome: "Salão Um" }; }],
    ["capacidade do salão existente", (x) => { x.saloes[0] = { ...x.saloes[0]!, capacidadeConvidados: 90 }; }],
    ["ordem dos salões", (x) => { x.saloes = [x.saloes[1]!, x.saloes[0]!]; }],
    ["id trocado no salão novo", (x) => { x.saloes[1] = { ...x.saloes[1]!, id: "s9" }; }],
    ["horário omitido", (x) => { x.horarios = x.horarios.slice(0, 1); }],
    ["horário novo", (x) => { x.horarios.push({ nome: "Noite", inicio: "20:00", fim: "23:00", dias: [6], capacidade: 1, saloes: ["Salão 1"] }); }],
    ["ordem dos horários", (x) => { x.horarios = [x.horarios[1]!, x.horarios[0]!]; }],
    ["id do horário", (x) => { x.horarios[0] = { ...x.horarios[0]!, id: "h9" }; }],
    ["nome do horário", (x) => { x.horarios[0] = { ...x.horarios[0]!, nome: "Manhã cedo" }; }],
    ["início", (x) => { x.horarios[0] = { ...x.horarios[0]!, inicio: "09:00" }; }],
    ["fim", (x) => { x.horarios[0] = { ...x.horarios[0]!, fim: "13:00" }; }],
    ["dias", (x) => { x.horarios[0] = { ...x.horarios[0]!, dias: [6] }; }],
    ["capacidade do horário fora da derivada", (x) => { x.horarios[0] = { ...x.horarios[0]!, capacidade: 5 }; }],
  ];
  for (const [caso, mudar] of recusas) {
    const x = ida();
    mudar(x);
    assert.throws(() => exigirIdaSoComSaloes(x, antes), (e: Error) => e.message === AVISO_IDA_SO_SALOES, caso);
  }
  const comVinculo = { ...antes, horarios: antes.horarios.map((h, i) => (i === 0 ? { ...h, saloes: ["s1"] } : h)) } as AgendaEscopo;
  const semVinculo = ida();
  semVinculo.horarios[0] = { ...semVinculo.horarios[0]!, capacidade: 1, saloes: ["Salão 2"] };
  assert.throws(() => exigirIdaSoComSaloes(semVinculo, comVinculo), (e: Error) => e.message === AVISO_IDA_SO_SALOES, "vínculo existente removido");
  const herdados = { ...antes, horarios: antes.horarios.map((h) => ({ ...h, herdado: true })) } as AgendaEscopo;
  assert.throws(() => exigirIdaSoComSaloes(ida(), herdados), (e: Error) => e.message === AVISO_IDA_HORARIOS_HERDADOS, "horários herdados");
});

// 094 (etapa 2b): o cálculo dos candidatos espelha kidmais094_conflito_ocupacao.
test("capacidade: por horário, por salão com intervalo, horários diferentes e limite do dia", async () => {
  const { ocupacaoImpedeCandidato } = await import("../disponibilidade/services/availability.service.ts");
  const tarde = { inicioMinutos: 15 * 60, fimMinutos: 19 * 60 };
  const ocup = (f: string, ini: string, fim: string, cfg: string | null, salao: string | null = null) =>
    ({ fechamentoId: f, data: "2026-11-21", horarioInicio: ini, horarioFim: fim, configuracaoAgendaId: cfg, salaoId: salao });
  // Sem regra: qualquer sobreposição ocupa.
  assert.equal(ocupacaoImpedeCandidato(null, "T", tarde, [ocup("1", "18:00", "20:00", "N")]), true);
  assert.equal(ocupacaoImpedeCandidato(null, "T", tarde, [ocup("1", "19:00", "21:00", "N")]), false, "bordas que se tocam");
  const porHorario = { capacidadeTipo: "POR_HORARIO" as const, limiteFestasDia: 3, intervaloMinimoMinutos: 60,
    capacidadePorHorario: { T: 2, N: 2 }, saloesPorHorario: {}, saloesDoEscopo: [] };
  assert.equal(ocupacaoImpedeCandidato(porHorario, "T", tarde, [ocup("1", "15:00", "19:00", "T")]), false, "1 de 2");
  assert.equal(ocupacaoImpedeCandidato(porHorario, "T", tarde, [ocup("1", "15:00", "19:00", "T"), ocup("2", "15:00", "19:00", "T")]), true, "2 de 2");
  assert.equal(ocupacaoImpedeCandidato(porHorario, "T", tarde, [ocup("1", "18:00", "22:00", "N")]), true, "outro horário sobreposto");
  assert.equal(ocupacaoImpedeCandidato(porHorario, "T", tarde, [ocup("1", "08:00", "10:00", "M"), ocup("2", "11:00", "13:00", "M"), ocup("3", "21:00", "22:00", "N")]), true, "limite do dia");
  const porSalao = { capacidadeTipo: "POR_SALAO" as const, limiteFestasDia: null, intervaloMinimoMinutos: 60,
    capacidadePorHorario: {}, saloesPorHorario: { T: ["S1", "S2"] }, saloesDoEscopo: ["S1", "S2"] };
  assert.equal(ocupacaoImpedeCandidato(porSalao, "T", tarde, [ocup("1", "15:00", "19:00", "T", "S1")]), false, "S2 livre");
  assert.equal(ocupacaoImpedeCandidato(porSalao, "T", tarde, [ocup("1", "15:00", "19:00", "T", "S1"), ocup("2", "13:30", "14:30", "T", "S2")]), true, "intervalo de 60 min em S2");
  assert.equal(ocupacaoImpedeCandidato(porSalao, "T", tarde, [ocup("1", "15:00", "19:00", "T", "S1"), ocup("2", "13:00", "14:00", "T", "S2")]), false, "S2 com intervalo exato");
  assert.equal(ocupacaoImpedeCandidato(porSalao, "T", tarde, [ocup("1", "16:00", "17:00", "T", null)]), true, "festa sem salão ocupa todos");
});

// 2c-2: horário livre — qualquer início no passo, fim pela duração, dentro do dia.
test("horário livre: inícios no passo com o fim pela duração, sem passar da meia-noite", async () => {
  const { gerarCandidatosLivres } = await import("../disponibilidade/services/availability.service.ts");
  const quatroHoras = gerarCandidatosLivres(30, 240);
  assert.deepEqual(quatroHoras.slice(0, 2).map((c) => [c.inicio, c.fim, c.ajusteMinutos]), [["00:00", "04:00", 0], ["00:30", "04:30", 30]]);
  assert.deepEqual(quatroHoras.at(-1) && [quatroHoras.at(-1)!.inicio, quatroHoras.at(-1)!.fim], ["19:30", "23:30"]);
  assert.equal(quatroHoras.every((c) => c.fimMinutos < 24 * 60 && c.fimMinutos - c.inicioMinutos === 240), true);
  assert.equal(gerarCandidatosLivres(60, 180).length, 21, "00:00 até 20:00 de hora em hora");
});

// Parecer do Astra (22/10/2026): hold conta UMA festa; interseção horário × pacote vazia impede o candidato.
test("capacidade: remarcação em hold conta uma festa só; salões do pacote restringem os do horário", async () => {
  const { ocupacaoImpedeCandidato } = await import("../disponibilidade/services/availability.service.ts");
  const tarde = { inicioMinutos: 15 * 60, fimMinutos: 19 * 60 };
  const ocup = (f: string, cfg: string, salao: string | null = null) =>
    ({ fechamentoId: f, data: "2026-11-21", horarioInicio: "15:00", horarioFim: "19:00", configuracaoAgendaId: cfg, salaoId: salao });
  const porHorario = { capacidadeTipo: "POR_HORARIO" as const, limiteFestasDia: null, intervaloMinimoMinutos: 0,
    capacidadePorHorario: { T: 2 }, saloesPorHorario: {}, saloesDoEscopo: [] };
  // A mesma festa confirmada e o destino do hold no mesmo horário: 1 de 2, ainda cabe outra.
  assert.equal(ocupacaoImpedeCandidato(porHorario, "T", tarde, [ocup("1", "T"), ocup("1", "T")]), false);
  const porSalao = { capacidadeTipo: "POR_SALAO" as const, limiteFestasDia: null, intervaloMinimoMinutos: 0,
    capacidadePorHorario: {}, saloesPorHorario: { T: ["S1"] }, saloesDoEscopo: ["S1", "S2"] };
  assert.equal(ocupacaoImpedeCandidato(porSalao, "T", tarde, [], ["S2"]), true, "horário só S1 × pacote só S2: sem salão possível");
  assert.equal(ocupacaoImpedeCandidato(porSalao, "T", tarde, [], ["S1", "S2"]), false);
  assert.equal(ocupacaoImpedeCandidato(porSalao, "T", tarde, [ocup("9", "T", "S1")], ["S1"]), true, "o único salão em comum está ocupado");
});
