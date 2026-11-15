import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

// AF-R3: o painel "Acesso da família" (GET e POST) é só da Gestão da empresa comprovada. A rota real é transpilada e
// roda com dependências falsas: nenhum banco, sessão ou serviço real é carregado.

const festaId = "00000000-0000-4000-8000-000000000123";
const GESTAO = { papelAtual: "REPRESENTANTE_AUTORIZADO", empresaComprovada: "emp-1", usuarioId: "u-1" };
const OPERADOR = { papelAtual: "OPERADOR", empresaComprovada: "emp-1", usuarioId: "u-2" };
type Handler = (request: unknown, contexto: { params: Promise<{ festaId: string }> }) => Promise<Response>;

function carregarRota(tenant: typeof GESTAO) {
  const chamadas: string[] = [];
  class AreaFamiliaError extends Error {}
  const servico = (nome: string) => async () => { chamadas.push(nome); return { nome }; };
  const dependencias: Record<string, unknown> = {
    zod: { z },
    "@/lib/area-familia/admin": {
      AreaFamiliaError,
      resumoAreaFamilia: servico("resumo"),
      gerarLinkArea: servico("gerarLink"),
      desconectarTodos: servico("desconectar"),
      cadastrarSegundo: servico("cadastrar"),
      removerSegundo: servico("remover"),
    },
    "@/lib/area-familia/http": { areaFamiliaLigada: () => true, pepperIdentidade: () => "p".repeat(32) },
    "@/lib/http/api-response": {
      jsonNoStore: (corpo: unknown, init?: ResponseInit) => Response.json(corpo, init),
      apiErrorResponse: (erro: { httpStatus?: number }) => Response.json({ ok: false }, { status: erro.httpStatus ?? 500 }),
    },
    "@/lib/http/admin-crm-api": { exigirApiAdminCrmDisponivel: async () => ({ sessao: "sintetica" }) },
    "@/lib/saas/provar-tenant": {
      withTenantTransaction: async (_s: unknown, _e: unknown, fn: (tx: unknown, t: typeof GESTAO) => unknown) => fn({}, tenant),
      // Mesma regra de lib/saas/provar-tenant.ts (conferida abaixo pelo texto da guarda real).
      exigirGestaoNoTenant: (t: typeof GESTAO, mensagem: string) => {
        chamadas.push("guarda");
        if (t.papelAtual !== "REPRESENTANTE_AUTORIZADO") throw Object.assign(new Error(mensagem), { httpStatus: 403 });
      },
    },
  };
  const exports: Record<string, unknown> = {};
  const codigo = ts.transpileModule(readFileSync(new URL("../../app/api/admin/festas/[festaId]/area-familia/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", codigo)((nome: string) => {
    assert.ok(Object.hasOwn(dependencias, nome), `dependência inesperada: ${nome}`);
    return dependencias[nome];
  }, exports);
  return { GET: exports.GET as Handler, POST: exports.POST as Handler, chamadas };
}

const contexto = () => ({ params: Promise.resolve({ festaId }) });
const pedidoGet = () => ({ nextUrl: new URL(`https://app.exemplo.test/api/admin/festas/${festaId}/area-familia`) });
const pedidoPost = (corpo: unknown) => ({ json: async () => corpo });

test("GET do painel: operador recebe 403 e o resumo nem é lido", async () => {
  const rota = carregarRota(OPERADOR);
  const resposta = await rota.GET(pedidoGet(), contexto());
  assert.equal(resposta.status, 403);
  assert.deepEqual(rota.chamadas, ["guarda"]);
});

test("GET do painel: gestão passa pela guarda antes do resumo", async () => {
  const rota = carregarRota(GESTAO);
  const resposta = await rota.GET(pedidoGet(), contexto());
  assert.equal(resposta.status, 200);
  assert.deepEqual(rota.chamadas, ["guarda", "resumo"]);
});

test("POST do painel: operador recebe 403 em toda ação; gestão executa", async () => {
  const acoes = [
    { acao: "GERAR_LINK", papel: "CONTRATANTE" },
    { acao: "DESCONECTAR_TODOS" },
    { acao: "CADASTRAR_SEGUNDO", nome: "Maria Teste", whatsapp: "11988887777" },
    { acao: "REMOVER_SEGUNDO", pessoaId: festaId },
  ];
  for (const corpo of acoes) {
    const operador = carregarRota(OPERADOR);
    assert.equal((await operador.POST(pedidoPost(corpo), contexto())).status, 403, corpo.acao);
    assert.deepEqual(operador.chamadas, ["guarda"], corpo.acao);
    const gestao = carregarRota(GESTAO);
    assert.equal((await gestao.POST(pedidoPost(corpo), contexto())).status, 200, corpo.acao);
    assert.equal(gestao.chamadas[0], "guarda", corpo.acao);
    assert.equal(gestao.chamadas.length, 2, corpo.acao);
  }
});

test("guarda falsa espelha a real; cartão da área só é montado para a gestão", () => {
  const real = readFileSync(new URL("../saas/provar-tenant.ts", import.meta.url), "utf8");
  assert.match(real, /export function exigirGestaoNoTenant\(tenant: TenantComprovado, mensagem: string\): void \{\s+if \(tenant\.papelAtual !== "REPRESENTANTE_AUTORIZADO"\) throw/);
  const console = readFileSync(new URL("../../components/festas/FestaConsole.tsx", import.meta.url), "utf8");
  const montagens = console.match(/[^{}]*<AreaFamiliaPainel\b/g) ?? [];
  assert.equal(montagens.length, 1);
  assert.match(montagens[0], /festaId&&gestao&&<AreaFamiliaPainel\b/);
});
