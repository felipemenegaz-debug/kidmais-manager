import assert from "node:assert/strict";
import test from "node:test";
import type { OcupacaoConfirmadaRecord, RegraCapacidadeAgenda } from "../repositories/models.ts";

// S-C (convidados primeiro): "salão comporta N" = capacidade NULL ou >= N; sem convidados, tudo como antes.
const tarde = { inicioMinutos: 15 * 60, fimMinutos: 19 * 60 };
const ocup = (f: string, salao: string | null, ini = "15:00", fim = "19:00"): OcupacaoConfirmadaRecord =>
  ({ fechamentoId: f, data: "2026-11-21", horarioInicio: ini, horarioFim: fim, configuracaoAgendaId: "T", salaoId: salao });
const regra = (capacidade: Record<string, number | null>, extra: Partial<RegraCapacidadeAgenda> = {}): RegraCapacidadeAgenda => ({
  capacidadeTipo: "POR_SALAO", limiteFestasDia: null, intervaloMinimoMinutos: 60, capacidadePorHorario: {},
  saloesPorHorario: { T: Object.keys(capacidade) }, saloesDoEscopo: Object.keys(capacidade), capacidadePorSalao: capacidade, ...extra,
});
const carregar = () => import("./availability.service.ts");

test("S-C: salão comporta N — NULL comporta, igual comporta, menor não", async () => {
  const { salaoComporta } = await carregar();
  const r = regra({ P: 50, G: 120, X: null });
  assert.equal(salaoComporta(r, "P", 50), true, "igual");
  assert.equal(salaoComporta(r, "P", 51), false, "menor que N");
  assert.equal(salaoComporta(r, "G", 80), true, "maior");
  assert.equal(salaoComporta(r, "X", 999), true, "sem capacidade informada comporta");
  assert.equal(salaoComporta({}, "P", 80), true, "regra sem capacidade por salão (antes da S-C) comporta");
});

test("S-C: com convidados, só salão livre que comporta libera o candidato", async () => {
  const { ocupacaoImpedeCandidato } = await carregar();
  const r = regra({ P: 50, G: 120 });
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [], null, 80), false, "G livre comporta 80");
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [ocup("1", "G")], null, 80), true, "só P livre e não comporta 80");
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [ocup("1", "G")], null, 40), false, "P comporta 40");
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [], null, 130), true, "nenhum comporta 130");
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, [], ["P"], 80), true, "pacote só no salão pequeno");
  assert.equal(ocupacaoImpedeCandidato(regra({ P: 50, X: null }), "T", tarde, [ocup("1", "P")], null, 500), false, "NULL livre comporta");
});

test("S-C: sem convidados o resultado é idêntico ao de antes (tabela de casos)", async () => {
  const { ocupacaoImpedeCandidato } = await carregar();
  const r = regra({ P: 50, G: 120 });
  const casos: Array<[OcupacaoConfirmadaRecord[], string[] | null, boolean]> = [
    [[], null, false], [[ocup("1", "G")], null, false], [[ocup("1", "G"), ocup("2", "P")], null, true],
    [[ocup("1", null)], null, true], [[], ["P"], false], [[ocup("1", "P")], ["P"], true],
    [[ocup("1", "P", "13:30", "14:30")], ["P"], true], [[ocup("1", "P", "13:00", "14:00")], ["P"], false],
  ];
  for (const [ocupacoes, pacote, esperado] of casos) {
    assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, ocupacoes, pacote), esperado, JSON.stringify([ocupacoes, pacote]));
    assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, ocupacoes, pacote, null), esperado, "convidados null = sem convidados");
    assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, ocupacoes, pacote, 0), esperado, "0 não é informado");
    // Com N que todos comportam, a capacidade não muda nada.
    assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, ocupacoes, pacote, 10), esperado, "N pequeno");
  }
});

test("S-C: por horário (um salão) os convidados não mudam a disponibilidade", async () => {
  const { ocupacaoImpedeCandidato, capacidadeDoCandidato } = await carregar();
  const porHorario: RegraCapacidadeAgenda = { capacidadeTipo: "POR_HORARIO", limiteFestasDia: null, intervaloMinimoMinutos: 0,
    capacidadePorHorario: { T: 1 }, saloesPorHorario: {}, saloesDoEscopo: [], capacidadePorSalao: { P: 10 } };
  assert.equal(ocupacaoImpedeCandidato(porHorario, "T", tarde, [], null, 900), false);
  assert.equal(ocupacaoImpedeCandidato(porHorario, "T", tarde, [ocup("1", null)], null, 900), true);
  assert.equal(capacidadeDoCandidato(porHorario, "T", tarde, [], null, 900, false), null, "sem motivo de capacidade");
  assert.equal(capacidadeDoCandidato(null, "T", tarde, [], null, 900, false), null, "sem regra (antes da 094)");
});

