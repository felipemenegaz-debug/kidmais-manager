import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const req = createRequire(import.meta.url);
const empresaB = "22222222-2222-4222-8222-222222222222";
const pacoteB = "33333333-3333-4333-8333-333333333333";
const sessaoA = {
  id: "sessao-a",
  usuario_id: "usuario-a",
  nome: "Usuario A",
  cargo: null,
  papel: "REPRESENTANTE_AUTORIZADO" as const,
  autenticado_em: "2026-09-26T00:00:00Z",
  expira_em: "2026-09-26T01:00:00Z",
  csrf_hash: "hash",
};

function caminhoTs(base: string) {
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`;
  if (existsSync(`${base}/index.ts`)) return `${base}/index.ts`;
  return base;
}

const empresaA = "11111111-1111-4111-8111-111111111111";

function responderProva(sql: string, memberships: Array<{ id: string; empresa_id: string }>) {
  if (sql.includes("FROM usuarios_administrativos") && !sql.includes("memberships")) {
    return { rows: [{ ativo: true }], rowCount: 1 };
  }
  if (sql.includes("FROM empresas") && sql.includes("FOR UPDATE") && !sql.includes("memberships")) {
    return { rows: [{ id: "empresa", status: "ATIVA" }], rowCount: 1 };
  }
  if (sql.includes("m.status AS membership")) {
    return memberships.length === 1
      ? { rows: [{ membership: "ATIVA", empresa: "ATIVA", ativo: true }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (sql.includes("FROM memberships")) return { rows: memberships, rowCount: memberships.length };
  return null;
}

function carregarRota(arquivo: string, memberships: Array<{ id: string; empresa_id: string }> = []) {
  const cache = new Map<string, Record<string, unknown>>();
  const consultas: string[] = [];
  const postgres = {
    db() {
      return {
        query: async (sql: string) => {
          consultas.push(sql);
          throw new Error("DB_NAO_DEVE_RODAR");
        },
      };
    },
    async withTransaction(fn: (tx: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) {
      return fn({
        query: async (sql: string, values?: readonly unknown[]) => {
          consultas.push(`${sql}\n${JSON.stringify(values ?? [])}`);
          const prova = responderProva(sql, memberships);
          if (prova) return prova;
          if (/^\s*SELECT\b/i.test(sql) && sql.includes("pacotes")) {
            return { rows: [], rowCount: 0 };
          }
          throw new Error("DB_NAO_DEVE_RODAR");
        },
      });
    },
  };
  function load(file: string): Record<string, unknown> {
    const normal = resolve(file).replaceAll("\\", "/");
    const hit = cache.get(normal);
    if (hit) return hit;
    const exports: Record<string, unknown> = {};
    cache.set(normal, exports);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (id: string) => {
      if (id === "zod" || id === "next/server" || (!id.startsWith(".") && !id.startsWith("@/"))) return req(id);
      const base = id.startsWith("@/") ? resolve(id.slice(2)) : resolve(dirname(file), id);
      const alvo = caminhoTs(base.replace(/\.ts$/, ""));
      const chave = resolve(alvo).replaceAll("\\", "/");
      if (chave.endsWith("lib/db/postgres.ts")) return postgres;
      if (chave.endsWith("lib/http/admin-crm-api.ts")) {
        return { exigirApiAdminCrmDisponivel: async () => sessaoA };
      }
      return load(alvo);
    };
    new Function("require", "exports", code)(localRequire, exports);
    return exports;
  }
  return { modulo: load(resolve(arquivo)), consultas };
}

function pedido(url: string, body?: unknown) {
  return {
    method: body ? "POST" : "GET",
    nextUrl: new URL(url),
    json: async () => body,
    headers: { get: () => null },
    cookies: { get: () => undefined },
  };
}

async function corpo(response: { json: () => Promise<unknown>; status: number }) {
  return { status: response.status, json: await response.json() as { codigo?: string; ok?: boolean } };
}

const contexto = { params: Promise.resolve({ id: pacoteB }) };

test("usuário A recebe 403 ao operar a empresa B nas rotas de pacote", async () => {
  const casos: Array<{ arquivo: string; metodo: string; url: string; body?: unknown; params?: boolean }> = [
    { arquivo: "app/api/admin/configuracoes/pacotes/route.ts", metodo: "GET", url: `http://localhost/api/admin/configuracoes/pacotes?empresaId=${empresaB}` },
    { arquivo: "app/api/admin/configuracoes/pacotes/route.ts", metodo: "POST", url: "http://localhost/api/admin/configuracoes/pacotes", body: { acao: "criar", empresaId: empresaB, codigo: "NOVO_B", nome: "Pacote B", descricao: null, duracaoMinutos: null, motivo: "Tentativa cruzada" } },
    { arquivo: "app/api/admin/configuracoes/pacotes/[id]/route.ts", metodo: "GET", url: `http://localhost/api/admin/configuracoes/pacotes/${pacoteB}?empresaId=${empresaB}`, params: true },
    { arquivo: "app/api/admin/configuracoes/pacotes/[id]/route.ts", metodo: "PATCH", url: `http://localhost/api/admin/configuracoes/pacotes/${pacoteB}`, params: true, body: { acao: "editar", empresaId: empresaB, nome: "Invadido", descricao: null, duracaoMinutos: null, motivo: "Tentativa cruzada" } },
    { arquivo: "app/api/admin/configuracoes/pacotes/[id]/historico/route.ts", metodo: "GET", url: `http://localhost/api/admin/configuracoes/pacotes/${pacoteB}/historico?empresaId=${empresaB}`, params: true },
    { arquivo: "app/api/admin/configuracoes/pacotes/[id]/composicao/route.ts", metodo: "POST", url: `http://localhost/api/admin/configuracoes/pacotes/${pacoteB}/composicao`, params: true, body: { acao: "vinculo", empresaId: empresaB, adicionalId: "44444444-4444-4444-8444-444444444444", modalidade: "EXTRA" } },
  ];
  for (const caso of casos) {
    const { modulo, consultas } = carregarRota(caso.arquivo);
    const handler = modulo[caso.metodo] as (request: object, context?: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
    const resposta = await corpo(await handler(pedido(caso.url, caso.body), caso.params ? contexto : undefined));
    assert.equal(resposta.status, 403, caso.arquivo);
    assert.equal(resposta.json.codigo, "TENANT_NAO_COMPROVADO", caso.arquivo);
    assert.equal(consultas.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)), false, caso.arquivo);
    assert.equal(JSON.stringify(resposta.json).includes(empresaB), false, caso.arquivo);
  }
});

