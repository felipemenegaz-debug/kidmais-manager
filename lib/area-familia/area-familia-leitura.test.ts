import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contagem, dataCurta, dataPorExtenso, primeiroNome, reais, ROTULO_ESTADO } from "./formato.ts";
import { leituraPermitida } from "./regras-http.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import type * as Leitura from "./leitura.ts";

// leitura.ts real, transpilado, com as dependências de banco e de PDF dubladas (as partes testadas aqui são puras).
const vazio = {};
const { diasEntre, estadoDaParcela, resumoDosPagamentos } = carregarModulo("lib/area-familia/leitura.ts", {
  "contratos/assinatura-papel": vazio, "contratos/repositories/models": vazio, "contratos/repositories/contrato.repository": vazio,
  "financeiro/servico": vazio, "festas/buffet": vazio, "contratos/marca-contrato": vazio, "contratos/services/documento.service": vazio,
  "contratos/services/errors": vazio, "contratos/services/fluxo-publico": vazio, "contratos/storage/postgres": vazio, "area-familia/acoes": vazio,
  "contratos/services/contrato-publico.service": vazio,
}) as unknown as typeof Leitura;

// Área "Minha festa" F2 (telas de leitura): partes sem banco. As regras com banco estão em leitura.postgres.test.ts.

const HOJE = "2026-11-14";
type R = Parameters<typeof resumoDosPagamentos>[0][number];
const r = (parcela: number, vencimento: string, valor: number, recebido: number, status: string): R =>
  ({ id: `p${parcela}`, parcela, vencimento, valorCentavos: valor, recebidoCentavos: recebido, saldoCentavos: valor - recebido, status } as unknown as R);

test("formatos: data por extenso e curta, reais, contagem até a festa, rótulos dos estados", () => {
  assert.equal(dataPorExtenso("2026-03-07"), "7 de março de 2026");
  assert.equal(dataPorExtenso("2026-12-25T00:00:00Z"), "25 de dezembro de 2026");
  assert.equal(dataPorExtenso("lixo"), "lixo");
  assert.equal(dataCurta("2026-03-07"), "07/03/2026");
  assert.equal(reais(123456).replace(/\s/g, " "), "R$ 1.234,56");
  assert.equal(contagem(10), "Faltam 10 dias");
  assert.equal(contagem(1), "Falta 1 dia");
  assert.equal(contagem(0), "É hoje!");
  assert.equal(contagem(-3), "A festa já aconteceu");
  assert.equal(primeiroNome("  Ana Maria Silva "), "Ana");
  assert.equal(primeiroNome(null), "");
  assert.deepEqual(Object.keys(ROTULO_ESTADO).sort(), ["CANCELADA", "EM_ABERTO", "FUTURA", "PAGA", "VENCIDA"]);
});

test("dias até a festa: calendário, sem fuso", () => {
  assert.equal(diasEntre(HOJE, "2026-11-14"), 0);
  assert.equal(diasEntre(HOJE, "2026-12-14"), 30);
  assert.equal(diasEntre(HOJE, "2026-11-13"), -1);
  assert.equal(diasEntre(HOJE, "2027-03-01T00:00:00.000Z"), 107);
});

test("estado da parcela: cancelada, paga, vencida, em aberto (30 dias) e futura", () => {
  assert.equal(estadoDaParcela({ status: "Cancelado", saldoCentavos: 100, vencimento: "2026-01-01" } as never, HOJE), "CANCELADA");
  assert.equal(estadoDaParcela({ status: "Reembolsado", saldoCentavos: 0, vencimento: "2026-01-01" } as never, HOJE), "CANCELADA");
  assert.equal(estadoDaParcela({ status: "Pago", saldoCentavos: 0, vencimento: "2026-01-01" } as never, HOJE), "PAGA");
  assert.equal(estadoDaParcela({ status: "Em aberto", saldoCentavos: 0, vencimento: "2026-12-30" } as never, HOJE), "PAGA", "saldo zero conta como paga");
  assert.equal(estadoDaParcela({ status: "Vencido", saldoCentavos: 10, vencimento: "2026-11-20" } as never, HOJE), "VENCIDA");
  assert.equal(estadoDaParcela({ status: "Em aberto", saldoCentavos: 10, vencimento: "2026-11-13" } as never, HOJE), "VENCIDA");
  assert.equal(estadoDaParcela({ status: "Em aberto", saldoCentavos: 10, vencimento: "2026-11-14" } as never, HOJE), "EM_ABERTO", "vence hoje");
  assert.equal(estadoDaParcela({ status: "Em aberto", saldoCentavos: 10, vencimento: "2026-12-14" } as never, HOJE), "EM_ABERTO", "limite de 30 dias");
  assert.equal(estadoDaParcela({ status: "Em aberto", saldoCentavos: 10, vencimento: "2026-12-15" } as never, HOJE), "FUTURA");
});

