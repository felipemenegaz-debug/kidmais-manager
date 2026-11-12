import assert from "node:assert/strict";
import test from "node:test";
import {
  RECEBER_SQL,
  abatimentoDeLinha,
  consolidarTitulos,
  impressaoPedidoConta,
  leituraPeriodo,
  recebidoNoPeriodo,
  resumo,
  type ContaPagar,
  type LinhaReceber,
  type Recebivel,
} from "./servico.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { saldoItemVigente } from "../pagamentos/services/alteracao-financeira-core.ts";
import { escolherParcelaAberta } from "./calculos.ts";

const HOJE = "2026-11-07";

function linha(parcial: Partial<LinhaReceber> = {}): LinhaReceber {
  return {
    id: "a", pagamento_id: "p", numero: 1, valor: "1000.00", vencimento: "2026-12-01",
    status_gravado: "PENDENTE", status_pagamento: "AGUARDANDO_PAGAMENTO", status_contrato: "ASSINADO",
    cliente: "Ana", cliente_id: null, festa_id: "f", pacote: "Completa", data_evento: "2026-12-20", forma: "PIX",
    cronograma_id: null, item_id: null, item_saldo_inicial: null, item_recebido_base: null, item_estornado_base: null, item_vencimento: null,
    recebido: "0", estornado: "0",
    pos_contratado: "1000.00", pos_ajustes_centavos: "0", pos_recebido: "0", pos_estornado: "0", pos_devolvido_centavos: "0",
    ...parcial,
  };
}

function uma(parcial: Partial<LinhaReceber> = {}) {
  return consolidarTitulos([linha(parcial)], HOJE)[0];
}

/** Mesma regra de elegibilidade do Pix (`pix/recebimento.ts`) e de `prepararBaixa`. */
function elegivel(item: Recebivel) {
  return item.saldoCentavos > 0 && !["Cancelado", "Reembolsado", "Pago"].includes(item.status);
}

test("R$ 1.000 quitados: cobrável zero e sem Pix, com ou sem taxa", () => {
  const item = uma({ recebido: "1000.00", pos_recebido: "1000.00" });
  assert.equal(item.saldoCentavos, 0);
  assert.equal(item.status, "Pago");
  assert.equal(elegivel(item), false);
});

test("estorno parcial reabre só o estornado: era Pago com saldo zero", () => {
  const item = uma({ recebido: "1000.00", estornado: "400.00", pos_recebido: "1000.00", pos_estornado: "400.00", status_gravado: "PARCIALMENTE_PAGA" });
  assert.equal(item.saldoCentavos, 40000);
  assert.equal(item.recebidoCentavos, 60000);
  assert.equal(item.brutoRecebidoCentavos, 100000);
  assert.equal(item.estornadoCentavos, 40000);
  assert.equal(item.status, "Parcialmente pago");
  assert.equal(elegivel(item), true);
});

test("estorno total com obrigação vigente volta a ser cobrável, como aceita o motor", () => {
  const item = uma({ recebido: "1000.00", estornado: "1000.00", pos_recebido: "1000.00", pos_estornado: "1000.00", status_gravado: "ESTORNADA", status_pagamento: "ESTORNADO" });
  assert.equal(item.saldoCentavos, 100000);
  assert.equal(item.status, "A receber");
  assert.equal(elegivel(item), true);
});

test("estorno seguido de novo pagamento quita sem contar duas vezes", () => {
  const item = uma({ recebido: "1400.00", estornado: "400.00", pos_recebido: "1400.00", pos_estornado: "400.00" });
  assert.equal(item.saldoCentavos, 0);
  assert.equal(item.recebidoCentavos, 100000);
  assert.equal(item.status, "Pago");
});

test("contrato encerrado não cobra nada, mesmo com parcela pendente", () => {
  const cancelado = uma({ status_contrato: "CANCELADO" });
  assert.equal(cancelado.status, "Cancelado");
  assert.equal(cancelado.saldoCentavos, 0);
  assert.equal(elegivel(cancelado), false);
  const devolvido = uma({ status_pagamento: "CANCELADO", recebido: "500.00", estornado: "500.00", pos_recebido: "500.00", pos_estornado: "500.00" });
  assert.equal(devolvido.status, "Reembolsado");
  assert.equal(devolvido.saldoCentavos, 0);
});

