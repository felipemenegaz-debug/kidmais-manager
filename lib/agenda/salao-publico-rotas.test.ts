import test from "node:test";
import assert from "node:assert/strict";
import { carregarModulo } from "../acessos/teste-carregador.ts";

/**
 * S-D (D2/D3/R-D3): rotas públicas dos salões com dublês. Toda recusa de escopo ou publicação = o MESMO 404 no-store,
 * antes de qualquer dado; foto com max-age=0 + must-revalidate + ETag, e o 304 só depois dos mesmos portões.
 */
const SALAO = "11111111-1111-4111-8111-111111111111";
const FOTO = "22222222-2222-4222-8222-222222222222";
const CFG = "33333333-3333-4333-8333-333333333333";

class Indisponivel extends Error {}

function ambiente(opcoes: { escopoFalha?: boolean; publicado?: boolean } = {}) {
  const chamadas: string[] = [];
  const dubles = {
    "db/postgres": { db: () => ({}) },
    "http/limite-publico": { limitarPublico: async () => null },
    "comercial/cotacao-publica": {
      codigoEmpresaDoPedido: () => "buffet",
      escopoCotacaoPublica: async () => { if (opcoes.escopoFalha) throw new Error("escopo recusado"); chamadas.push("escopo"); return { empresaId: "e1", estabelecimentoId: null }; },
    },
    "disponibilidade/escopo": { escopoDaEmpresa: async () => ({ estabelecimentoId: null }) },
    "agenda/salao-publico": {
      SalaoPublicoIndisponivel: Indisponivel,
      listarSaloesPublicos: async () => { chamadas.push("lista"); if (opcoes.publicado === false) throw new Indisponivel(); return { saloes: [], recomendado: null }; },
      fotoPublica: async () => { chamadas.push("foto"); if (opcoes.publicado === false) throw new Indisponivel(); return { conteudo: Buffer.from("webp"), sha256: "abc" }; },
    },
  };
  const m = carregarModulo("lib/agenda/salao-publico-rotas.ts", dubles, new Map()) as {
    respostaListaSaloes: (p: unknown) => Promise<Response>; respostaFotoSalao: (p: unknown, s: string, f: string) => Promise<Response>;
  };
  const pedido = (consulta: string, cabecalhos: Record<string, string> = {}) => ({
    nextUrl: new URL(`http://localhost/api/publico/saloes${consulta}`), headers: new Headers(cabecalhos),
  });
  return { m, pedido, chamadas };
}
const consultaOk = `?empresa=buffet&data=2026-11-14&configuracaoId=${CFG}&inicio=15:00&fim=19:00&convidados=80`;

test("S-D: lista pública — 200 no-store; parâmetro malformado 400; escopo ou publicação recusados = 404 igual", async () => {
  const ok = ambiente();
  const r = await ok.m.respostaListaSaloes(ok.pedido(consultaOk));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  for (const ruim of ["?data=x", consultaOk.replace("convidados=80", "convidados=0"), consultaOk.replace(CFG, "abc"), consultaOk.replace("15:00", "25:00")]) {
    const a = ambiente();
    assert.equal((await a.m.respostaListaSaloes(a.pedido(ruim))).status, 400, ruim);
    assert.deepEqual(a.chamadas, [], "nada consultado com parâmetro malformado");
  }
  const semEscopo = ambiente({ escopoFalha: true });
  const r1 = await semEscopo.m.respostaListaSaloes(semEscopo.pedido(consultaOk));
  const naoPublicado = ambiente({ publicado: false });
  const r2 = await naoPublicado.m.respostaListaSaloes(naoPublicado.pedido(consultaOk));
  for (const resp of [r1, r2]) {
    assert.equal(resp.status, 404);
    assert.equal(resp.headers.get("cache-control"), "no-store");
    assert.equal(await resp.text(), "Não encontrado.");
  }
  assert.deepEqual(semEscopo.chamadas, [], "sem escopo, a lista nem é lida");
});

