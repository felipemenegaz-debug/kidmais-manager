import test from "node:test";
import assert from "node:assert/strict";
import { tuplasVersaoAgenda, versaoAgenda, versaoInformada, type LinhaHorarioProjecao, type LinhaSalaoProjecao, type ProjecaoVersao } from "./versao-agenda.ts";

/**
 * Plano "Agenda: concorrência otimista do agregado" (rev. 1.1), sem banco:
 * - T-A1 (puro): tuplas posicionais, ordem por id (unidades de código), null ≠ [] ≠ "", prefixo va1;
 * - T-A2 (puro): cada campo da tupla muda a versão; T-A3 (puro): campos fora da tupla não mudam;
 * - P2-1: normalização da rota — só a string no formato exato é candidata.
 */
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "a1111111-1111-4111-8111-111111111111";
const H1 = "22222222-2222-4222-8222-222222222222";
const H2 = "b2222222-2222-4222-8222-222222222222";
const salao = (id: string, extra: Partial<LinhaSalaoProjecao> = {}): LinhaSalaoProjecao => ({
  id, nome: `Salão ${id.slice(0, 1)}`, capacidade_convidados: 100, ordem: 1, ativo: true, combinado: null, membros: null, ...extra,
});
const horario = (id: string, extra: Partial<LinhaHorarioProjecao> = {}): LinhaHorarioProjecao => ({
  id, codigo: `HORARIO_${id.slice(0, 1)}`, nome: "Tarde", inicio: "15:00:00.000000", fim: "19:00:00.000000", dias_semana: [6, 7], capacidade: 1,
  ordem_exibicao: 1, ativo: true, horario_livre: false, desativado_a_partir_de: null, tolerancia_inicio_minutos: 0, passo_inicio_minutos: 30, ...extra,
});
const base = (extra: Partial<ProjecaoVersao> = {}): ProjecaoVersao => ({
  empresaId: "33333333-3333-4333-8333-333333333333", estabelecimentoId: null, v098: false,
  config: { modo: "FIXO", capacidade_tipo: "POR_SALAO", limite_festas_dia: null, intervalo_minimo_minutos: 60 },
  saloes: [salao(S1), salao(S2, { ordem: 2 })],
  proprios: [horario(H1), horario(H2, { ordem_exibicao: 2, horario_livre: true, ativo: false })],
  nivel: "PROPRIO", herdados: [],
  vinculos: [{ configuracao_agenda_id: H1, salao_id: S1 }, { configuracao_agenda_id: H1, salao_id: S2 }],
  ...extra,
});

test("T-A1: formato va1 + 64 hex; mesmo estado, mesma versão; ordem das listas e das chaves não interfere", () => {
  const v = versaoAgenda(base());
  assert.match(v, /^va1:[0-9a-f]{64}$/);
  const invertido = base({
    saloes: [...base().saloes].reverse(),
    proprios: [...base().proprios].reverse().map((h) => Object.fromEntries(Object.entries(h).reverse()) as LinhaHorarioProjecao),
    vinculos: [...base().vinculos].reverse(),
  });
  assert.equal(versaoAgenda(invertido), v);
  // Ordem por unidades de código ("1…" < "a…"), não por localeCompare/collation.
  const tuplas = tuplasVersaoAgenda(base()) as unknown[];
  assert.deepEqual((tuplas[6] as unknown[][]).map((s) => s[0]), [S1, S2]);
  assert.deepEqual((tuplas[7] as unknown[][]).map((h) => h[0]), [H1, H2]);
});

test("T-A1: null, [] e texto vazio são estados distintos; dias sem remover repetidos; configuração ausente ≠ padrão", () => {
  const v = versaoAgenda(base());
  assert.notEqual(versaoAgenda(base({ proprios: [horario(H1, { dias_semana: null }), base().proprios[1]] })),
    versaoAgenda(base({ proprios: [horario(H1, { dias_semana: [1, 2, 3, 4, 5, 6, 7] }), base().proprios[1]] })), "NULL (todos) ≠ {1..7}");
  assert.equal(versaoAgenda(base({ proprios: [horario(H1, { dias_semana: [7, 6] }), base().proprios[1]] })), v, "dias normalizados por ordem");
  assert.notEqual(versaoAgenda(base({ proprios: [horario(H1, { dias_semana: [6, 7, 7] }), base().proprios[1]] })), v, "repetido gravado aparece");
  assert.notEqual(versaoAgenda(base({ saloes: [salao(S1, { capacidade_convidados: null }), base().saloes[1]] })), v, "capacidade NULL ≠ 100");
  assert.notEqual(versaoAgenda(base({ saloes: [salao(S1, { capacidade_convidados: null }), base().saloes[1]] })),
    versaoAgenda(base({ saloes: [salao(S1, { capacidade_convidados: 0 }), base().saloes[1]] })), "NULL não vira 0");
  assert.notEqual(versaoAgenda(base({ config: null })), v);
  assert.notEqual(versaoAgenda(base({ nivel: "NENHUM", proprios: [] })), versaoAgenda(base({ nivel: "GLOBAL", proprios: [], herdados: [] })));
  assert.notEqual(versaoAgenda(base({ saloes: [salao(S1, { nome: "" }), base().saloes[1]] })), versaoAgenda(base({ saloes: [salao(S1, { nome: " " }), base().saloes[1]] })), "texto sem trim");
});