test("parcela cancelada sem cronograma não tem saldo", () => {
  const item = uma({ status_gravado: "CANCELADA" });
  assert.equal(item.status, "Cancelado");
  assert.equal(item.saldoCentavos, 0);
});

test("redução reconhecida com devolução pendente: cobrável zero, sem Pix", () => {
  // R$ 1.000 recebidos, obrigação 600. A devolução pendente é reserva, não sai do caixa nem reabre a parcela.
  const item = uma({ cronograma_id: "c", recebido: "1000.00", pos_recebido: "1000.00", pos_ajustes_centavos: "-40000" });
  assert.equal(item.saldoCentavos, 0);
  assert.equal(item.status, "Pago");
  assert.equal(item.motor?.obrigacaoCentavos, 60000);
  assert.equal(item.motor?.liquidoCentavos, 100000);
  assert.equal(elegivel(item), false);
});

test("devolução concluída não reabre cobrança", () => {
  const item = uma({ cronograma_id: "c", recebido: "1000.00", pos_recebido: "1000.00", pos_ajustes_centavos: "-40000", pos_devolvido_centavos: "40000" });
  assert.equal(item.saldoCentavos, 0);
  assert.equal(item.motor?.liquidoCentavos, 60000);
});

test("saldo transferido de A para B: só B cobra, pelo saldo do item", () => {
  const titulos = consolidarTitulos([
    linha({ id: "a", cronograma_id: "c", recebido: "600.00", pos_recebido: "600.00" }),
    linha({
      id: "b", numero: 2, valor: "400.00", cronograma_id: "c", item_id: "ib", item_saldo_inicial: "40000",
      item_recebido_base: "0", item_estornado_base: "0", item_vencimento: "2026-12-10", pos_recebido: "600.00",
    }),
  ], HOJE);
  const a = titulos.find((item) => item.id === "a")!;
  const b = titulos.find((item) => item.id === "b")!;
  assert.equal(a.saldoCentavos, 0);
  assert.equal(elegivel(a), false);
  assert.equal(b.saldoCentavos, 40000);
  assert.equal(b.vencimento, "2026-12-10");
  assert.equal(elegivel(b), true);
});

test("item preservado no cronograma desconta o movimento depois da base", () => {
  const item = uma({
    valor: "1000.00", cronograma_id: "c", item_id: "i", item_saldo_inicial: "70000", item_recebido_base: "30000", item_estornado_base: "0",
    item_vencimento: "2026-12-15", recebido: "500.00", pos_recebido: "500.00",
  });
  assert.equal(item.valorCentavos, 100000);
  assert.equal(item.saldoCentavos, 50000);
  assert.equal(item.vencimento, "2026-12-15");
});

test("o saldo somado nunca passa da posição do pagamento", () => {
  const titulos = consolidarTitulos([
    linha({ id: "a", valor: "500.00", vencimento: "2026-12-01" }),
    linha({ id: "b", numero: 2, valor: "500.00", vencimento: "2027-01-01" }),
  ].map((item) => ({ ...item, pos_contratado: "800.00" })), HOJE);
  assert.equal(titulos.find((item) => item.id === "a")?.saldoCentavos, 50000);
  assert.equal(titulos.find((item) => item.id === "b")?.saldoCentavos, 30000);
});

test("duas alocações de um recebimento reduzem cada parcela, sem misturar", () => {
  const comum = { pos_contratado: "1000.00", pos_recebido: "700.00" };
  const titulos = consolidarTitulos([
    linha({ id: "a", valor: "500.00", recebido: "500.00", ...comum }),
    linha({ id: "b", numero: 2, valor: "500.00", vencimento: "2027-01-01", recebido: "200.00", ...comum }),
  ], HOJE);
  assert.equal(titulos.find((item) => item.id === "a")?.saldoCentavos, 0);
  assert.equal(titulos.find((item) => item.id === "b")?.saldoCentavos, 30000);
});

test("a conta do item é a mesma do motor", () => {
  assert.equal(saldoItemVigente({ base: 100000n, recebido: 100000n, estornado: 40000n }), 40000n);
  assert.equal(saldoItemVigente({ base: 70000n, recebido: 50000n, estornado: 0n, recebidoBase: 30000n }), 50000n);
  assert.equal(saldoItemVigente({ base: 10n, recebido: 50n, estornado: 0n }), 0n);
});