test("usuário A recebe 403 ao criar, precificar ou publicar a tabela da empresa B", async () => {
  const { modulo, consultas } = carregarRota("app/api/admin/configuracoes/tabelas-preco/route.ts");
  const post = modulo.POST as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
  for (const body of [
    { acao: "criar", empresaId: empresaB, codigo: "TABELA_B", nome: "Tabela B", vigenciaInicio: "2026-10-01", vigenciaFim: null },
    { acao: "preco", empresaId: empresaB, tabelaId: "55555555-5555-4555-8555-555555555555", pacoteId: pacoteB, convidadosMin: 40, convidadosMax: 80, tipoCalculo: "FIXO", valor: "10.00", categoriaHorario: "PADRAO" },
    { acao: "publicar", empresaId: empresaB, tabelaId: "55555555-5555-4555-8555-555555555555" },
    { acao: "escopo", empresaId: empresaB, tabelaId: "55555555-5555-4555-8555-555555555555", combinacoes: [] },
    { acao: "simular_festa", empresaId: empresaB, data: "2026-10-10", pacoteId: pacoteB, convidados: 40, categoriaHorario: "PADRAO", sobConsulta: false },
  ]) {
    const resposta = await corpo(await post(pedido("http://localhost/api/admin/configuracoes/tabelas-preco", body)));
    assert.equal(resposta.status, 403, body.acao);
    assert.equal(resposta.json.codigo, "TENANT_NAO_COMPROVADO");
    assert.equal(consultas.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)), false, body.acao);
  }
  const get = modulo.GET as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
  const leitura = await corpo(await get(pedido(`http://localhost/api/admin/configuracoes/tabelas-preco?empresaId=${empresaB}`)));
  assert.equal(leitura.status, 403);
  assert.equal(leitura.json.codigo, "TENANT_NAO_COMPROVADO");
  assert.equal(consultas.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
  consultas.length = 0;
  const local = await corpo(await post(pedido("http://localhost/api/admin/configuracoes/tabelas-preco", { acao: "simular", valor: "10.00", sobConsulta: false })));
  assert.equal(local.status, 200);
  assert.equal(consultas.length, 0);
});

test("o catálogo administrativo não lista nem altera pacote de outra empresa", async () => {
  const { modulo, consultas } = carregarRota("app/api/admin/configuracoes/catalogo/route.ts");
  const get = modulo.GET as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
  const patch = modulo.PATCH as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
  const leitura = await corpo(await get(pedido("http://localhost/api/admin/configuracoes/catalogo")));
  const escrita = await corpo(await patch(pedido("http://localhost/api/admin/configuracoes/catalogo", {
    acao: "vinculo_adicional", pacoteId: pacoteB, adicionalId: "44444444-4444-4444-8444-444444444444", modalidade: "INCLUSO",
  })));
  assert.equal(leitura.status, 403);
  assert.equal(escrita.status, 403);
  assert.equal(leitura.json.codigo, "TENANT_NAO_COMPROVADO");
  assert.equal(escrita.json.codigo, "TENANT_NAO_COMPROVADO");
  assert.equal(consultas.some((sql) => sql.includes("buffet_categorias") || sql.includes("FROM pacotes") || sql.includes("FROM adicionais")), false);
});

test("o id do cliente não escolhe empresa fora das memberships provadas", async () => {
  const memberships = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", empresa_id: empresaA }];
  const { modulo, consultas } = carregarRota("app/api/admin/configuracoes/pacotes/route.ts", memberships);
  const get = modulo.GET as (request: object) => Promise<{ status: number; json: () => Promise<unknown> }>;
  const cruzada = await corpo(await get(pedido(`http://localhost/api/admin/configuracoes/pacotes?empresaId=${empresaB}`)));
  assert.equal(cruzada.status, 403);
  assert.equal(cruzada.json.codigo, "TENANT_NAO_COMPROVADO");
  assert.equal(consultas.some((sql) => sql.includes("FROM pacotes p")), false);
  consultas.length = 0;
  const propria = await corpo(await get(pedido(`http://localhost/api/admin/configuracoes/pacotes?empresaId=${empresaA}`)));
  assert.equal(propria.status, 200);
  assert.equal(propria.json.ok, true);
  assert.equal(consultas.some((sql) => sql.includes(empresaA) && sql.includes("pacotes")), true);
  assert.equal(consultas.some((sql) => sql.includes(empresaB)), false);
});
