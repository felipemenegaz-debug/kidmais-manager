import assert from "node:assert/strict";
import test from "node:test";
import { leituraPeriodo, resumo, type ContaPagar, type Recebivel } from "./servico.ts";
import { readFileSync } from "node:fs";

test("o resumo do dashboard e do financeiro usa a mesma fórmula", () => {
  const receber: Recebivel[] = [{
    id: "1", pagamentoId: "p", cliente: "Ana", festaId: null, pacote: "Completa", data: "2026-03-01",
    parcela: 1, vencimento: "2026-03-01", valorCentavos: 10000, recebidoCentavos: 0, saldoCentavos: 10000,
    forma: "PIX", status: "Vencido", diasAtraso: 2,
  }];
  const pagar: ContaPagar[] = [{
    id: "2", descricao: "Aluguel", favorecido: null, categoria: "Aluguel", categoriaId: "c", festaId: null,
    valorCentavos: 4000, pagoCentavos: 0, saldoCentavos: 4000, vencimento: "2026-03-01", competencia: null,
    forma: null, observacao: null, status: "Vencido",
  }];
  const numeros = resumo(receber, pagar, 5000, "2026-03-18");
  assert.equal(numeros.aReceberCentavos, 10000);
  assert.equal(numeros.aPagarCentavos, 4000);
  assert.equal(numeros.emAtrasoCentavos, 14000);
  assert.equal(numeros.saldoPrevistoCentavos, 5000 + 10000 - 4000);
});

test("leitura do período ignora parcela cancelada e separa margem de caixa", () => {
  const receber: Recebivel[] = [
    {
      id: "1", pagamentoId: "p", cliente: "Ana", festaId: "f", pacote: "Completa", data: "2026-03-10",
      parcela: 1, vencimento: "2026-03-01", valorCentavos: 10000, recebidoCentavos: 4000, saldoCentavos: 6000,
      forma: "PIX", status: "Vencido", diasAtraso: 2,
    },
    {
      id: "2", pagamentoId: "p", cliente: "Ana", festaId: "f", pacote: "Completa", data: "2026-03-10",
      parcela: 2, vencimento: "2026-03-01", valorCentavos: 5000, recebidoCentavos: 0, saldoCentavos: 0,
      forma: "PIX", status: "Cancelado", diasAtraso: 0,
    },
    {
      id: "3", pagamentoId: "p", cliente: "Ana", festaId: "f", pacote: "Completa", data: "2026-03-10",
      parcela: 3, vencimento: "2026-04-15", valorCentavos: 1000, recebidoCentavos: 0, saldoCentavos: 1000,
      forma: "PIX", status: "A receber", diasAtraso: 0,
    },
  ];
  const pagar: ContaPagar[] = [{
    id: "c", descricao: "Insumo", favorecido: null, categoria: "Buffet", categoriaId: "cat", festaId: "f",
    valorCentavos: 3000, pagoCentavos: 1000, saldoCentavos: 2000, vencimento: "2026-04-20", competencia: null,
    forma: null, observacao: null, status: "A pagar",
  }];
  const marco = leituraPeriodo(receber, pagar, "2026-03-01", "2026-03-31", new Map([["f", 3900]]));
  const abril = leituraPeriodo(receber, pagar, "2026-04-01", "2026-04-30");
  assert.equal(marco.faturamentoCentavos, 11000);
  assert.equal(marco.aReceberCentavos, 6000);
  assert.equal(marco.ticketCentavos, 11000);
  assert.equal(marco.margens[0]?.margemEstimadaCentavos, 8000);
  assert.equal(marco.margens[0]?.resultadoCaixaCentavos, 2900);
  const posicao = resumo(receber, [], 0, "2026-03-18");
  assert.equal(posicao.aReceberCentavos, 7000);
  assert.notEqual(posicao.aReceberCentavos, marco.aReceberCentavos);
  assert.equal(abril.faturamentoCentavos, 0);
  assert.equal(abril.aReceberCentavos, 1000);
  assert.equal(abril.aPagarCentavos, 2000);
});

test("a leitura de recebíveis e saídas fica presa à empresa", () => {
  const fonte = readFileSync(new URL("./servico.ts", import.meta.url), "utf8");
  assert.match(fonte, /pac\.empresa_id = \$1::uuid/);
  assert.match(fonte, /conta\.empresa_id = \$1::uuid/);
  assert.doesNotMatch(fonte, /empresaId do corpo|body\.empresaId/);
});