test("a escolha de parcela aberta usa o saldo do adaptador", () => {
  const titulos = consolidarTitulos([
    linha({ id: "a", recebido: "1000.00", pos_recebido: "1000.00", pos_estornado: "400.00", estornado: "400.00" }),
  ], HOJE);
  assert.equal(escolherParcelaAberta(titulos).parcela?.saldoCentavos, 40000);
});

const conta = (parcial: Partial<ContaPagar>): ContaPagar => ({
  id: "c", descricao: "Conta", favorecido: null, categoria: "Outros", categoriaId: "cat", festaId: null,
  valorCentavos: 0, pagoCentavos: 0, saldoCentavos: 0, vencimento: HOJE, competencia: null, forma: null, observacao: null, status: "A pagar",
  ...parcial,
});
const recebivel = (parcial: Partial<Recebivel>): Recebivel => ({
  id: "r", pagamentoId: "p", cliente: "Ana", festaId: null, pacote: "Completa", data: HOJE, parcela: 1, vencimento: HOJE,
  valorCentavos: 0, recebidoCentavos: 0, saldoCentavos: 0, forma: "PIX", status: "A receber", diasAtraso: 0,
  ...parcial,
});

test("em atraso separa R$ 5.200 a receber de R$ 3.000 a pagar: hoje somam R$ 8.200", () => {
  const numeros = resumo(
    [recebivel({ status: "Vencido", saldoCentavos: 520000 })],
    [conta({ status: "Vencido", saldoCentavos: 300000, vencimento: "2026-11-01" })],
    0, HOJE, 0,
  );
  assert.equal(numeros.emAtrasoReceberCentavos, 520000);
  assert.equal(numeros.emAtrasoPagarCentavos, 300000);
});

test("a pagar por horizonte: série longa fica no total, não nos 30 dias", () => {
  const numeros = resumo([], [
    conta({ id: "1", saldoCentavos: 100000, vencimento: "2026-11-07" }),
    conta({ id: "2", saldoCentavos: 100000, vencimento: "2026-12-07" }),
    conta({ id: "3", saldoCentavos: 100000, vencimento: "2026-12-08" }),
    conta({ id: "4", saldoCentavos: 50000, vencimento: "2026-11-01", status: "Vencido" }),
    conta({ id: "5", saldoCentavos: 0, vencimento: "2026-11-10", status: "Pago" }),
  ], 0, HOJE, 0);
  assert.equal(numeros.aPagar30DiasCentavos, 200000);
  assert.equal(numeros.aPagarCentavos, 350000);
  assert.equal(numeros.emAtrasoPagarCentavos, 50000);
});

test("recebeu R$ 5.000 e pagou R$ 4.000: movimento de R$ 1.000, sem saldo no resumo", () => {
  const numeros = resumo([], [], 500000, HOJE, 400000);
  assert.equal(numeros.movimentoPeriodoCentavos, 100000);
  assert.equal(numeros.pagoMesCentavos, 400000);
  assert.equal("saldoPrevistoCentavos" in numeros, false);
});

test("sem saídas no alcance não há movimento: não é o mesmo que zero", () => {
  const numeros = resumo([], [], 500000, HOJE);
  assert.equal(numeros.movimentoPeriodoCentavos, null);
  assert.equal(numeros.pagoMesCentavos, 0);
});

test("festa com só saída no período aparece no resultado, com margem fora do escopo", () => {
  const leitura = leituraPeriodo(
    [recebivel({ festaId: "antiga", cliente: "Bia", data: "2026-01-10" })],
    [conta({ festaId: "antiga", valorCentavos: 30000, pagoCentavos: 30000, status: "Pago" })],
    "2026-11-01", "2026-11-30", new Map(), new Map([["antiga", 30000]]),
  );
  assert.deepEqual(leitura.margens, [{
    festaId: "antiga", cliente: "Bia", margemEstimadaCentavos: null, resultadoCaixaCentavos: -30000, custosLancados: true, noEscopo: false,
  }]);
});

test("festa com só estorno no período aparece, com resultado negativo", () => {
  const leitura = leituraPeriodo(
    [recebivel({ festaId: "antiga", cliente: "Bia", data: "2026-01-10" })], [],
    "2026-11-01", "2026-11-30", new Map([["antiga", -40000]]), new Map(),
  );
  assert.equal(leitura.margens[0]?.resultadoCaixaCentavos, -40000);
  assert.equal(leitura.margens[0]?.margemEstimadaCentavos, null);
});

