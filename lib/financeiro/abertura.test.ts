import assert from "node:assert/strict";
import test from "node:test";
import {
  atributosMovimento,
  chaveOrigem,
  hashConjunto,
  pendenciasDaAbertura,
  saldoDoPeriodo,
  somaMovimentos,
  ultimaConferencia,
  type AberturaVigente,
  type MovimentoCaixa,
} from "./abertura.ts";
import { mapearManual, type LinhaManual } from "./servico.ts";

const abertura: AberturaVigente = { id: "ab-1", versao: 1, dataBase: "2026-11-10", saldoCentavos: 100_000, confirmadaEm: "2026-11-14" };

function mov(tipo: MovimentoCaixa["tipo"], origemId: string, data: string, centavos: number): MovimentoCaixa {
  return { tipo, origemId, data, centavos, taxaCentavos: 0, estado: "EFETIVO", descricao: origemId, festaId: null, forma: "PIX" };
}

const movimentos = [
  mov("RECEBIMENTO", "r-antes", "2026-11-09", 5_000),
  mov("RECEBIMENTO", "r-d0", "2026-11-10", 2_000),
  mov("SAIDA", "s-12", "2026-11-12", -3_000),
  mov("ENTRADA_MANUAL", "m-15", "2026-11-15", 1_000),
];
const soma = (de: string, ate: string) => somaMovimentos(movimentos, de, ate);

test("C.2.1: sem abertura não há saldo absoluto, nunca zero", () => {
  assert.deepEqual(saldoDoPeriodo(null, "2026-11-01", "2026-11-30", soma), { saldoInicialCentavos: null, saldoFinalCentavos: null, motivoSaldo: "SEM_ABERTURA", dataBase: null });
});

test("C.2.1: período inteiro antes de D0", () => {
  const r = saldoDoPeriodo(abertura, "2026-11-01", "2026-11-09", soma);
  assert.equal(r.saldoInicialCentavos, null);
  assert.equal(r.saldoFinalCentavos, null);
  assert.equal(r.motivoSaldo, "ANTERIOR_A_ABERTURA");
});

test("C.2.1: período que atravessa D0 só tem saldo final, sem contar o que veio antes de D0", () => {
  const r = saldoDoPeriodo(abertura, "2026-11-01", "2026-11-15", soma);
  assert.equal(r.saldoInicialCentavos, null);
  assert.equal(r.saldoFinalCentavos, 100_000 + 2_000 - 3_000 + 1_000);
  assert.equal(r.motivoSaldo, "ATRAVESSA_ABERTURA");
});

test("C.2.1: período começando em D0 parte da abertura e inclui o próprio D0", () => {
  const r = saldoDoPeriodo(abertura, "2026-11-10", "2026-11-12", soma);
  assert.equal(r.saldoInicialCentavos, 100_000);
  assert.equal(r.saldoFinalCentavos, 99_000);
  assert.equal(r.motivoSaldo, null);
});

test("C.2.1: período depois de D0 e contiguidade entre períodos", () => {
  const r = saldoDoPeriodo(abertura, "2026-11-13", "2026-11-15", soma);
  assert.equal(r.saldoInicialCentavos, 99_000);
  assert.equal(r.saldoFinalCentavos, 100_000);
  const anterior = saldoDoPeriodo(abertura, "2026-11-10", "2026-11-12", soma);
  assert.equal(anterior.saldoFinalCentavos, r.saldoInicialCentavos);
});

test("C.2.2: pendência é movimento da janela D0..véspera sem conferência ou com atributo mudado", () => {
  const conferidos = new Map([[chaveOrigem(movimentos[1]), atributosMovimento(movimentos[1])]]);
  const p = pendenciasDaAbertura(abertura, movimentos, conferidos);
  // r-antes está antes de D0; m-15 é depois da véspera da confirmação (14/11).
  assert.deepEqual(p.itens.map((m) => m.origemId), ["s-12"]);
  assert.equal(p.quantidade, 1);
  assert.equal(p.centavos, 3_000, "o aviso soma em módulo");

  const alterado = movimentos.map((m) => (m.origemId === "r-d0" ? { ...m, centavos: 2_500 } : m));
  assert.deepEqual(pendenciasDaAbertura(abertura, alterado, conferidos).itens.map((m) => m.origemId).sort(), ["r-d0", "s-12"]);

  const estornado = movimentos.map((m) => (m.origemId === "r-d0" ? { ...m, estado: "ESTORNADO" } : m));
  assert.equal(pendenciasDaAbertura(abertura, estornado, conferidos).quantidade, 2);
});

