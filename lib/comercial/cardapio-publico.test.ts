import test from "node:test";
import assert from "node:assert/strict";
import { carregarModulo, executorFalso } from "../acessos/teste-carregador.ts";
import { contatoPublicoDe } from "../fechamentos/marca-publica.ts";

const empresaId = "00000000-0000-4000-8000-000000000006";
const categorias = [
  { codigo: "salgados", nome: "Salgados", itens: ["Coxinha"] },
  { codigo: "doces", nome: 'Doces <finos> & "festa"', itens: ["Brigadeiro <especial>"] },
];
test("o portão exige código válido e empresa ativa e recusa bloqueio comercial", async () => {
  const tx = executorFalso([[/status = 'ATIVA'/, ([codigo]) => codigo === "buffet-a" ? [{ id: empresaId }] : []]]);
  type TxMock = typeof tx;
  const servico = (nivel: string, catalogoIsolado = true) => carregarModulo("lib/comercial/cardapio-publico.ts", {
    "lib/assinatura/estado": { lerEstadoComercial: async () => ({ acesso: { nivel } }) },
    "lib/comercial/catalogo-buffet-estrutura": { catalogoBuffetPorEmpresa: async () => catalogoIsolado },
  }, new Map()).escopoCardapioPublico as (db: TxMock, codigo: string) => Promise<{ empresaId?: string; motivo?: string }>;
  assert.equal((await servico("COMPLETO")(tx, "!!!")).empresaId, undefined);
  assert.equal(tx.executados.length, 0);
  assert.equal((await servico("COMPLETO")(tx, "buffet-x")).empresaId, undefined);
  assert.equal((await servico("BLOQUEADO")(tx, "buffet-a")).empresaId, undefined);
  assert.equal((await servico("COMPLETO", false)(tx, "buffet-a")).empresaId, undefined, "catálogo global anterior à 078 recebe a recusa pública");
  assert.equal((await servico("SOMENTE_LEITURA")(tx, "buffet-a")).empresaId, empresaId);
});

function pagina(empresaAtiva = true, limitado = false, opcoes = categorias) {
  const etapas: string[] = [];
  const modulo = carregarModulo("app/b/[empresa]/cardapio/[[...categoria]]/route.ts", {
    "lib/http/limite-publico": { limitarPublico: async (req: { nextUrl: URL }, grupo: string) => {
      assert.equal(grupo, "LEITURA"); assert.equal(req.nextUrl.searchParams.get("empresa"), "buffet-a"); etapas.push("limite");
      return limitado ? Response.json({}, { status: 429, headers: { "Retry-After": "19" } }) : null;
    } },
    "lib/db/postgres": { db: () => ({}) },
    "lib/comercial/cardapio-publico": {
      escopoCardapioPublico: async () => { etapas.push("empresa"); return empresaAtiva ? { empresaId } : { motivo: 'indisponível' }; },
      lerCardapioPublico: async () => opcoes,
    },
    "lib/perfil/nome-publico": { nomePublicoDaEmpresa: async () => 'Buffet "A"' },
    "lib/perfil/contato-publico": { contatoPublicoDaEmpresa: async () => contatoPublicoDe({
      email: "buffet@example.test", site: "https://buffet.test/?a=1&b=2", instagram: "javascript:invalido",
    }) },
  }, new Map());
  return { etapas, abrir: (categoria?: string[]) => (modulo.GET as (req: Request, ctx: object) => Promise<Response>)(
    new Request("https://exemplo.test/b/buffet-a/cardapio?empresa=b"), { params: Promise.resolve({ empresa: "buffet-a", categoria }) }) };
}
test("HTML contém a prévia, selecionada primeiro e dados escapados em texto e atributos", async () => {
  const rota = pagina(); const r = await rota.abrir(["doces"]); const html = await r.text();
  assert.equal(r.status, 200); assert.match(r.headers.get("Content-Type")!, /text\/html; charset=utf-8/);
  assert.match(r.headers.get("Cache-Control")!, /no-store/);
  assert.match(html, /property="og:title" content="Doces &lt;finos&gt; &amp; &quot;festa&quot; · Buffet &quot;A&quot;"/);
  assert.match(html, /noindex,nofollow/); assert.match(html, /<h2>Doces .*<h2>Salgados/);
  assert.match(html, /Brigadeiro &lt;especial&gt;/); assert.match(html, /mailto:buffet@example.test/);
  assert.match(html, /href="https:\/\/buffet\.test\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /<finos>|javascript:|R\$|Pacote Premium|Buffet B|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-/i);
  assert.deepEqual(rota.etapas, ["limite","empresa"]);
});
test("categoria indisponível retorna o completo; buffet vazio exibe contato", async () => {
  const r = await pagina().abrir(["antiga"]); const html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /categoria está indisponível/); assert.match(html, /Coxinha/);
  const vazia = await (await pagina(true, false, []).abrir()).text();
  assert.match(vazia, /Cardápio em preparação/); assert.match(vazia, /buffet@example.test/);
});
test("empresa recusada e caminho inválido recebem corpo 404 idêntico; limite 429 precede consulta", async () => {
  const ausente = await pagina(false).abrir();
  const invalida = await pagina().abrir(["invalida", "extra"]);
  assert.equal(ausente.status, 404); assert.equal(invalida.status, 404);
  assert.equal(await ausente.text(), await invalida.text());
  const rota = pagina(true, true); const r = await rota.abrir();
  assert.equal(r.status, 429); assert.equal(r.headers.get("Retry-After"), "19");
  assert.deepEqual(rota.etapas, ["limite"]); assert.doesNotMatch(await r.text(), /Buffet A|Brigadeiro/);
});

