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

function carregar(arquivo: string, opcoes: { empresa?: string; ativa?: boolean; instalada?: boolean; ambigua?: boolean } = {}) {
  const cache = new Map<string, Record<string, unknown>>();
  const consultas: string[] = [];
  const linhas = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", codigo: "COMPLETA", nome: "Completa A", empresa_id: empresaA, ativo: true },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", codigo: "COMPLETA", nome: "Completa B", empresa_id: empresaB, ativo: true },
  ];
  const postgres = {
    db() {
      return {
        query: async (sql: string, valores: unknown[] = []) => {
          consultas.push(sql);
          const resultado = (rows: object[]) => ({ rows, rowCount: rows.length });
          if (sql.includes("to_regprocedure")) return resultado([{ instalada: opcoes.instalada !== false }]);
          if (sql.includes("information_schema.columns")) return resultado([{ ok: false }]);
          if (sql.includes("FROM public.empresas")) return resultado([{ ok: opcoes.ativa !== false }]);
          if (sql.includes("FROM public.estabelecimentos")) return resultado([]);
          if (sql.includes("FROM pacotes")) {
            assert.match(sql, /empresa_id = \$1::uuid/);
            assert.match(sql, /vigente/);
            assert.match(sql, /arquivado_em IS NULL/);
            const filtradas = linhas.filter(l => l.empresa_id === valores[0] && l.codigo === valores[1]);
            return resultado(opcoes.ambigua ? [...filtradas, ...filtradas] : filtradas);
          }
          if (sql.includes("FROM tabelas_preco")) {
            assert.equal(valores[0], opcoes.empresa);
            return resultado([{ id: "tabela-a" }]);
          }
          if (sql.includes("FROM pacote_adicionais")) {
            assert.equal(valores[0], opcoes.empresa);
            assert.equal(valores[1], linhas[0].id);
            return resultado([{ codigo: "BOMBOM", nome: "Bombom A", categoria: "BUFFET", unidade_cobranca: "UNIDADE", modalidade: "EXTRA", valor: "5.00" }]);
          }
          if (sql.includes("SELECT DISTINCT i.codigo")) return resultado([]);
          if (sql.includes("FROM pacote_buffet_categorias")) {
            assert.equal(valores[0], linhas[0].id);
            return resultado([{ categoria_id: "c", codigo: "DOCES", nome: "Doces A", escolhas_max: 2, item_id: "i", item_nome: "Doce A" }]);
          }
          throw Error("Consulta inesperada: " + sql);
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
    new Function("require", "exports", "process", code)(localRequire, exports, { ...process, env: { AGENDA_PUBLICA_EMPRESA_ID: opcoes.empresa } });
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

type GetPublico = (request: { nextUrl: URL }) => Promise<Response>;
const rotas = ["pacotes", "adicionais", "catalogo"];
const pedido = (rota: string) => ({ nextUrl: new URL(`http://localhost/api/fechamentos/${rota}?pacote=${rota === "adicionais" ? "completa" : "COMPLETA"}&data=2026-10-24&convidados=50&empresaId=${empresaB}&contexto=ADMIN`) });

test("catálogo configurado: pacote, adicionais e buffet só de A, mesmo com B/ADMIN na URL", async () => {
  for (const rota of rotas) {
    const { modulo } = carregar(`app/api/fechamentos/${rota}/route.ts`, { empresa: empresaA });
    const resposta = await (modulo.GET as GetPublico)(pedido(rota));
    assert.equal(resposta.status, 200, rota);
    assert.equal(resposta.headers.get("Cache-Control"), "no-store");
    const corpo = await resposta.json();
    if (rota === "pacotes") {
      assert.equal(corpo.pacotes.length, 1);
      assert.equal(corpo.pacotes[0].nome, "Completa A");
    } else if (rota === "adicionais") {
      assert.deepEqual(corpo.adicionais.map((a: { id: string; preco: number }) => [a.id, a.preco]), [["bombom", 5]]);
    } else {
      assert.equal(corpo.categorias[0].itens[0].nome, "Doce A");
    }
    assert.doesNotMatch(JSON.stringify(corpo), /Completa B/);
  }
});

test("empresa inválida/inativa ou schema sem escopo nunca abre catálogo global", async () => {
  for (const opcoes of [{ empresa: "invalida" }, { empresa: empresaA, ativa: false }, { empresa: empresaA, instalada: false }]) {
    for (const rota of rotas) {
      const { modulo, consultas } = carregar(`app/api/fechamentos/${rota}/route.ts`, opcoes);
      const resposta = await (modulo.GET as GetPublico)(pedido(rota));
      assert.ok([403, 503].includes(resposta.status));
      assert.ok(consultas.every(sql => !sql.includes("FROM pacotes")), "não consulta pacote sem escopo");
    }
  }
});

test("revisões ambíguas são recusadas, sem juntar o buffet de dois pacotes", async () => {
  const { modulo, consultas } = carregar("app/api/fechamentos/catalogo/route.ts", { empresa: empresaA, ambigua: true });
  const resposta = await (modulo.GET as GetPublico)(pedido("catalogo"));
  assert.equal(resposta.status, 404);
  assert.ok(consultas.every(sql => !sql.includes("FROM pacote_buffet_categorias")));
});
