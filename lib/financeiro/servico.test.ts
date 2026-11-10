import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { criarEntradaManual, leituraPeriodo, pagarConta, painelGeral, prepararBaixa, resumo, type ContaPagar, type Recebivel } from "./servico.ts";
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
  assert.equal(numeros.emAtrasoReceberCentavos, 10000);
  assert.equal(numeros.emAtrasoPagarCentavos, 4000);
  assert.equal("emAtrasoCentavos" in numeros, false);
  assert.equal("saldoPrevistoCentavos" in numeros, false);
  assert.equal(numeros.movimentoPeriodoCentavos, null);
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
  assert.equal(agosto.margens[0]?.margemEstimadaCentavos, null);
  assert.equal(agosto.margens[0]?.noEscopo, false);
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

test("pagarConta recusa data futura sem efeito e aceita até o dia de hoje", async () => {
  const contaId = "44444444-4444-4444-8444-444444444444";
  const consultas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string) {
      consultas.push(text);
      if (text.includes("FROM financeiro_saidas") && text.includes("chave_idempotencia")) return { rows: [], rowCount: 0 };
      if (text.includes("SUM(valor)")) return { rows: [{ pago: "0.00" } as unknown as Row], rowCount: 1 };
      if (text.includes("financeiro_contas_pagar") && text.includes("FOR UPDATE")) {
        return { rows: [{ id: contaId, valor: "100.00", pago: "0.00", cancelado_em: null } as unknown as Row], rowCount: 1 };
      }
      if (text.includes("INSERT INTO financeiro_saidas")) return { rows: [{ id: "saida" } as unknown as Row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const pagamento = { contaId, valor: 10, forma: "PIX" as const, chave: "chave-pagamento" };

  await assert.rejects(
    () => pagarConta(tx, "empresa", "ator", "2026-11-30", { ...pagamento, data: "2026-12-01" }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "DADOS_INVALIDOS" && error.httpStatus === 409 && /não pode ser futura/.test(error.message),
  );
  assert.equal(consultas.length, 1, "só a consulta da chave: nem trava da conta nem gravação");

  for (const data of ["2026-11-30", "2026-11-29"]) {
    const pago = await pagarConta(tx, "empresa", "ator", "2026-11-30", { ...pagamento, data });
    assert.equal(pago.reutilizado, false, data);
  }
});

test("pagarConta devolve a chave já gravada antes de julgar a data", async () => {
  const contaId = "44444444-4444-4444-8444-444444444444";
  const linha = { id: "saida-antiga", conta_id: contaId, valor: "10.00", pago_em: "2026-12-20", forma: "PIX", observacao: null };
  const tx: DbExecutor = {
    async query<Row extends object>(text: string) {
      if (text.includes("FROM financeiro_saidas")) return { rows: [linha as unknown as Row], rowCount: 1 };
      throw new Error("consulta inesperada");
    },
  };
  const pagamento = { contaId, valor: 10, forma: "PIX" as const, chave: "chave-antiga" };
  const repetido = await pagarConta(tx, "empresa", "ator", "2026-11-30", { ...pagamento, data: "2026-12-20" });
  assert.deepEqual(repetido, { reutilizado: true, id: "saida-antiga" });
  await assert.rejects(
    () => pagarConta(tx, "empresa", "ator", "2026-11-30", { ...pagamento, data: "2026-12-21" }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "IDEMPOTENCIA_CONFLITANTE",
  );
});

test("pagarConta confronta o payload quando o INSERT colide com a mesma chave", async () => {
  const contaId = "44444444-4444-4444-8444-444444444444";
  const gravada = { id: "saida-concorrente", conta_id: contaId, valor: "10.00", pago_em: "2026-11-29", forma: "PIX", observacao: null };
  const consultas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string) {
      consultas.push(text);
      if (text.includes("INSERT INTO financeiro_saidas")) throw Object.assign(new Error("duplicada"), { code: "23505" });
      if (text.includes("SUM(valor)")) return { rows: [{ pago: "0.00" } as unknown as Row], rowCount: 1 };
      if (text.includes("financeiro_contas_pagar") && text.includes("FOR UPDATE")) {
        return { rows: [{ valor: "100.00", cancelado_em: null } as unknown as Row], rowCount: 1 };
      }
      if (text.includes("FROM financeiro_saidas")) {
        // A primeira leitura não vê a chave; a releitura, depois da colisão, vê a gravação concorrente.
        const releitura = consultas.some((sql) => sql.includes("INSERT INTO financeiro_saidas"));
        return releitura ? { rows: [gravada as unknown as Row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const pagamento = { contaId, valor: 10, data: "2026-11-29", forma: "PIX" as const, chave: "chave-colisao" };

  const igual = await pagarConta(tx, "empresa", "ator", "2026-11-30", pagamento);
  assert.deepEqual(igual, { reutilizado: true, id: "saida-concorrente" });
  assert(consultas.some((sql) => sql.includes("ROLLBACK TO SAVEPOINT saida_idempotente")), "desfaz o INSERT recusado");

  for (const diferente of [{ valor: 11 }, { data: "2026-11-28" }, { forma: "DINHEIRO" as const }, { observacao: "outra" }]) {
    consultas.length = 0;
    await assert.rejects(
      () => pagarConta(tx, "empresa", "ator", "2026-11-30", { ...pagamento, ...diferente }),
      (error: unknown) => error instanceof PacoteAdminError && error.code === "IDEMPOTENCIA_CONFLITANTE",
      JSON.stringify(diferente),
    );
  }
});

test("prepararBaixa recusa data de recebimento futura sem consultar o banco e deixa passar hoje", async () => {
  const consultas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string) {
      consultas.push(text);
      return { rows: [] as Row[], rowCount: 0 };
    },
  };
  const pedido = { parcelaId: "55555555-5555-4555-8555-555555555555", valor: 10, forma: "PIX" as const };

  await assert.rejects(
    () => prepararBaixa(tx, "empresa", "2026-11-30", { ...pedido, data: "2026-12-01" }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "DADOS_INVALIDOS" && error.httpStatus === 409 && /não pode ser futura/.test(error.message),
  );
  assert.equal(consultas.length, 0);

  for (const data of ["2026-11-30", "2026-11-29"]) {
    // Sem parcela no banco simulado: passar da data leva à consulta e à recusa seguinte.
    await assert.rejects(
      () => prepararBaixa(tx, "empresa", "2026-11-30", { ...pedido, data }),
      (error: unknown) => error instanceof PacoteAdminError && error.code === "NAO_ENCONTRADO",
      data,
    );
  }
  assert(consultas.length > 0);
});

test("a leitura de recebíveis e saídas fica presa à empresa", () => {
  const fonte = readFileSync(new URL("./servico.ts", import.meta.url), "utf8");
  assert.match(fonte, /pac\.empresa_id = \$1::uuid/);
  assert.match(fonte, /conta\.empresa_id = \$1::uuid/);
  assert.doesNotMatch(fonte, /empresaId do corpo|body\.empresaId/);
});

test('dashboard aponta cada pendência e festa para seu contrato e versão, mantendo o total',async()=>{
  const empresa='00000000-0000-4000-8000-000000000001';
  const tx={async query(sql:string,params:readonly unknown[]=[]) {
    if(sql.includes('AS "contratoId"')) {
      assert.equal(params[0],empresa); assert.match(sql,/pac\.empresa_id = \$1::uuid/);
      return {rows:[{id:'festa',contratoId:'assinado',versaoId:'vigente',data:'2026-10-02',cliente:'Ana',pacote:'Premium',convidados:50,status:'ASSINADO',hora:'17:00'}]};
    }
    if(sql.includes('count(*) OVER ()::int')) {
      assert.equal(params[0],empresa); assert.match(sql,/pac\.empresa_id = \$1::uuid/);
      return {rows:[{id:'pendente-A',versaoId:'preparacao-A',cliente:'Bia',n:4},{id:'pendente-B',versaoId:null,cliente:'Caio',n:4}]};
    }
    if(sql.includes("to_regclass('public.ia_importacoes')")) return {rows:[{ok:true}]};
    if(sql.includes('FROM ia_importacoes')) {
      // Eventos importados futuros: só o aviso; nunca entram em `proximas` nem em `festasProximas`.
      assert.equal(params[0],empresa); assert.equal(params[1],'2026-10-01'); assert.match(sql,/i\.status = 'IMPORTADA'/);
      return {rows:[{n:3}]};
    }
    return {rows:[]};
  }} as unknown as DbExecutor;
  const painel=await painelGeral(tx,empresa,'2026-10-01');
  assert.equal(painel.contratosPendentes,4);
  assert.equal(painel.importadosAIntegrar,3);
  assert.equal(painel.proximas.length,1,'o evento importado não vira festa próxima');
  assert.equal(painel.festasProximas,0,'o contador de festas não inclui eventos importados');
  assert.equal(painel.proximas[0].contratoId,'assinado');
  assert.deepEqual(painel.atencao.map(i=>i.href),[
    '/admin/contratos?contratoId=pendente-A&versaoId=preparacao-A#documentacao',
    '/admin/contratos?contratoId=pendente-B#documentacao'
  ]);
});