test("segmentos inválidos recebem o 404 padronizado após o limite, antes de consultar a empresa", async () => {
  const corpo404 = await (await pagina(false).abrir()).text();
  for (const codigo of ["do ces", "ab-c", "%00", decodeURIComponent("%00"), "", "AÇ", "AB", "a",
    "1a", "_a", "a".repeat(81), "ab\n"]) {
    const rota = pagina();
    const r = await rota.abrir([codigo]);
    assert.equal(r.status, 404, JSON.stringify(codigo));
    assert.equal(await r.text(), corpo404);
    assert.deepEqual(rota.etapas, ["limite"]);
  }
  for (const codigo of ["a0", "a_2", "a".repeat(80)]) {
    const rota = pagina();
    const r = await rota.abrir([codigo]);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /categoria está indisponível/);
    assert.deepEqual(rota.etapas, ["limite", "empresa"]);
  }
  const limitada = pagina(true, true);
  assert.equal((await limitada.abrir(["ab-c"])).status, 429);
  assert.deepEqual(limitada.etapas, ["limite"]);
});

test("compartilhar aplica o portão público e só lê opções após confirmar o nome da empresa da sessão", async () => {
  for (const caso of ["bloqueada", "sem nome", "outra empresa", "ok"] as const) {
    const etapas: string[] = [];
    const tx = executorFalso([[/SELECT codigo FROM public.empresas/, ([id]) => {
      assert.equal(id, empresaId);
      return [{ codigo: "buffet-a" }];
    }]]);
    const { GET } = carregarModulo("app/api/admin/configuracoes/catalogo/route.ts", {
      "lib/http/admin-crm-api": { exigirApiAdminCrmDisponivel: async () => ({}) },
      "lib/saas/provar-tenant": { withTenantTransaction: (_s: unknown, _id: unknown, fn: (db: typeof tx, tenant: object) => unknown) => fn(tx, { empresaComprovada: empresaId }) },
      "lib/http/api-response": { jsonNoStore: Response.json, apiErrorResponse: (e: unknown) => { throw e; } },
      "lib/comercial/pacotes-admin": {}, "lib/comercial/catalogo-buffet": {},
      "lib/comercial/cardapio-publico": {
        escopoCardapioPublico: async (db: typeof tx, codigo: string) => {
          assert.equal(db, tx); assert.equal(codigo, "buffet-a"); etapas.push("portão");
          return caso === "bloqueada" ? { motivo: "A assinatura está bloqueada." } : { empresaId: caso === "outra empresa" ? "outro" : empresaId };
        },
        lerCardapioPublico: async (db: typeof tx, id: string) => {
          assert.equal(db, tx); assert.equal(id, empresaId); etapas.push("itens");
          return [...categorias, { codigo: "2_personagens", nome: "2 personagens", itens: ["Exemplo"] }];
        },
      },
      "lib/perfil/nome-publico": { nomePublicoDaEmpresa: async (db: typeof tx, id: string) => {
        assert.equal(db, tx); assert.equal(id, empresaId); etapas.push("nome");
        return caso === "sem nome" ? null : "Buffet A";
      } },
    });
    const r = await (GET as (req: object) => Promise<Response>)({ nextUrl: new URL("https://buffet.test/?compartilhar=1") });
    const { data } = await r.json();
    if (caso === "ok") {
      assert.deepEqual(etapas, ["portão", "nome", "itens"]);
      assert.equal(data.completo.caminho, "/b/buffet-a/cardapio");
      assert.deepEqual(data.categorias.map((c: { caminho: string }) => c.caminho), ["/b/buffet-a/cardapio/salgados", "/b/buffet-a/cardapio/doces"]);
      assert.equal(data.emPreparacao, false);
    } else {
      assert.deepEqual(etapas, caso === "sem nome" ? ["portão", "nome"] : ["portão"]);
      assert.deepEqual(Object.keys(data), ["motivo"]);
      assert.match(data.motivo, caso === "sem nome" ? /Perfil da empresa/ : caso === "bloqueada" ? /assinatura está bloqueada/ : /endereço público/);
    }
  }
});

test("POST do Atendimento devolve 409 para o cardápio indisponível e preserva 503 em falha inesperada", async () => {
  for (const indisponivel of [true, false]) {
    const { POST } = carregarModulo("app/api/admin/atendimento/prontas/route.ts", {
      "lib/http/admin-crm-api": { exigirApiAdminCrmDisponivel: async () => ({}) },
      "lib/whatsapp/atendimento/prontas-servico": { prepararRascunho: async () => {
        throw new Error(indisponivel ? "ATENDIMENTO_CARDAPIO_INDISPONIVEL" : "falha inesperada");
      } },
    });
    const r = await (POST as (req: Request) => Promise<Response>)(new Request("https://buffet.test/api/admin/atendimento/prontas", {
      method: "POST", body: JSON.stringify({ acao: "cardapio", cardapio: "CARDAPIO", conversaId: empresaId }),
    }));
    assert.equal(r.status, indisponivel ? 409 : 503);
    assert.equal((await r.json()).codigo, indisponivel ? "ATENDIMENTO_CARDAPIO_INDISPONIVEL" : "ATENDIMENTO_INDISPONIVEL");
  }
});