test("resumo dos pagamentos: totais sem as canceladas, Pix só com saldo, próxima = primeira com saldo", () => {
  const resumo = resumoDosPagamentos([
    r(1, "2026-10-01", 1000, 1000, "Pago"),
    r(2, "2026-11-01", 1000, 300, "Em aberto"),
    r(3, "2026-12-01", 1000, 0, "Em aberto"),
    r(4, "2027-02-01", 500, 0, "Cancelado"),
  ], HOJE);
  assert.equal(resumo.totalCentavos, 3000);
  assert.equal(resumo.pagoCentavos, 1300);
  assert.equal(resumo.saldoCentavos, 1700);
  assert.deepEqual(resumo.parcelas.map((p) => [p.numero, p.estado, p.pix]), [[1, "PAGA", false], [2, "VENCIDA", true], [3, "EM_ABERTO", true], [4, "CANCELADA", false]]);
  assert.equal(resumo.proxima?.numero, 2);
  assert.equal(resumoDosPagamentos([r(1, "2026-10-01", 1000, 1000, "Pago")], HOJE).proxima, null);
  // Saldo negativo (recebido a maior) nunca aparece negativo.
  assert.equal(resumoDosPagamentos([r(1, "2026-10-01", 1000, 1200, "Pago")], HOJE).parcelas[0].saldoCentavos, 0);
});

test("leitura permitida: sem sec-fetch-site, same-origin ou none; cross-site e same-site recusam", () => {
  const pedido = (v?: string) => new Request("https://x.test/b/e/minha-festa/api/pix", { headers: v ? { "sec-fetch-site": v } : {} });
  assert.equal(leituraPermitida(pedido()), true);
  assert.equal(leituraPermitida(pedido("same-origin")), true);
  assert.equal(leituraPermitida(pedido("none")), true);
  assert.equal(leituraPermitida(pedido("cross-site")), false);
  assert.equal(leituraPermitida(pedido("same-site")), false);
});

test("rotas de leitura: flag, empresa, sec-fetch, pepper, sessão, limite por sessão e revalidação na transação, nessa ordem", () => {
  for (const rota of ["app/b/[empresa]/minha-festa/api/documento/route.ts", "app/b/[empresa]/minha-festa/api/pix/route.ts"]) {
    const s = readFileSync(rota, "utf8");
    const ordem = ["areaFamiliaLigada()", "CODIGO_EMPRESA_AREA.test(", "leituraPermitida(request)", "pepperIdentidade()", "lerSessao(db()", "limitarLeituraDaSessao(", "withTransaction(", "lerSessao(tx"];
    let ultimo = -1;
    for (const marco of ordem) {
      const i = s.indexOf(marco);
      assert.ok(i > ultimo, `${rota}: ${marco} fora de ordem ou ausente`);
      ultimo = i;
    }
    assert.match(s, /sessaoId !== sessao\.sessaoId/, `${rota}: confere que a sessão revalidada é a mesma`);
    assert.match(s, /HEADERS_AREA|responderArea\(/, `${rota}: cabeçalhos sem cache da área`);
    assert.doesNotMatch(s, /searchParams\.get\("(festa|empresa|contrato)/, `${rota}: nada de festa, empresa ou contrato pelo pedido`);
  }
  const pix = readFileSync("app/b/[empresa]/minha-festa/api/pix/route.ts", "utf8");
  assert.match(pix, /contratoDaSessao\(tx, atual\)/);
  assert.match(pix, /pixDaParcelaDoContrato\(tx, atual\.empresaId, alvo\.contratoId/);
  const doc = readFileSync("app/b/[empresa]/minha-festa/api/documento/route.ts", "utf8");
  assert.match(doc, /materializarDocumentoFamilia/, "PDF montado depois do commit");
  assert.ok(doc.indexOf("materializarDocumentoFamilia(") > doc.indexOf("withTransaction("), "materializa fora da transação");
});

test("página: revalida a sessão na transação da leitura e só usa a sessão revalidada", () => {
  const s = readFileSync("app/b/[empresa]/minha-festa/page.tsx", "utf8");
  const ordem = ["areaFamiliaLigada()", "lerSessao(db(), empresa, token)", "withTransaction(", "lerSessao(tx, empresa, token)", "atual.sessaoId !== primeira.sessaoId", "lerMinhaFesta(tx, atual,"];
  let ultimo = -1;
  for (const marco of ordem) {
    const i = s.indexOf(marco);
    assert.ok(i > ultimo, `page.tsx: ${marco} fora de ordem ou ausente`);
    ultimo = i;
  }
  assert.ok(!s.includes("lerMinhaFesta(tx, primeira"), "nunca lê com a sessão de fora da transação");
  assert.ok(s.includes("return { sessao: null, dados: null }"), "sessão revogada volta para a entrada");
});

test("Pix na tela: resposta antiga é descartada e o QR fica preso à parcela pedida", () => {
  const s = readFileSync("components/area-familia/AreaFamilia.tsx", "utf8");
  const tem = (x: string, msg?: string) => assert.ok(s.includes(x), msg ?? x);
  tem("const pedido = ++pedidoAtual.current;");
  tem("if (pedido !== pedidoAtual.current) return;", "descarta resposta de clique anterior");
  assert.ok(s.indexOf("if (pedido !== pedidoAtual.current) return;") < s.indexOf("setPix({"), "descarte antes de guardar");
  tem("json.parcela?.numero !== numero", "confere o número da parcela devolvida");
  tem("setPix({ ...(json as Pix), parcelaId })");
  tem("pix?.parcelaId === p.id ? (", "QR só aparece sob a parcela dele");
  assert.ok(!s.includes("{pix ? ("), "nada de mostrar qualquer Pix guardado");
});
