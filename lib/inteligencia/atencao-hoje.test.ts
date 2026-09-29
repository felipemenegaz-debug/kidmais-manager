import assert from "node:assert/strict";
import test from "node:test";
import { ZodError } from "zod";
import type { Recebivel } from "../financeiro/servico.ts";
import { atencaoHoje, montarAtencaoHoje } from "./atencao-hoje.ts";
import { SEM_PORTAS } from "./ferramentas.ts";

const contexto = { hoje: "2026-09-28", geradoEm: "2026-09-28T15:00:00.000Z", portas: SEM_PORTAS };

function recebivel(parcial: Partial<Recebivel> & Pick<Recebivel, "id" | "status" | "vencimento" | "saldoCentavos">): Recebivel {
  return {
    origem: "CONTRATO",
    pagamentoId: "pagamento-sigiloso",
    cliente: "Maria Sigilosa da Silva",
    festaId: "festa-sigilosa",
    pacote: "Pacote Premium Sigiloso",
    data: "2026-10-10",
    parcela: 1,
    valorCentavos: parcial.saldoCentavos,
    recebidoCentavos: 0,
    forma: "PIX",
    diasAtraso: 0,
    ...parcial,
  };
}

test("sem recebíveis responde explicitamente que não há dados suficientes", () => {
  const resultado = montarAtencaoHoje([], contexto);
  assert.equal(resultado.estado, "sem_dados");
  assert.deepEqual(resultado.itens, []);
  assert.match(resultado.resumo, /Não há dados suficientes/);
  assert.deepEqual(resultado.referencia, { hoje: "2026-09-28", geradoEm: "2026-09-28T15:00:00.000Z", fonte: "financeiro.recebiveis" });
});

test("vencidos, vencendo hoje e em aberto viram itens priorizados com evidência que fecha a conta", () => {
  const resultado = montarAtencaoHoje([
    recebivel({ id: "v1", status: "Vencido", vencimento: "2026-09-20", saldoCentavos: 300000, diasAtraso: 8 }),
    recebivel({ id: "v2", status: "Vencido", vencimento: "2026-09-25", saldoCentavos: 250000, diasAtraso: 3 }),
    recebivel({ id: "v3", status: "Vencido", vencimento: "2026-08-28", saldoCentavos: 300000, diasAtraso: 31, origem: "ENTRADA_MANUAL" }),
    recebivel({ id: "h1", status: "A receber", vencimento: "2026-09-28", saldoCentavos: 50000 }),
    recebivel({ id: "f1", status: "Parcialmente pago", vencimento: "2026-10-05", saldoCentavos: 20000 }),
    recebivel({ id: "p1", status: "Pago", vencimento: "2026-09-01", saldoCentavos: 0 }),
    recebivel({ id: "c1", status: "Cancelado", vencimento: "2026-09-01", saldoCentavos: 90000 }),
  ], contexto);

  assert.equal(resultado.estado, "atencao");
  assert.equal(resultado.resumo, "Existem 3 pagamentos vencidos que precisam de atenção. Além disso, 1 vence hoje.");
  assert.deepEqual(resultado.itens.map((item) => [item.tipo, item.prioridade]), [
    ["RECEBIVEIS_VENCIDOS", "alta"],
    ["RECEBIVEIS_VENCEM_HOJE", "media"],
    ["A_RECEBER_EM_ABERTO", "baixa"],
  ]);

  const [vencidos, hoje, abertos] = resultado.itens;
  assert.equal(vencidos.titulo, "3 pagamentos vencidos");
  assert.equal(vencidos.detalhe, "R$ 8.500,00 em aberto. O mais antigo venceu há 31 dias.");
  assert.deepEqual(vencidos.evidencia, { fonte: "financeiro.recebiveis", quantidade: 3, valorCentavos: 850000, maiorAtrasoDias: 31 });
  assert.equal(vencidos.destino, "/admin/financeiro/contas-receber");

  assert.equal(hoje.titulo, "1 pagamento vence hoje");
  assert.equal(hoje.evidencia.valorCentavos, 50000);
  assert.equal(abertos.evidencia.quantidade, 5);
  assert.equal(abertos.evidencia.valorCentavos, 850000 + 50000 + 20000);
});

test("a evidência é só agregada: sem registros individuais, ids, nome, pacote, forma ou vínculos", () => {
  const resultado = montarAtencaoHoje([
    recebivel({ id: "id-v1-individual", status: "Vencido", vencimento: "2026-09-20", saldoCentavos: 1000, diasAtraso: 8 }),
    recebivel({ id: "id-h1-individual", status: "A receber", vencimento: "2026-09-28", saldoCentavos: 500 }),
  ], contexto);
  const permitidas = ["fonte", "maiorAtrasoDias", "quantidade", "valorCentavos"];
  for (const item of resultado.itens) {
    assert.deepEqual(Object.keys(item).sort(), ["destino", "detalhe", "evidencia", "prioridade", "tipo", "titulo"]);
    assert.ok(Object.keys(item.evidencia).every((chave) => permitidas.includes(chave)), item.tipo);
  }
  const texto = JSON.stringify(resultado);
  for (const proibido of ["id-v1", "id-h1", "Maria", "Sigilos", "Premium", "PIX", "pagamento-sigiloso", "festa-sigilosa", "2026-09-20", "registros"]) {
    assert.equal(texto.includes(proibido), false, proibido);
  }
});

test("sem pendência hoje o estado é em dia, com texto humano", () => {
  const futuro = montarAtencaoHoje([recebivel({ id: "f1", status: "A receber", vencimento: "2026-10-05", saldoCentavos: 20000 })], contexto);
  assert.equal(futuro.estado, "em_dia");
  assert.equal(futuro.resumo, "Nenhum pagamento vencido ou vencendo hoje.");
  const quitado = montarAtencaoHoje([recebivel({ id: "p1", status: "Pago", vencimento: "2026-09-01", saldoCentavos: 0 })], contexto);
  assert.equal(quitado.estado, "em_dia");
  assert.deepEqual(quitado.itens, []);
  assert.equal(quitado.resumo, "Nenhum recebível em aberto no momento.");
});

test("volume grande não aumenta a resposta: continua agregada", () => {
  const muitos = Array.from({ length: 500 }, (_, i) =>
    recebivel({ id: `v${i}`, status: "Vencido", vencimento: "2026-09-01", saldoCentavos: 100, diasAtraso: 27 }));
  const resultado = montarAtencaoHoje(muitos, contexto);
  const [vencidos] = resultado.itens;
  assert.equal(vencidos.evidencia.quantidade, 500);
  assert.equal(vencidos.evidencia.valorCentavos, 50000);
  assert.ok(JSON.stringify(resultado).length < 2000);
});

test("a ferramenta aceita somente parâmetros vazios e nunca uma empresa", () => {
  assert.equal(typeof atencaoHoje.preparar({}), "function");
  assert.equal(atencaoHoje.classe, "READ");
  for (const invalido of [{ empresaId: "22222222-2222-4222-8222-222222222222" }, { hoje: "2020-01-01" }, "texto", null, []]) {
    assert.throws(() => atencaoHoje.preparar(invalido), ZodError, JSON.stringify(invalido));
  }
});
