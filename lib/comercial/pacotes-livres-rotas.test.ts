import test from "node:test";
import assert from "node:assert/strict";
import { carregarModulo } from "../acessos/teste-carregador.ts";

/**
 * Pacote criado em "Novo pacote" (código P_…) no fluxo público: em /b/<código> a cotação, os adicionais, o catálogo do
 * buffet e o envio do fechamento aceitam o código do pacote da empresa do endereço; no endereço atual (dona da agenda
 * pública) continuam só os sete ids V1. A empresa é sempre a do endereço; o pacote é buscado nela (nunca em outra).
 */
const EMPRESA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KIDMAIS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LIVRE = "P_9F2C4E1A7B3D4C5E8F6A0B1C2D3E4F5A";
const PACOTE_LIVRE = "44444444-4444-4444-8444-444444444444";
const POCKET_K = "33333333-3333-4333-8333-333333333333";

class ErroHttp extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) { super(message); this.code = code; this.httpStatus = httpStatus; }
}

function ambiente() {
  const buscas: Array<[string, string]> = [];
  const calculos: unknown[] = [];
  const envios: Array<Record<string, unknown>> = [];
  const adicionaisPedidos: Array<Record<string, unknown>> = [];
  const operacoes: string[] = [];
  const pacotes: Record<string, Record<string, string>> = { [EMPRESA_A]: { [LIVRE]: PACOTE_LIVRE }, [KIDMAIS]: { POCKET: POCKET_K } };
  const banco = { async query() { return { rows: [], rowCount: 0 }; } };
  const dubles = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    "lib/db/postgres": { db: () => banco },
    "lib/http/limite-publico": { limitarPublico: () => null },
    "lib/http/api-response": { apiErrorResponse: (error: { code?: string; httpStatus?: number }) => ({ body: { codigo: error.code }, status: error.httpStatus ?? 500 }) },
    "lib/comercial/cotacao-publica": {
      codigoEmpresaDoPedido: (url: URL) => url.searchParams.get("empresa") || null,
      escopoCotacaoPublica: async (_db: unknown, codigo: string | null) => {
        operacoes.push("escopo");
        return codigo ? { empresaId: EMPRESA_A, estabelecimentoId: null, porCodigo: true } : { empresaId: KIDMAIS, estabelecimentoId: null, porCodigo: false };
      },
    },
    "lib/comercial/repositories": {
      buscarPacoteVigenteDaEmpresaPorCodigo: async (empresaId: string, codigo: string) => {
        buscas.push([empresaId, codigo]);
        const id = pacotes[empresaId]?.[codigo];
        return id ? { id, codigo, nome: "Pacote", empresaId } : null;
      },
    },
    "lib/disponibilidade/escopo": { escopoDaEmpresa: async () => (operacoes.push("unidade"), { estabelecimentoId: "unidade-1" }) },
    "lib/disponibilidade/services": {
      isAvailabilityServiceError: () => false,
      revalidarHorarioSelecionado: async () => (operacoes.push("horario"), { periodo: { configuracaoId: "turno-1" }, candidato: { inicio: "12:00", fim: "16:00" } }),
    },
    "lib/comercial/services": {
      isPricingServiceError: () => false,
      calcularResumoComercial: async (entrada: unknown) => {
        calculos.push(entrada);
        return { pacote: { valorTabelaBase: 4500, desconto: { percentual: 0, valor: 0, titulo: null }, valorTabelaAplicado: 4500,
          precoRegra: { categoriaHorario: "GERAL", convidadosMin: 30, convidadosMax: 80 }, convidadosFaturados: 40, minimoFaturavelAplicado: false } };
      },
    },
    "lib/comercial/adicionais-tenant": {
      adicionaisDoPacoteNoTenant: async (_db: unknown, pedido: Record<string, unknown>) => { adicionaisPedidos.push(pedido); return []; },
    },
    "lib/comercial/pacotes-admin": { PacoteAdminError: ErroHttp },
    "lib/comercial/catalogo-buffet-estrutura": { catalogoBuffetPorEmpresa: async () => true },
    "lib/fechamentos/services": {
      isFechamentoServiceError: () => false,
      criarFechamentoPublicoComIdentidade: async (entrada: Record<string, unknown>) => {
        envios.push(entrada);
        const pacote = { id: entrada.pacoteId, codigo: LIVRE, nome: "Festa Jardim" };
        return {
          fechamento: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", status: "PENDENTE" },
          resumoComercial: { pacote: { pacote, tabelaPreco: { id: "t", codigo: "T", nome: "Tabela" }, desconto: null }, adicionais: { itens: [] } },
          cliente: {}, aniversariante: {}, negociacaoNecessaria: false,
        };
      },
    },
    "lib/identidade/services": { isIdentityServiceError: () => false },
    "lib/clientes/services": { isClienteServiceError: () => false },
  };
  const cache = new Map();
  type Rota = { GET?: (r: unknown) => Promise<{ body: Record<string, unknown>; status: number }>; POST?: (r: unknown) => Promise<{ body: Record<string, unknown>; status: number }> };
  const carregar = (arquivo: string) => carregarModulo(arquivo, dubles, cache) as Rota;
  return {
    buscas, calculos, envios, adicionaisPedidos, operacoes,
    cotacao: carregar("app/api/fechamentos/cotacao/route.ts"),
    adicionais: carregar("app/api/fechamentos/adicionais/route.ts"),
    catalogo: carregar("app/api/fechamentos/catalogo/route.ts"),
    envio: carregar("app/api/fechamentos/route.ts"),
  };
}

