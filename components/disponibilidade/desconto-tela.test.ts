import { test } from "node:test";
import assert from "node:assert/strict";
import { avisoDescontoAgenda, descontoDoDia } from "./desconto-tela.ts";
import type { RegraDescontoDiaPublica } from "../../lib/comercial/descontos-dia.ts";
import type { DisponibilidadeDataPublica } from "../../lib/disponibilidade/services/models.ts";

const regra = (dia: number, percentual: number, extra: Partial<RegraDescontoDiaPublica> = {}): RegraDescontoDiaPublica => ({
  dia, percentual, titulo: `${percentual}% de desconto de segunda a quinta`, vigenciaInicio: "2026-01-01", vigenciaFim: null, configuracaoId: null, prioridade: 100, ...extra,
});
const kidmais = [1, 2, 3, 4].map((d) => regra(d, 15));

function dia(data: string, periodos: { status?: string; configuracaoId?: string | null; motivoComercial?: string | null }[]): DisponibilidadeDataPublica {
  return {
    data,
    periodos: periodos.map((p, i) => ({ codigo: `P${i}`, status: p.status ?? "DISPONIVEL", configuracaoId: p.configuracaoId ?? `cfg${i}`, motivoComercial: p.motivoComercial ?? null })),
  } as unknown as DisponibilidadeDataPublica;
}

// 2026-11-24 é terça; 2026-11-28 é sábado.
test("dia útil com o mesmo percentual em todos os pacotes mostra -15%", () => {
  const r = descontoDoDia({ a: kidmais, b: kidmais }, dia("2026-11-24", [{}, {}]));
  assert.equal(r?.selo, "-15%");
  assert.equal(r?.ate, false);
  assert.equal(r?.titulo, "15% de desconto no pacote nesta data");
  assert.equal(r?.regra, "15% de desconto de segunda a quinta");
});

test("sábado sem regra não mostra desconto", () => {
  assert.equal(descontoDoDia({ a: kidmais }, dia("2026-11-28", [{}])), null);
});

test("pacote sem desconto no dia vira 'até'", () => {
  const r = descontoDoDia({ a: kidmais, b: [] }, dia("2026-11-24", [{}]));
  assert.equal(r?.selo, "até 15%");
  assert.equal(r?.ate, true);
  assert.equal(r?.titulo, "Até 15% de desconto no pacote nesta data");
});

test("regra de um só horário conta apenas quando esse período está livre", () => {
  const soNoite = [regra(2, 20, { configuracaoId: "noite" })];
  assert.equal(descontoDoDia({ a: soNoite }, dia("2026-11-24", [{ configuracaoId: "tarde" }])), null);
  assert.equal(descontoDoDia({ a: soNoite }, dia("2026-11-24", [{ configuracaoId: "noite", status: "OCUPADO" }])), null);
  assert.equal(descontoDoDia({ a: soNoite }, dia("2026-11-24", [{ configuracaoId: "noite" }]))?.selo, "-20%");
  assert.equal(descontoDoDia({ a: soNoite }, dia("2026-11-24", [{ configuracaoId: "noite" }, { configuracaoId: "tarde" }]))?.selo, "até 20%");
});

test("período com bloqueio comercial não conta", () => {
  assert.equal(descontoDoDia({ a: kidmais }, dia("2026-11-24", [{ motivoComercial: "MINIMO" }])), null);
});

test("sem regras, sem dia ou sem período livre não mostra nada", () => {
  assert.equal(descontoDoDia(undefined, dia("2026-11-24", [{}])), null);
  assert.equal(descontoDoDia({}, dia("2026-11-24", [{}])), null);
  assert.equal(descontoDoDia({ a: kidmais }, undefined), null);
  assert.equal(descontoDoDia({ a: kidmais }, dia("2026-11-24", [])), null);
});

test("percentual acima de 100 é limitado", () => {
  assert.equal(descontoDoDia({ a: [regra(2, 150)] }, dia("2026-11-24", [{}]))?.selo, "-100%");
});

test("faixa da agenda junta as regras de todos os pacotes", () => {
  assert.equal(avisoDescontoAgenda({ a: kidmais, b: kidmais }, "2026-11-23"), "Economize 15% escolhendo de segunda a quinta.");
  assert.equal(avisoDescontoAgenda(undefined, "2026-11-23"), null);
  assert.equal(avisoDescontoAgenda({ a: [] }, "2026-11-23"), null);
  assert.equal(avisoDescontoAgenda({ a: [regra(2, 15, { vigenciaFim: "2026-11-01" })] }, "2026-11-23"), null);
});