test("festa fora do mês com entrada e estorno que se anulam continua no resultado", () => {
  const leitura = leituraPeriodo(
    [recebivel({ festaId: "maio", cliente: "Bia", data: "2026-05-10" })], [],
    "2026-04-01", "2026-04-30", new Map([["maio", 0]]), new Map(),
  );
  assert.equal(leitura.margens.length, 1);
  assert.equal(leitura.margens[0]?.resultadoCaixaCentavos, 0);
  assert.equal(leitura.margens[0]?.noEscopo, false);
});

test("sem os mapas do período (painel), festas de outros meses não entram", () => {
  const leitura = leituraPeriodo(
    [recebivel({ festaId: "maio", cliente: "Bia", data: "2026-05-10" })], [],
    "2026-04-01", "2026-04-30", new Map([["maio", 10000]]),
  );
  assert.deepEqual(leitura.margens, []);
});

test("festa no período sem custo lançado não mostra margem cheia", () => {
  const leitura = leituraPeriodo(
    [recebivel({ festaId: "f", data: "2026-11-20", valorCentavos: 100000 })], [],
    "2026-11-01", "2026-11-30",
  );
  assert.equal(leitura.margens[0]?.margemEstimadaCentavos, null);
  assert.equal(leitura.margens[0]?.custosLancados, false);
  assert.equal(leitura.margens[0]?.noEscopo, true);
});

test("com cronograma, faturamento e ticket vêm da obrigação, uma vez por pagamento", () => {
  const motor = { obrigacaoCentavos: 60000, liquidoCentavos: 100000, cronograma: true };
  const leitura = leituraPeriodo([
    recebivel({ id: "1", festaId: "f", data: "2026-11-20", valorCentavos: 100000, recebidoCentavos: 100000, status: "Pago", motor }),
    recebivel({ id: "2", festaId: "f", data: "2026-11-20", valorCentavos: 50000, status: "Pago", motor }),
  ], [], "2026-11-01", "2026-11-30");
  assert.equal(leitura.faturamentoCentavos, 60000);
  assert.equal(leitura.ticketCentavos, 60000);
});

