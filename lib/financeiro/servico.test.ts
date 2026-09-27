import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { criarEntradaManual, leituraPeriodo, resumo, type ContaPagar, type Recebivel } from "./servico.ts";
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

test("resultado de caixa do relatório usa o líquido do período", () => {
  const receber: Recebivel[] = [{
    id: "1", pagamentoId: "p", cliente: "Ana", festaId: "f", pacote: "Completa", data: "2026-03-10",
    parcela: 1, vencimento: "2026-03-01", valorCentavos: 10000, recebidoCentavos: 4000, saldoCentavos: 6000,
    forma: "PIX", status: "Vencido", diasAtraso: 2,
  }];
  const pagar: ContaPagar[] = [{
    id: "c", descricao: "Insumo", favorecido: null, categoria: "Buffet", categoriaId: "cat", festaId: "f",
    valorCentavos: 3000, pagoCentavos: 1000, saldoCentavos: 2000, vencimento: "2026-03-10", competencia: null,
    forma: null, observacao: null, status: "A pagar",
  }];
  const marco = leituraPeriodo(receber, pagar, "2026-03-01", "2026-03-31", new Map([["f", 3900]]), new Map([["f", 1000]]));
  const agosto = leituraPeriodo(receber, pagar, "2026-08-01", "2026-08-31", new Map([["f", 249000]]), new Map());
  assert.equal(marco.margens[0]?.resultadoCaixaCentavos, 2900);
  assert.equal(marco.margens[0]?.margemEstimadaCentavos, 7000);
  assert.equal(agosto.faturamentoCentavos, 0);
  assert.equal(agosto.margens[0]?.festaId, "f");
  assert.equal(agosto.margens[0]?.resultadoCaixaCentavos, 249000);
  assert.equal(agosto.margens[0]?.margemEstimadaCentavos, 0);
});

test("entrada manual repetida consulta a chave antes da festa", async () => {
  const consultas: string[] = [];
  const festaId = "22222222-2222-2222-2222-222222222222";
  const linha = {
    id: "11111111-1111-1111-1111-111111111111",
    descricao: "Venda",
    contraparte: null,
    festa_id: festaId,
    valor: "10.00",
    vencimento: "2026-10-01",
    forma: null,
    observacao: null,
    recebido_em: null,
    taxa: "0.00",
  };
  const tx: DbExecutor = {
    async query<Row extends object>(text: string) {
      consultas.push(text);
      if (text.includes("chave_criacao")) return { rows: [linha as Row], rowCount: 1 };
      throw new Error("consulta inesperada");
    },
  };
  const payload = {
    descricao: "Venda", valor: 10, vencimento: "2026-10-01", status: "A receber" as const, festaId, chave: "chave-entrada-manual",
  };
  const repetida = await criarEntradaManual(tx, "empresa", "ator", "2026-09-27", payload);
  assert.equal(repetida.reutilizado, true);
  assert.equal(repetida.id, linha.id);
  await assert.rejects(
    () => criarEntradaManual(tx, "empresa", "ator", "2026-09-27", {
      ...payload, descricao: "Outra", festaId: "33333333-3333-3333-3333-333333333333",
    }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "IDEMPOTENCIA_CONFLITANTE",
  );
  assert.equal(consultas.some((sql) => sql.includes("FROM festas")), false);
});

test("entrada manual nova revalida a festa vinculada", async () => {
  let viuFesta = false;
  const tx: DbExecutor = {
    async query<Row extends object>(text: string) {
      if (text.includes("chave_criacao")) return { rows: [] as Row[], rowCount: 0 };
      if (text.includes("FROM festas")) {
        viuFesta = true;
        return { rows: [] as Row[], rowCount: 0 };
      }
      throw new Error(text);
    },
  };
  await assert.rejects(
    () => criarEntradaManual(tx, "empresa", "ator", "2026-09-27", {
      descricao: "Nova", valor: 10, vencimento: "2026-10-01", status: "A receber",
      festaId: "22222222-2222-2222-2222-222222222222", chave: "chave-nova-entrada",
    }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "DADOS_INVALIDOS",
  );
  assert.equal(viuFesta, true);
});

test("a leitura de recebíveis e saídas fica presa à empresa", () => {
  const fonte = readFileSync(new URL("./servico.ts", import.meta.url), "utf8");
  assert.match(fonte, /pac\.empresa_id = \$1::uuid/);
  assert.match(fonte, /conta\.empresa_id = \$1::uuid/);
  assert.doesNotMatch(fonte, /empresaId do corpo|body\.empresaId/);
});
