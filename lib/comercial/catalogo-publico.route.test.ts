import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";

const req = createRequire(import.meta.url);
const empresaA = "11111111-1111-4111-8111-111111111111";
const empresaB = "22222222-2222-4222-8222-222222222222";

function caminhoTs(base: string) {
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`;
  if (existsSync(`${base}/index.ts`)) return `${base}/index.ts`;
  return base;
}

function carregar(arquivo: string) {
  const cache = new Map<string, Record<string, unknown>>();
  const consultas: string[] = [];
  const linhas = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", codigo: "COMPLETA", nome: "Completa A", empresa_id: empresaA, ativo: true },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", codigo: "COMPLETA", nome: "Completa B", empresa_id: empresaB, ativo: true },
  ];
  const postgres = {
    db() {
      return {
        query: async (sql: string) => {
          consultas.push(sql);
          return { rows: linhas, rowCount: linhas.length };
        },
      };
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
      return load(alvo);
    };
    new Function("require", "exports", code)(localRequire, exports);
    return exports;
  }
  return { modulo: load(resolve(arquivo)), consultas, linhas };
}

test("o mesmo código em duas empresas não é escolhido pelo catálogo público", async () => {
  for (const arquivo of [
    "app/api/fechamentos/pacotes/route.ts",
    "app/api/fechamentos/adicionais/route.ts",
    "app/api/fechamentos/catalogo/route.ts",
  ]) {
    const { modulo, consultas } = carregar(arquivo);
    const GET = modulo.GET as (request: { nextUrl: URL }) => Promise<{ status: number; json: () => Promise<{ codigo?: string }> }>;
    const resposta = await GET({ nextUrl: new URL("http://localhost/api/fechamentos/catalogo?pacote=COMPLETA") });
    const json = await resposta.json();
    assert.equal(resposta.status, 403, arquivo);
    assert.equal(json.codigo, "CATALOGO_PUBLICO_INDETERMINADO", arquivo);
    assert.equal(consultas.length, 0, arquivo);
    assert.equal(JSON.stringify(json).includes(empresaA), false, arquivo);
    assert.equal(JSON.stringify(json).includes(empresaB), false, arquivo);
    assert.equal(JSON.stringify(json).includes("Completa A"), false, arquivo);
    assert.equal(JSON.stringify(json).includes("Completa B"), false, arquivo);
  }
});

test("buscar por código não devolve a primeira linha quando o código existe nas duas empresas", async () => {
  const { modulo, consultas } = carregar("lib/comercial/repositories/comercial.repository.ts");
  const buscar = modulo.buscarPacoteAtivoPorCodigo as (codigo: string, db: DbExecutor) => Promise<{ nome: string } | null>;
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string): Promise<DbQueryResult<Row>> {
      consultas.push(sql);
      return {
        rows: [
          { nome: "Completa A", empresa_id: empresaA } as Row,
          { nome: "Completa B", empresa_id: empresaB } as Row,
        ],
        rowCount: 2,
      };
    },
  };
  await assert.rejects(
    () => buscar("COMPLETA", tx),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CATALOGO_PUBLICO_INDETERMINADO",
  );
  assert.equal(consultas.length, 0);
});