test("S-D: foto pública — headers, ETag e 304 só depois dos portões; recusa = 404 igual, inclusive com If-None-Match", async () => {
  const ok = ambiente();
  const r = await ok.m.respostaFotoSalao(ok.pedido("?empresa=buffet"), SALAO, FOTO);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.equal(r.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(r.headers.get("etag"), '"abc"');
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  const cache = ambiente();
  const r304 = await cache.m.respostaFotoSalao(cache.pedido("?empresa=buffet", { "if-none-match": '"abc"' }), SALAO, FOTO);
  assert.equal(r304.status, 304);
  assert.deepEqual(cache.chamadas, ["escopo", "foto"], "o 304 passa pelos portões");
  const despublicado = ambiente({ publicado: false });
  const r404 = await despublicado.m.respostaFotoSalao(despublicado.pedido("?empresa=buffet", { "if-none-match": '"abc"' }), SALAO, FOTO);
  assert.equal(r404.status, 404, "salão que deixou de estar pronto: 404 mesmo com o ETag antigo");
  assert.equal(r404.headers.get("cache-control"), "no-store");
  const ruim = ambiente();
  assert.equal((await ruim.m.respostaFotoSalao(ruim.pedido("?empresa=buffet"), "nao-uuid", FOTO)).status, 404);
  assert.deepEqual(ruim.chamadas, []);
});

test("S-D: lista de pacotes com ?salao= ganha noSalao (sem filtrar); salão malformado = 400", async () => {
  const pedidos: string[] = [];
  const dubles = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    "lib/db/postgres": { db: () => ({ query: async () => ({ rows: [] }) }) },
    "lib/http/limite-publico": { limitarPublico: async () => null },
    "lib/http/api-response": { apiErrorResponse: () => ({ body: {}, status: 500 }) },
    "lib/comercial/cotacao-publica": { codigoEmpresaDoPedido: () => "buffet", escopoCotacaoPublica: async () => ({ empresaId: "e1" }) },
    "lib/comercial/repositories": {
      buscarPacoteVigenteDaEmpresaPorCodigo: async () => null,
      listarPacotesContrataveisDaEmpresa: async () => [
        { id: "p1", codigo: "P1", nome: "Do salão", descricao: null, duracaoMinutos: null, convidadosMinimos: null, convidadosMaximos: null },
        { id: "p2", codigo: "P2", nome: "De outro", descricao: null, duracaoMinutos: null, convidadosMinimos: null, convidadosMaximos: null },
      ],
    },
    "lib/comercial/pacote-precos": { lerPrecosCorrentes: async () => ({ pacotes: [] }) },
    "lib/comercial/regras-pagamento": { lerRegrasPagamento: async () => null },
    "lib/comercial/disponibilidade-pacote-publica": { lerRegrasDisponibilidadePacote: async () => [] },
    "lib/agenda/salao-pacotes": { pacotesElegiveisDoSalao: async (_db: unknown, empresa: string, salao: string) => { pedidos.push(`${empresa}:${salao}`); return ["p1"]; } },
  };
  // E2b: o catálogo efetivo do endereço vem de lib/comercial/oferta-publica, que importa o repositório pelo arquivo.
  Object.assign(dubles, { "lib/comercial/repositories/comercial.repository": dubles["lib/comercial/repositories"] });
  const { GET } = carregarModulo("app/api/fechamentos/pacotes/route.ts", dubles, new Map()) as { GET: (r: unknown) => Promise<{ status: number; body: { pacotes?: Array<Record<string, unknown>> } }> };
  const chamar = (q: string) => GET({ nextUrl: new URL(`http://localhost/api/fechamentos/pacotes${q}`) });
  const sem = await chamar("?empresa=buffet");
  assert.equal(sem.body.pacotes!.some((p) => "noSalao" in p), false, "sem o salão: resposta de antes");
  const com = await chamar(`?empresa=buffet&salao=${SALAO.toUpperCase()}`);
  assert.deepEqual(com.body.pacotes!.map((p) => [p.codigo, p.noSalao]), [["P1", true], ["P2", false]], "lista inteira, sem filtrar");
  assert.deepEqual(pedidos, [`e1:${SALAO}`], "salão normalizado e consultado na empresa do endereço");
  assert.equal((await chamar("?empresa=buffet&salao=abc")).status, 400);
});