test("T-A2: cada campo da tupla muda a versão", () => {
  const v = versaoAgenda(base());
  const casos: Array<[string, ProjecaoVersao]> = [
    ["empresa", base({ empresaId: "44444444-4444-4444-8444-444444444444" })],
    ["unidade", base({ estabelecimentoId: "55555555-5555-4555-8555-555555555555" })],
    ["098 instalada", base({ v098: true, saloes: base().saloes.map((s) => ({ ...s, combinado: false })) })],
    ["config.modo", base({ config: { ...base().config!, modo: "LIVRE" } })],
    ["config.capacidade_tipo", base({ config: { ...base().config!, capacidade_tipo: "POR_HORARIO" } })],
    ["config.limite", base({ config: { ...base().config!, limite_festas_dia: 3 } })],
    ["config.intervalo", base({ config: { ...base().config!, intervalo_minimo_minutos: 30 } })],
    ...(["nome", "capacidade_convidados", "ordem", "ativo"] as const).map((campo): [string, ProjecaoVersao] => [`salão.${campo}`,
      base({ saloes: [salao(S1, { [campo]: campo === "nome" ? "Outro" : campo === "ativo" ? false : 7 }), base().saloes[1]] })]),
    ["salão inativo", base({ saloes: [base().saloes[0], salao(S2, { ordem: 2, ativo: false, nome: "Velho" })] })],
    ["salão a mais", base({ saloes: [...base().saloes, salao("c1111111-1111-4111-8111-111111111111")] })],
    ...(["codigo", "nome", "inicio", "fim", "capacidade", "ordem_exibicao", "ativo", "horario_livre", "desativado_a_partir_de",
      "tolerancia_inicio_minutos", "passo_inicio_minutos"] as const).map((campo): [string, ProjecaoVersao] => {
      const valor: Record<string, unknown> = {
        codigo: "TURNO_9", nome: "Noite", inicio: "15:30:00.000000", fim: "19:30:00.000000", capacidade: 2, ordem_exibicao: 5, ativo: false,
        horario_livre: true, desativado_a_partir_de: "2026-12-01", tolerancia_inicio_minutos: 15, passo_inicio_minutos: 60,
      };
      return [`horário.${campo}`, base({ proprios: [horario(H1, { [campo]: valor[campo] }), base().proprios[1]] })];
    }),
    ["horário.dias", base({ proprios: [horario(H1, { dias_semana: [6] }), base().proprios[1]] })],
    ["horário livre (inativo) muda", base({ proprios: [base().proprios[0], horario(H2, { ordem_exibicao: 2, horario_livre: true, ativo: true })] })],
    ["vínculo removido", base({ vinculos: [base().vinculos[0]] })],
    ["vínculo acrescentado", base({ vinculos: [...base().vinculos, { configuracao_agenda_id: H2, salao_id: S1 }] })],
    ["nível EMPRESA", base({ nivel: "EMPRESA", herdados: [horario(H1)] })],
  ];
  for (const [nome, p] of casos) assert.notEqual(versaoAgenda(p), v, nome);
  // Herdados: cada nível e cada campo do herdado.
  const empresa = versaoAgenda(base({ nivel: "EMPRESA", proprios: [], herdados: [horario(H1)] }));
  assert.notEqual(versaoAgenda(base({ nivel: "GLOBAL", proprios: [], herdados: [horario(H1)] })), empresa, "GLOBAL ≠ EMPRESA");
  assert.notEqual(versaoAgenda(base({ nivel: "EMPRESA", proprios: [], herdados: [horario(H1, { tolerancia_inicio_minutos: 10 })] })), empresa, "tolerância do herdado");
  assert.notEqual(versaoAgenda(base({ nivel: "EMPRESA", proprios: [], herdados: [horario(H1, { passo_inicio_minutos: 15 })] })), empresa, "passo do herdado");
  // 098: combinado e membros (ordenados).
  const com098 = (membros: string[]) => base({ v098: true, saloes: [salao(S1, { combinado: false }), salao(S2, { combinado: true, membros })] });
  assert.equal(versaoAgenda(com098([S2, S1])), versaoAgenda(com098([S1, S2])), "membros ordenados");
  assert.notEqual(versaoAgenda(com098([S1])), versaoAgenda(com098([S1, S2])), "membros mudam");
});

test("T-A3: campos fora da tupla não mudam a versão (projeções com extras são ignoradas)", () => {
  const v = versaoAgenda(base());
  const comExtras = base({
    config: { ...base().config!, ...({ configurado_por: "Ana", configurado_em: "2026-10-22", atualizado_em: "x" } as object) },
    saloes: base().saloes.map((s) => ({ ...s, ...({ membros_info: [{ id: S1 }], criado_em: "agora" } as object) })),
  });
  assert.equal(versaoAgenda(comExtras), v);
  // Com nível PROPRIO, herdados não entram (o save não os lê).
  assert.equal(versaoAgenda(base({ herdados: [horario(H1)] })), v);
});

test("T-A1: tipos fora do contrato recusam (não há coerção silenciosa)", () => {
  assert.throws(() => versaoAgenda(base({ saloes: [salao(S1, { ordem: "1" as unknown as number })] })), /não é inteiro/);
  assert.throws(() => versaoAgenda(base({ saloes: [salao(S1, { ordem: null as unknown as number })] })), /não é inteiro/);
  assert.throws(() => versaoAgenda(base({ proprios: [horario(H1, { ativo: "true" as unknown as boolean })] })), /não é booleano/);
});

test("P2-1: versaoInformada só aceita a string no formato exato; todo o resto vira null", () => {
  const boa = versaoAgenda(base());
  assert.equal(versaoInformada(boa), boa);
  for (const valor of [undefined, null, 1, true, {}, [], [boa], "", " " + boa, boa + " ", boa.toUpperCase(), `va1:${"g".repeat(64)}`,
    `va1:${"a".repeat(63)}`, `va1:${"a".repeat(65)}`, `va0:${"a".repeat(64)}`, "x".repeat(500)]) {
    assert.equal(versaoInformada(valor), null, JSON.stringify(valor) ?? String(valor));
  }
});
