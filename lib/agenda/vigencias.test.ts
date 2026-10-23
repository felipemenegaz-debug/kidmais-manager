import assert from "node:assert/strict";
import test from "node:test";
import { linhaDoTempo, type Trecho } from "./vigencias.ts";

// Parecer do Astra (P2): regras de vários horários juntas no horário livre, sem sobreposição e sem perder trechos.
const hoje = "2026-10-22";
const categoria = (r: Trecho<string>[]) =>
  linhaDoTempo(r, hoje, (ativos) => (ativos.includes("NOBRE") ? "NOBRE" : "PADRAO"), (a, b) => a === b, "PADRAO");

test("PADRAO sem término + NOBRE a partir de dezembro: dois trechos sem sobreposição", () => {
  assert.deepEqual(categoria([
    { inicio: "2026-01-01", fim: null, valor: "PADRAO" },
    { inicio: "2026-12-01", fim: null, valor: "NOBRE" },
  ]), [
    { inicio: "2026-10-22", fim: "2026-11-30", valor: "PADRAO" },
    { inicio: "2026-12-01", fim: null, valor: "NOBRE" },
  ]);
});

test("mesmo início: NOBRE até novembro e PADRAO sem término — o trecho PADRAO depois de novembro não se perde", () => {
  assert.deepEqual(categoria([
    { inicio: "2026-10-01", fim: "2026-11-30", valor: "NOBRE" },
    { inicio: "2026-10-01", fim: null, valor: "PADRAO" },
  ]), [
    { inicio: "2026-10-22", fim: "2026-11-30", valor: "NOBRE" },
    { inicio: "2026-12-01", fim: null, valor: "PADRAO" },
  ]);
});

test("promoção futura com término continua futura e termina; buracos viram PADRAO; trechos iguais se unem", () => {
  assert.deepEqual(categoria([{ inicio: "2026-12-10", fim: "2026-12-20", valor: "NOBRE" }]), [
    { inicio: "2026-10-22", fim: "2026-12-09", valor: "PADRAO" },
    { inicio: "2026-12-10", fim: "2026-12-20", valor: "NOBRE" },
    { inicio: "2026-12-21", fim: null, valor: "PADRAO" },
  ]);
  assert.deepEqual(categoria([]), [{ inicio: hoje, fim: null, valor: "PADRAO" }]);
  assert.deepEqual(categoria([{ inicio: "2026-01-01", fim: "2026-10-01", valor: "NOBRE" }]), [{ inicio: hoje, fim: null, valor: "PADRAO" }], "regra vencida");
});

test("sem preenchimento: só os trechos com regra (disponibilidade e desconto)", () => {
  const disponivel = linhaDoTempo(
    [{ inicio: "2026-11-01", fim: "2026-11-10", valor: 1 }, { inicio: "2026-11-05", fim: "2026-11-20", valor: 1 }],
    hoje, () => true, () => true,
  );
  assert.deepEqual(disponivel, [{ inicio: "2026-11-01", fim: "2026-11-20", valor: true }]);
});
