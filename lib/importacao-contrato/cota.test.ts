import assert from "node:assert/strict";
import test from "node:test";
import { EXTRA_MIGRACAO, FRANQUIA_IMPORTACAO, JANELA_MIGRACAO_DIAS, PRAZO_RESERVA_MINUTOS, decidirPeriodo, periodoNormal } from "./cota.ts";

/** L2: regras puras da cota (números LITERAIS das decisões de Felipe; a regra nunca é o próprio oráculo). */

test("números de D-LOTE-6 e D-LOTE-8, literais", () => {
  assert.deepEqual(FRANQUIA_IMPORTACAO, {
    essencial: { quantidade: 5, periodo: "IMPLANTACAO" },
    profissional: { quantidade: 10, periodo: "MENSAL" },
    premium: { quantidade: 30, periodo: "MENSAL" },
  });
  assert.deepEqual(EXTRA_MIGRACAO, { essencial: 50, profissional: 100, premium: 200 });
  assert.equal(PRAZO_RESERVA_MINUTOS, 15);
  assert.equal(JANELA_MIGRACAO_DIAS, 30);
});

test("período normal: Essencial na implantação; os demais e sem plano no mês de São Paulo", () => {
  assert.equal(periodoNormal("essencial", "2026-11"), "IMPLANTACAO");
  assert.equal(periodoNormal("profissional", "2026-11"), "2026-11");
  assert.equal(periodoNormal("premium", "2026-11"), "2026-11");
  assert.equal(periodoNormal(null, "2026-11"), "2026-11");
});

test("decisão: extra antes da franquia, só com plano e janela aberta; franquia esgotada recusa; sem plano mede", () => {
  const base = { janelaAberta: true, usadosMigracao: 0, usadosPeriodo: 0, mes: "2026-11" };
  assert.deepEqual(decidirPeriodo({ ...base, plano: "profissional" }), { periodo: "MIGRACAO", limite: 100 });
  assert.deepEqual(decidirPeriodo({ ...base, plano: "profissional", usadosMigracao: 99 }), { periodo: "MIGRACAO", limite: 100 });
  assert.deepEqual(decidirPeriodo({ ...base, plano: "profissional", usadosMigracao: 100 }), { periodo: "2026-11", limite: 10 });
  assert.deepEqual(decidirPeriodo({ ...base, plano: "profissional", usadosMigracao: 100, usadosPeriodo: 9 }), { periodo: "2026-11", limite: 10 });
  assert.deepEqual(decidirPeriodo({ ...base, plano: "profissional", usadosMigracao: 100, usadosPeriodo: 10 }), { esgotada: true, plano: "profissional" });
  assert.deepEqual(decidirPeriodo({ ...base, plano: "profissional", janelaAberta: false }), { periodo: "2026-11", limite: 10 });
  assert.deepEqual(decidirPeriodo({ ...base, plano: "essencial", usadosMigracao: 50, usadosPeriodo: 4 }), { periodo: "IMPLANTACAO", limite: 5 });
  assert.deepEqual(decidirPeriodo({ ...base, plano: "essencial", usadosMigracao: 50, usadosPeriodo: 5 }), { esgotada: true, plano: "essencial" });
  assert.deepEqual(decidirPeriodo({ ...base, plano: "premium", usadosMigracao: 199 }), { periodo: "MIGRACAO", limite: 200 });
  assert.deepEqual(decidirPeriodo({ ...base, plano: "premium", usadosMigracao: 200, usadosPeriodo: 29 }), { periodo: "2026-11", limite: 30 });
  assert.deepEqual(decidirPeriodo({ ...base, plano: null, usadosMigracao: 0, usadosPeriodo: 1000 }), { periodo: "2026-11", limite: null }, "sem plano confirmado: sem extra e sem recusa");
});