function pedido(caminho: string, corpo?: unknown) {
  return { nextUrl: new URL(`http://localhost${caminho}`), json: async () => corpo, headers: new Headers() };
}

const COTACAO = { dataFesta: "2026-11-14", horarioBase: "almoco", ajusteHorario: "0", horarioInicio: "12:00", horarioFim: "16:00", convidados: 40 };

test("cotação: /b aceita o código P_ do pacote da empresa do endereço; endereço atual recusa (só os sete)", async () => {
  const a = ambiente();
  const ok = await a.cotacao.POST!(pedido("/api/fechamentos/cotacao?empresa=buffet-a", { ...COTACAO, pacote: LIVRE }));
  assert.equal(ok.status, 200);
  assert.deepEqual(a.buscas, [[EMPRESA_A, LIVRE]], "buscado só na empresa do endereço");
  assert.equal((a.calculos[0] as { pacoteId: string }).pacoteId, PACOTE_LIVRE);
  a.operacoes.length = 0;
  const dona = await a.cotacao.POST!(pedido("/api/fechamentos/cotacao", { ...COTACAO, pacote: LIVRE }));
  assert.equal(dona.status, 400);
  assert.equal(a.buscas.length, 1, "endereço atual nem consulta o banco com código livre");
  assert.deepEqual(a.operacoes, [], "recusa antes do escopo (sem banco), como antes");
  const comEspaco = await a.cotacao.POST!(pedido("/api/fechamentos/cotacao", { ...COTACAO, pacote: " pocket " }));
  assert.equal(comEspaco.status, 400, "endereço atual: o id exato, como o enum de antes");
  const legado = await a.cotacao.POST!(pedido("/api/fechamentos/cotacao", { ...COTACAO, pacote: "pocket" }));
  assert.equal(legado.status, 200, "endereço atual: id V1 inalterado");
  assert.deepEqual(a.buscas.at(-1), [KIDMAIS, "POCKET"]);
  for (const invalido of ["p_abc", "../POCKET", "A".repeat(51), ""]) {
    const r = await a.cotacao.POST!(pedido("/api/fechamentos/cotacao?empresa=buffet-a", { ...COTACAO, pacote: invalido }));
    assert.equal(r.status, 400, invalido);
  }
  const deOutra = await a.cotacao.POST!(pedido("/api/fechamentos/cotacao?empresa=buffet-a", { ...COTACAO, pacote: "P_OUTRAEMPRESA" }));
  assert.equal(deOutra.status, 404, "código que a empresa do endereço não tem");
});