test("RECEBER_SQL: todo alias usado é declarado, e cliente fica preso à empresa", () => {
  const declarados = new Set([...RECEBER_SQL.matchAll(/\b(?:FROM|JOIN)\s+[a-z_]+\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase()));
  const usados = new Set([...RECEBER_SQL.replace(/'[^']*'/g, "''").matchAll(/(?<![:.\w])([a-z_]+)\.[a-z_]+/gi)].map((m) => m[1].toLowerCase()));
  const faltando = [...usados].filter((alias) => !declarados.has(alias));
  assert.deepEqual(faltando, []);
  assert.match(RECEBER_SQL, /LEFT JOIN clientes cliente ON cliente\.id = fech\.cliente_id AND cliente\.empresa_id = \$1::uuid/);
});

test("abatimento já vem em centavos: R$ 400 de estorno são 40.000, não 4.000.000", () => {
  assert.equal(abatimentoDeLinha({ data: "2026-04-10", tipo: "ESTORNO", centavos: "40000", festa_id: "f", forma: "PIX" }).centavos, 40000);
  assert.throws(() => abatimentoDeLinha({ data: "2026-04-10", tipo: "ESTORNO", centavos: "400.00", festa_id: "f", forma: "PIX" }));
});

test("recebido do período com só um estorno de R$ 400 dá −R$ 400", async () => {
  const tx: DbExecutor = {
    async query<Row extends object>(text: string) {
      const rows = /mov\.data/.test(text)
        ? [{ data: "2026-04-10", tipo: "ESTORNO", centavos: "40000", festa_id: "f", forma: "PIX" }]
        : [{ liquido: "0" }];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    },
  };
  assert.equal(await recebidoNoPeriodo(tx, "e", "2026-04-01", "2026-04-30"), -40000);
});

test("impressão do pedido de despesa: igual para o mesmo pedido, diferente se muda valor, série ou festa", () => {
  const base = { descricao: " Compra ", categoriaId: "c", valor: 50, vencimento: "2026-03-10" };
  assert.equal(impressaoPedidoConta(base), impressaoPedidoConta({ ...base, descricao: "Compra" }));
  assert.match(impressaoPedidoConta(base), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(impressaoPedidoConta(base), impressaoPedidoConta({ ...base, valor: 51 }));
  assert.notEqual(impressaoPedidoConta(base), impressaoPedidoConta({ ...base, recorrente: true }));
  assert.notEqual(impressaoPedidoConta(base), impressaoPedidoConta({ ...base, festaId: "f" }));
  assert.ok(!impressaoPedidoConta(base).includes("Compra"), "só hash na auditoria");
});

test("o resumo declara a versão do contrato, para a tela pedir recarga quando divergir", async () => {
  const { VERSAO_RESUMO_FINANCEIRO } = await import("./calculos.ts");
  assert.equal(resumo([], [], 0, HOJE).versao, VERSAO_RESUMO_FINANCEIRO);
});

test("aba antiga sem o cabeçalho de versão recebe pedido de recarregar só nas rotas cujo contrato mudou", async () => {
  const { versaoFinanceiraRecusada, cabecalhoVersaoFinanceira, CABECALHO_VERSAO_FINANCEIRO, VERSAO_RESUMO_FINANCEIRO } = await import("./calculos.ts");
  for (const rota of ["/api/admin/financeiro", "/api/admin/financeiro/", "/api/admin/financeiro/contas-receber", "/api/admin/financeiro/relatorios", "/api/admin/dashboard", "/api/admin/financeiro/fluxo-caixa", "/api/admin/financeiro/contas-pagar"]) {
    assert.equal(versaoFinanceiraRecusada(rota, null), true, rota);
    assert.equal(versaoFinanceiraRecusada(rota, "1"), true, rota);
    assert.equal(versaoFinanceiraRecusada(rota, String(VERSAO_RESUMO_FINANCEIRO)), false, rota);
  }
  for (const rota of ["/api/admin/financeiro/contas-receber/x/pix", "/api/admin/festas/x/financeiro"])
    assert.equal(versaoFinanceiraRecusada(rota, null), false, rota);
  assert.deepEqual(cabecalhoVersaoFinanceira(), { [CABECALHO_VERSAO_FINANCEIRO]: String(VERSAO_RESUMO_FINANCEIRO) });
  const { readFileSync } = await import("node:fs");
  const fonte = (arquivo: string) => readFileSync(new URL(`../../${arquivo}`, import.meta.url), "utf8");
  assert.equal((fonte("components/admin/FinanceiroTelas.tsx").match(/adminFetch\(rotas\[tela\], \{ headers: cabecalhoVersaoFinanceira\(\) \}\)/g) ?? []).length, 2);
  assert.match(fonte("components/admin/DashboardGeral.tsx"), /adminFetch\('\/api\/admin\/dashboard', \{ headers: cabecalhoVersaoFinanceira\(\) \}\)/);
  // Toda rota GET que devolve resumo, painel ou relatório está na lista (a tela antiga lê esses contratos).
  const { readdirSync } = await import("node:fs");
  const { ROTAS_COM_VERSAO_FINANCEIRA } = await import("./calculos.ts");
  const raizApp = new URL("../../app/", import.meta.url);
  const arquivos = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? arquivos(new URL(`${e.name}/`, dir)) : e.name === "route.ts" ? [new URL(e.name, dir).pathname] : []);
  // P2: o caixa realizado (saldo null sem abertura) e as contas (status "Parcialmente paga") também mudaram de contrato.
  const contratoVersionado = /\b(resumo|painelGeral|relatorio|fluxoCaixa|listarContasPagar)\(/;
  const exigidas = arquivos(raizApp)
    .filter((caminho) => /export async function GET/.test(readFileSync(new URL(`file://${caminho}`), "utf8")) && contratoVersionado.test(readFileSync(new URL(`file://${caminho}`), "utf8")))
    .map((caminho) => decodeURIComponent(caminho).replace(/^.*\/app(\/api\/.*)\/route\.ts$/, "$1"))
    .sort();
  assert.deepEqual(exigidas, [...ROTAS_COM_VERSAO_FINANCEIRA].sort());
  assert.match(fonte("lib/financeiro/http.ts"), /exigirRecursoPlano\(tx, tenant\.empresaComprovada, recurso\);\s*\/\/[^\n]*\n\s*if \(versaoFinanceiraRecusada\(request\.nextUrl\.pathname, request\.headers\.get\(CABECALHO_VERSAO_FINANCEIRO\)\)\)/);
});

test("relatório leva a versão e a tela nova recusa relatório de servidor sem ela", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = (arquivo: string) => readFileSync(new URL(`../../${arquivo}`, import.meta.url), "utf8");
  const servico = fonte("lib/financeiro/servico.ts");
  const corpo = servico.slice(servico.indexOf("export async function relatorio("));
  assert.match(corpo.slice(0, corpo.indexOf("\n}\n")), /return \{\s*\/\/[^\n]*\n\s*versao: VERSAO_RESUMO_FINANCEIRO,/);
  assert.match(fonte("components/admin/FinanceiroTelas.tsx"), /respostaFinanceiraDesatualizada\(resumo, tela === 'relatorios' \? relatorio : null, tela === 'fluxo' \? fluxo : null\)\) return/);
});

test("P2: a tela nova recusa fluxo de caixa de servidor antigo, que não traz versão e manda saldo absoluto", async () => {
  const { respostaFinanceiraDesatualizada, VERSAO_RESUMO_FINANCEIRO } = await import("./calculos.ts");
  // Resposta do servidor anterior à P2: saldo inicial 0 e final numérico, sem versão nem motivo.
  const fluxoAntigo = { saldoInicialCentavos: 0, entradasCentavos: 6_240_000, saidasCentavos: 1_890_000, saldoFinalCentavos: 4_350_000, linhas: [] };
  assert.equal(respostaFinanceiraDesatualizada(fluxoAntigo), true);
  assert.equal(respostaFinanceiraDesatualizada({ ...fluxoAntigo, versao: 2 }), true);
  assert.equal(respostaFinanceiraDesatualizada({ ...fluxoAntigo, saldoInicialCentavos: null, saldoFinalCentavos: null, versao: VERSAO_RESUMO_FINANCEIRO }), false);
  assert.equal(respostaFinanceiraDesatualizada(null, undefined), false, "ainda não carregou");
  assert.equal(respostaFinanceiraDesatualizada({ versao: VERSAO_RESUMO_FINANCEIRO }, fluxoAntigo), true, "qualquer resposta desatualizada basta");
  const { readFileSync } = await import("node:fs");
  const servico = readFileSync(new URL("./servico.ts", import.meta.url), "utf8");
  const corpo = servico.slice(servico.indexOf("export async function fluxoCaixa("));
  assert.match(corpo.slice(0, corpo.search(/\r?\n\}\r?\n/)), /return \{\s*versao: VERSAO_RESUMO_FINANCEIRO,/);
});

test("P2: as amostras do /preview-ux seguem o contrato atual (versão e abertura), senão a tela pede para recarregar", async () => {
  const { VERSAO_RESUMO_FINANCEIRO, respostaFinanceiraDesatualizada } = await import("./calculos.ts");
  const { painelVitrine, financeiroVitrine } = await import("./vitrine.ts");
  assert.equal(painelVitrine.numeros.versao, VERSAO_RESUMO_FINANCEIRO);
  assert.equal(respostaFinanceiraDesatualizada(financeiroVitrine.resumo, financeiroVitrine.relatorio, financeiroVitrine.fluxo), false);
  const fluxo = financeiroVitrine.fluxo!;
  // Período começando em D0: inicial = saldo de abertura; final = inicial + entradas − saídas; previsto sem saldo.
  assert.equal(fluxo.abertura?.dataBase, "2026-03-01");
  assert.equal(fluxo.motivoSaldo, null);
  assert.equal(fluxo.saldoInicialCentavos, fluxo.abertura?.saldoCentavos);
  assert.equal(fluxo.saldoFinalCentavos, fluxo.saldoInicialCentavos! + fluxo.entradasCentavos - fluxo.saidasCentavos);
  assert.equal(fluxo.movimentoPeriodoCentavos, fluxo.entradasCentavos - fluxo.saidasCentavos);
  assert.ok(fluxo.linhas.every((linha) => (linha.tipo === "previsto") === (linha.saldo === null)));
  assert.equal(painelVitrine.caixa?.saldoCentavos, fluxo.saldoFinalCentavos);
});