test("C.2.2: reconferência H1 → H2 → conferir H2 → nova mudança volta a pendente", () => {
  const alvo = movimentos[2]; // s-12, dentro da janela
  const h1 = atributosMovimento(alvo);
  const h2Mov = { ...alvo, centavos: -3_500 };
  const h3Mov = { ...alvo, centavos: -4_000 };
  const linha = (atributosHash: string, sequencia: number) => ({ origemTipo: alvo.tipo, origemId: alvo.origemId, atributosHash, sequencia });
  const pendentes = (mov: MovimentoCaixa, historico: ReturnType<typeof linha>[]) =>
    pendenciasDaAbertura(abertura, [mov], ultimaConferencia(historico)).quantidade;

  assert.equal(pendentes(alvo, [linha(h1, 1)]), 0, "H1 conferido");
  assert.equal(pendentes(h2Mov, [linha(h1, 1)]), 1, "mudou para H2: pendente");
  const historico = [linha(h1, 1), linha(atributosMovimento(h2Mov), 2)];
  assert.equal(pendentes(h2Mov, historico), 0, "H2 conferido na sequência 2: resolvido");
  assert.equal(pendentes(h3Mov, historico), 1, "nova mudança: pendente de novo");
  assert.equal(pendentes(h2Mov, [...historico].reverse()), 0, "a ordem das linhas não decide; vale a maior sequência");
  assert.equal(pendentes(alvo, historico), 1, "voltar a H1 não reabre a conferência antiga: vale a última (H2)");
});

test("ultimaConferencia separa origens pelo tipo e pelo id", () => {
  const mapa = ultimaConferencia([
    { origemTipo: "SAIDA", origemId: "x", atributosHash: "a", sequencia: 1 },
    { origemTipo: "RECEBIMENTO", origemId: "x", atributosHash: "b", sequencia: 3 },
    { origemTipo: "SAIDA", origemId: "x", atributosHash: "c", sequencia: 2 },
  ]);
  assert.deepEqual([...mapa].sort(), [["RECEBIMENTO:x", "b"], ["SAIDA:x", "c"]]);
});

test("C.2.2: abertura confirmada no próprio D0 não tem janela a conferir", () => {
  const noDia = { ...abertura, confirmadaEm: abertura.dataBase };
  assert.equal(pendenciasDaAbertura(noDia, movimentos, new Map()).quantidade, 0);
  assert.equal(pendenciasDaAbertura(null, movimentos, new Map()).quantidade, 0);
});

test("hash do conjunto não depende da ordem e muda com qualquer atributo", () => {
  const invertido = [...movimentos].reverse();
  assert.equal(hashConjunto(movimentos), hashConjunto(invertido));
  assert.notEqual(hashConjunto(movimentos), hashConjunto(movimentos.map((m, i) => (i === 0 ? { ...m, taxaCentavos: 1 } : m))));
  assert.match(atributosMovimento(movimentos[0]), /^[0-9a-f]{64}$/);
  assert.notEqual(atributosMovimento(movimentos[0]), atributosMovimento({ ...movimentos[0], data: "2026-11-08" }));
});

function manual(campos: Partial<LinhaManual>): LinhaManual {
  return { id: "e-1", descricao: "Locação", contraparte: null, festa_id: null, festa: null, valor: "300.00", vencimento: "2026-11-20", forma: "PIX", recebido_em: null, taxa: "0", ...campos };
}

test("entrada manual: R$ 100 recebidos de R$ 300 é parcial, com R$ 200 de saldo", () => {
  const r = mapearManual(manual({ recebido: "100.00" }), "2026-11-09");
  assert.equal(r.recebidoCentavos, 10_000);
  assert.equal(r.saldoCentavos, 20_000);
  assert.equal(r.status, "Parcialmente pago");
});

test("entrada manual: leitura anterior à P2 vale 0% ou 100% pelo recebido_em", () => {
  assert.equal(mapearManual(manual({ recebido_em: "2026-11-05" }), "2026-11-09").saldoCentavos, 0);
  assert.equal(mapearManual(manual({}), "2026-11-09").recebidoCentavos, 0);
});

test("entrada manual: soma acima do valor não gera saldo negativo", () => {
  const r = mapearManual(manual({ recebido: "350.00" }), "2026-11-09");
  assert.equal(r.recebidoCentavos, 30_000);
  assert.equal(r.saldoCentavos, 0);
  assert.equal(r.status, "Pago");
});