test("adicionais e catálogo do buffet: /b pelo código P_; endereço atual só os sete", async () => {
  const a = ambiente();
  const ok = await a.adicionais.GET!(pedido(`/api/fechamentos/adicionais?empresa=buffet-a&pacote=${LIVRE}&data=2026-11-14&convidados=40`));
  assert.equal(ok.status, 200);
  assert.equal(a.adicionaisPedidos[0].pacoteCodigo, LIVRE);
  assert.equal(a.adicionaisPedidos[0].empresaId, EMPRESA_A);
  const dona = await a.adicionais.GET!(pedido(`/api/fechamentos/adicionais?pacote=${LIVRE}&data=2026-11-14&convidados=40`));
  assert.equal(dona.status, 400);
  assert.equal(a.adicionaisPedidos.length, 1);

  const catalogo = await a.catalogo.GET!(pedido(`/api/fechamentos/catalogo?empresa=buffet-a&pacote=${LIVRE}`));
  assert.equal(catalogo.status, 200);
  assert.deepEqual(a.buscas.at(-1), [EMPRESA_A, LIVRE]);
  const catalogoDona = await a.catalogo.GET!(pedido(`/api/fechamentos/catalogo?pacote=${LIVRE}`));
  assert.equal(catalogoDona.status, 400);
  const catalogoInvalido = await a.catalogo.GET!(pedido(`/api/fechamentos/catalogo?empresa=buffet-a&pacote=p_x`));
  assert.equal(catalogoInvalido.status, 400);
  const catalogoV1 = await a.catalogo.GET!(pedido(`/api/fechamentos/catalogo?empresa=buffet-a&pacote=pocket`));
  assert.equal(catalogoV1.status, 404, "em /b o id V1 é traduzido (POCKET) e buscado na empresa, como nas outras rotas");
  assert.deepEqual(a.buscas.at(-1), [EMPRESA_A, "POCKET"]);
  const catalogoDonaV1 = await a.catalogo.GET!(pedido(`/api/fechamentos/catalogo?pacote=POCKET`));
  assert.equal(catalogoDonaV1.status, 200, "endereço atual: os sete códigos, como antes");
});

const FECHAMENTO = {
  identidadeTipo: "NOVO_CLIENTE", dataFesta: "2026-11-14", horarioBase: "almoco", ajusteHorario: "0", horarioInicio: "12:00", horarioFim: "16:00",
  statusDisponibilidade: "disponivel", convidadosPagantes: 40, buffetDefinicao: "depois", adicionaisSelecionados: [], valorCombinado: "4500,00",
  formaPagamento: "pix_avista", nomeCliente: "Cliente Sintético", cpf: "00000000191", email: "cliente@buffet.test", cep: "70000000",
  logradouro: "Rua Sintética", numero: "1", bairro: "Centro", cidade: "Brasília", uf: "DF", nomeAniversariante: "Aniversariante", idadeAniversariante: 6,
};

test("envio do fechamento: /b grava com o pacote P_ da empresa; recusas (endereço atual 400, /b 409) antes de qualquer operação", async () => {
  const a = ambiente();
  const ok = await a.envio.POST!(pedido("/api/fechamentos?empresa=buffet-a", { ...FECHAMENTO, pacote: LIVRE }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((ok.body.comercial as { pacote: { codigo: string } }).pacote.codigo, LIVRE);
  assert.equal(a.envios.length, 1);
  assert.equal(a.envios[0].pacoteId, PACOTE_LIVRE);
  assert.equal(a.envios[0].empresaEsperada, EMPRESA_A, "segunda barreira no serviço: empresa do endereço");
  assert.deepEqual(a.buscas, [[EMPRESA_A, LIVRE]]);

  a.operacoes.length = 0;
  const buscasAntes = a.buscas.length;
  for (const pacote of [LIVRE, "POCKET", "foo", " pocket "]) {
    const dona = await a.envio.POST!(pedido("/api/fechamentos", { ...FECHAMENTO, pacote }));
    assert.equal(dona.status, 400, `endereço atual recusa ${JSON.stringify(pacote)} como antes (Dados inválidos)`);
    assert.equal(dona.body.erro, "Dados inválidos.");
  }
  const invalido = await a.envio.POST!(pedido("/api/fechamentos?empresa=buffet-a", { ...FECHAMENTO, pacote: "p_minusculo" }));
  assert.equal(invalido.status, 409);
  assert.equal(invalido.body.codigo, "PACOTE_FORA_ESCOPO_V1");
  assert.deepEqual(a.operacoes, [], "nenhuma recusa tocou escopo, unidade ou horário");
  assert.equal(a.buscas.length, buscasAntes, "nem buscou pacote");
  const deOutra = await a.envio.POST!(pedido("/api/fechamentos?empresa=buffet-a", { ...FECHAMENTO, pacote: "P_OUTRAEMPRESA" }));
  assert.equal(deOutra.status, 404);
  assert.equal(deOutra.body.codigo, "PACOTE_NAO_ENCONTRADO");
  assert.equal(a.envios.length, 1, "nenhum outro envio chegou ao serviço");
});
