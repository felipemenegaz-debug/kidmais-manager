import assert from "node:assert/strict";
import test from "node:test";
import { resumo, type ContaPagar, type Recebivel } from "./servico.ts";
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

test("a leitura de recebíveis e saídas fica presa à empresa", () => {
  const fonte = readFileSync(new URL("./servico.ts", import.meta.url), "utf8");
  assert.match(fonte, /pac\.empresa_id = \$1::uuid/);
  assert.match(fonte, /conta\.empresa_id = \$1::uuid/);
  assert.doesNotMatch(fonte, /empresaId do corpo|body\.empresaId/);
});