test("S-C: limite do dia vem antes da capacidade (OCUPADO)", async () => {
  const { ocupacaoImpedeCandidato, capacidadeDoCandidato } = await carregar();
  const r = regra({ P: 50, G: 120 }, { limiteFestasDia: 1 });
  const manha = [ocup("1", "P", "09:00", "11:00")];
  assert.equal(ocupacaoImpedeCandidato(r, "T", tarde, manha, null, 80), true);
  assert.deepEqual(capacidadeDoCandidato(r, "T", tarde, manha, null, 80, false), { opcoes: 0, motivo: "OCUPADO" });
});

test("S-C: opções e motivo — 2 opções, só 1, ocupado, sem salão para N", async () => {
  const { opcoesDeSalao, capacidadeDoCandidato } = await carregar();
  const r = regra({ P: 90, G: 120 });
  assert.deepEqual(opcoesDeSalao(r, "T", tarde, [], null, 80), { comportam: 2, livres: 2, livresQueComportam: 2 });
  assert.deepEqual(capacidadeDoCandidato(r, "T", tarde, [], null, 80, false), { opcoes: 2, motivo: "OK" });
  assert.deepEqual(capacidadeDoCandidato(r, "T", tarde, [ocup("1", "P")], null, 80, false), { opcoes: 1, motivo: "OK" });
  assert.deepEqual(capacidadeDoCandidato(r, "T", tarde, [ocup("1", "P"), ocup("2", "G")], null, 80, false), { opcoes: 0, motivo: "OCUPADO" });
  assert.deepEqual(capacidadeDoCandidato(r, "T", tarde, [], null, 80, true), { opcoes: 0, motivo: "OCUPADO" }, "bloqueio da data");
  const pequenoMaisGrande = regra({ P: 50, G: 120 });
  assert.deepEqual(capacidadeDoCandidato(pequenoMaisGrande, "T", tarde, [ocup("1", "G")], null, 80, false), { opcoes: 0, motivo: "CAPACIDADE" },
    "há salão livre, mas nenhum livre comporta");
  assert.deepEqual(capacidadeDoCandidato(pequenoMaisGrande, "T", tarde, [ocup("1", "G"), ocup("2", "P")], null, 130, false), { opcoes: 0, motivo: "CAPACIDADE" },
    "nenhum salão do horário comporta: CAPACIDADE mesmo ocupado (trocar a data não resolve)");
  assert.equal(opcoesDeSalao(regra({}), "T", tarde, [], null, 80), null, "sem salão candidato");
});

test("S-C: combinado (098) usa a própria capacidade e o cruzamento de conjuntos", async () => {
  const { capacidadeDoCandidato } = await carregar();
  const conjuntos = { A: ["A"], B: ["B"], AB: ["A", "B"] };
  const r = regra({ A: 60, B: 60, AB: 150 }, { conjuntos });
  assert.deepEqual(capacidadeDoCandidato(r, "T", tarde, [], null, 100, false), { opcoes: 1, motivo: "OK" }, "só o combinado comporta 100");
  assert.deepEqual(capacidadeDoCandidato(r, "T", tarde, [ocup("1", "A")], null, 100, false), { opcoes: 0, motivo: "CAPACIDADE" },
    "A ocupado impede AB; B livre não comporta");
  assert.deepEqual(capacidadeDoCandidato(r, "T", tarde, [ocup("1", "A")], null, 50, false), { opcoes: 1, motivo: "OK" });
});

test("S-C: soma por período e por dia", async () => {
  const { motivoAgregado } = await carregar();
  assert.equal(motivoAgregado([]), null);
  assert.equal(motivoAgregado([null, undefined]), null);
  assert.deepEqual(motivoAgregado([{ opcoes: 0, motivo: "OCUPADO" }, { opcoes: 1, motivo: "OK" }, { opcoes: 2, motivo: "OK" }]), { opcoes: 2, motivo: "OK" });
  assert.deepEqual(motivoAgregado([{ opcoes: 0, motivo: "OCUPADO" }, { opcoes: 0, motivo: "CAPACIDADE" }]), { opcoes: 0, motivo: "CAPACIDADE" });
  assert.deepEqual(motivoAgregado([{ opcoes: 0, motivo: "OCUPADO" }]), { opcoes: 0, motivo: "OCUPADO" });
});
