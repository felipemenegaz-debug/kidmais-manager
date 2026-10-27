import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { FERRAMENTAS_MCP } from "./ferramentas.ts";

/**
 * A2/A8 estático (proteção contra regressão, não fronteira de segurança): o grafo de imports do canal MCP — rotas
 * app/api/mcp, app/api/admin/mcp, .well-known, lib/integracoes e lib/conhecimento — nunca alcança modelo, roteador,
 * provedor, conversa, planejador, JEV, copiloto, agentes, Demerzel ou Luna. A memória de teste não entra na operação.
 */
const raiz = join(import.meta.dirname, "..", "..", "..");

function arquivos(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((nome) => {
    const c = join(dir, nome);
    if (statSync(c).isDirectory()) return arquivos(c);
    return /\.(ts|tsx)$/.test(nome) && !/\.test\.ts$/.test(nome) ? [c] : [];
  });
}

const ENTRADAS = [
  ...arquivos(join(raiz, "app", "api", "mcp")),
  ...arquivos(join(raiz, "app", "api", "admin", "mcp")),
  ...arquivos(join(raiz, "app", ".well-known")),
  ...arquivos(join(raiz, "app", "admin", "conexoes-ia")),
  join(raiz, "components", "admin", "ConexoesAssistentes.tsx"),
  join(raiz, "components", "admin", "ConsentimentoAssistente.tsx"),
];

// `operacional/consumo.ts` entra pelo registro fechado de leituras (calcular_consumo): cálculo puro, só importa texto-pt.
const PROIBIDOS = /lib[\\/]inteligencia[\\/](modelos|planejador|jev|copiloto|agentes|demerzel|luna|skills|acoes|documentos|importacao)[\\/]|lib[\\/]inteligencia[\\/]operacional[\\/](?!consumo\.ts$)|lib[\\/]inteligencia[\\/](conversa|entendimento|intencao|custos|extensoes)\.ts$|lib[\\/]ia-persistencia[\\/]|app[\\/]api[\\/]admin[\\/]inteligencia[\\/]/;

function resolverImport(de: string, alvo: string): string | null {
  let base: string;
  if (alvo.startsWith("@/")) base = join(raiz, alvo.slice(2));
  else if (alvo.startsWith(".")) base = resolve(dirname(de), alvo);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/**
 * Revisão P3-9: análise SINTÁTICA (TypeScript AST), não regex. Considera dependências de VALOR em todas as formas:
 * `import x from`, `import "efeito-colateral"`, `export … from`, `import()` dinâmico, `require()` e
 * `import x = require()`. Ignora só o que some em runtime: `import type`, `export type` e especificadores todos `type`.
 * Especificador não literal ou relativo não resolvido é registrado e reprovado (nada passa por não ter sido entendido).
 */
function dependenciasDeValor(arquivo: string, fonte: string): { especificadores: string[]; naoAnalisaveis: string[] } {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true, arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const especificadores: string[] = [];
  const naoAnalisaveis: string[] = [];
  const somenteTipo = (no: ts.ImportDeclaration | ts.ExportDeclaration) => {
    if (ts.isImportDeclaration(no)) {
      const c = no.importClause;
      if (!c) return false; // import "x": efeito colateral, é valor
      if (c.isTypeOnly) return true;
      const nb = c.namedBindings;
      return !c.name && !!nb && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly);
    }
    if (no.isTypeOnly) return true;
    const ec = no.exportClause;
    return !!ec && ts.isNamedExports(ec) && ec.elements.length > 0 && ec.elements.every((e) => e.isTypeOnly);
  };
  const visitar = (no: ts.Node) => {
    if ((ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) && no.moduleSpecifier) {
      if (!somenteTipo(no)) {
        if (ts.isStringLiteralLike(no.moduleSpecifier)) especificadores.push(no.moduleSpecifier.text);
        else naoAnalisaveis.push(no.getText(sf));
      }
    } else if (ts.isImportEqualsDeclaration(no) && ts.isExternalModuleReference(no.moduleReference) && !no.isTypeOnly) {
      const e = no.moduleReference.expression;
      if (ts.isStringLiteralLike(e)) especificadores.push(e.text);
      else naoAnalisaveis.push(no.getText(sf));
    } else if (ts.isCallExpression(no) && (no.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(no.expression) && no.expression.text === "require"))) {
      const a = no.arguments[0];
      if (a && ts.isStringLiteralLike(a)) especificadores.push(a.text);
      else naoAnalisaveis.push(no.getText(sf));
    }
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return { especificadores, naoAnalisaveis };
}

type Grafo = { visitados: Set<string>; externos: Set<string>; naoResolvidos: string[]; naoAnalisaveis: string[] };

/** `ler` permite injetar arquivos virtuais (controles positivos) sem escrever no repositório. */
function grafo(entradas: readonly string[] = ENTRADAS, ler: (arquivo: string) => string = (a) => readFileSync(a, "utf8")): Grafo {
  const g: Grafo = { visitados: new Set(), externos: new Set(), naoResolvidos: [], naoAnalisaveis: [] };
  const fila = [...entradas];
  while (fila.length) {
    const atual = fila.pop()!;
    if (g.visitados.has(atual)) continue;
    g.visitados.add(atual);
    const { especificadores, naoAnalisaveis } = dependenciasDeValor(atual, ler(atual));
    g.naoAnalisaveis.push(...naoAnalisaveis.map((t) => `${relative(raiz, atual)}: ${t}`));
    for (const alvo of especificadores) {
      const resolvido = resolverImport(atual, alvo);
      if (resolvido) fila.push(resolvido);
      else if (alvo.startsWith(".") || alvo.startsWith("@/")) g.naoResolvidos.push(`${relative(raiz, atual)} -> ${alvo}`);
      else g.externos.add(alvo);
    }
  }
  return g;
}

function violacoes(g: Grafo) {
  return {
    proibidos: [...g.visitados].map((f) => relative(raiz, f)).filter((f) => PROIBIDOS.test(f)),
    sdks: [...g.externos].filter((e) => /openai|anthropic|@google\/genai|google-generativeai|deepseek|mistral|cohere|langchain|ollama/i.test(e)),
  };
}

test("revisão P3-9 — controles positivos: cada forma de import proibido é detectada; tipos não contam", () => {
  const virtual = join(raiz, "lib", "integracoes", "mcp", "__virtual__.ts");
  const casos: Array<[string, string]> = [
    ["efeito colateral", 'import "../../inteligencia/modelos/roteador.ts";'],
    ["import padrão", 'import x from "@/lib/inteligencia/conversa";'],
    ["reexportação", 'export { atenderConversa } from "../../inteligencia/conversa.ts";'],
    ["import dinâmico", 'export const f = () => import("../../inteligencia/planejador/completar.ts");'],
    ["require", 'const r = require("../../inteligencia/jev/v1/juiz.ts");'],
    ["import = require", 'import x = require("../../inteligencia/copiloto/complementador.ts");'],
    ["SDK de provedor", 'import OpenAI from "openai";'],
  ];
  for (const [nome, fonte] of casos) {
    const g = grafo([virtual], (a) => (a === virtual ? fonte : readFileSync(a, "utf8")));
    const v = violacoes(g);
    assert.ok(g.naoResolvidos.length === 0 && (v.proibidos.length > 0 || v.sdks.length > 0), `${nome}: deveria ser detectado (${JSON.stringify({ ...v, nr: g.naoResolvidos })})`);
  }
  const soTipo = 'import type { DependenciasConversa } from "../../inteligencia/conversa.ts";\nexport type { Foo } from "../../inteligencia/conversa.ts";\nimport { type X } from "../../inteligencia/conversa.ts";';
  const g = grafo([virtual], (a) => (a === virtual ? soTipo : readFileSync(a, "utf8")));
  assert.deepEqual(violacoes(g).proibidos, [], "imports só de tipo não carregam o módulo");
  const naoLiteral = grafo([virtual], (a) => (a === virtual ? 'const m = "x"; export const f = () => import(m);' : readFileSync(a, "utf8")));
  assert.equal(naoLiteral.naoAnalisaveis.length, 1, "import dinâmico não literal é reprovado");
  const quebrado = grafo([virtual], (a) => (a === virtual ? 'import "./nao-existe.ts";' : readFileSync(a, "utf8")));
  assert.equal(quebrado.naoResolvidos.length, 1, "relativo não resolvido é reprovado");
});

test("canal MCP não alcança código de modelo/orquestração nem SDK de provedor (A2 estático)", () => {
  const g = grafo();
  assert.ok(g.visitados.size > 20, `grafo percorrido (${g.visitados.size})`);
  const v = violacoes(g);
  assert.deepEqual(v.proibidos, []);
  assert.deepEqual(v.sdks, []);
  assert.deepEqual(g.naoResolvidos, [], "todo import relativo/alias resolvido");
  assert.deepEqual(g.naoAnalisaveis, [], "nenhum import não literal");
  assert.ok(g.externos.has("@modelcontextprotocol/server") && g.externos.has("@node-oauth/oauth2-server"));
});

test("memória e detector são só de teste: nenhum arquivo operacional os importa", () => {
  const { visitados } = grafo();
  const operacionais = [...visitados].map((f) => relative(raiz, f));
  assert.ok(!operacionais.some((f) => /memoria-teste|detector-rede-teste|apoio-mcp/.test(f)), operacionais.filter((f) => /teste/.test(f)).join(","));
  const fonteDeps = readFileSync(join(raiz, "app", "api", "mcp", "dependencias.ts"), "utf8");
  assert.match(fonteDeps, /criarRepositorioOAuthPostgres/);
  assert.doesNotMatch(fonteDeps, /Memoria/);
});

test("sem DDL em request: nenhum CREATE/ALTER/DROP fora da migration", () => {
  const { visitados } = grafo();
  for (const f of visitados) {
    if (!/integracoes|conhecimento|app[\\/]api[\\/](admin[\\/])?mcp/.test(f)) continue;
    assert.doesNotMatch(readFileSync(f, "utf8"), /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|FUNCTION|TRIGGER|SCHEMA)\b/i, relative(raiz, f));
  }
});

test("lista fechada: exatamente quatro ferramentas, todas de leitura (A8)", () => {
  assert.deepEqual([...FERRAMENTAS_MCP], ["kidmais_consultar_agenda", "kidmais_consultar_recebiveis_resumo", "kidmais_buscar_conhecimento", "kidmais_obter_trecho"]);
  assert.ok(FERRAMENTAS_MCP.every((n) => /^kidmais_(consultar|buscar|obter)_/.test(n)));
  assert.ok(!FERRAMENTAS_MCP.some((n) => /(sql|shell|exec|enviar|criar|alterar|excluir|pagar|baixa)/.test(n)));
});

test("rodada 3, achado 3: rotas OAuth exportam TODOS os métodos (nenhum 405 automático do framework fora do agregado A10)", () => {
  const METODOS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  for (const [arquivo, principal] of [["authorize", "GET"], ["token", "POST"]] as const) {
    const caminho = join(raiz, "app", "api", "mcp", "oauth", arquivo, "route.ts");
    const sf = ts.createSourceFile(caminho, readFileSync(caminho, "utf8"), ts.ScriptTarget.Latest, true);
    const exportados = new Map<string, string>();
    for (const no of sf.statements) {
      const exportado = ts.getModifiers(no as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exportado) continue;
      if (ts.isFunctionDeclaration(no) && no.name) exportados.set(no.name.text, no.getText(sf));
      if (ts.isVariableStatement(no)) for (const d of no.declarationList.declarations) if (ts.isIdentifier(d.name)) exportados.set(d.name.text, d.initializer?.getText(sf) ?? "");
    }
    for (const m of METODOS) assert.ok(exportados.has(m), `${arquivo}: exporta ${m}`);
    for (const m of METODOS.filter((x) => x !== principal)) assert.equal(exportados.get(m), "naoPermitido", `${arquivo}: ${m} vai para atenderMetodoNaoPermitido`);
    assert.match(readFileSync(caminho, "utf8"), /const naoPermitido = async \(\) => atenderMetodoNaoPermitido\(/);
  }
});

test("rodada 4, achado 5: nenhuma rota do canal lê corpo sem limite (request.json/text/arrayBuffer/formData)", () => {
  const rotas = [...arquivos(join(raiz, "app", "api", "mcp")), ...arquivos(join(raiz, "app", "api", "admin", "mcp"))];
  assert.ok(rotas.length >= 6);
  for (const r of rotas) assert.doesNotMatch(readFileSync(r, "utf8"), /request\.(json|text|arrayBuffer|formData|blob)\(/, relative(raiz, r));
  // Controle positivo: o padrão pega a forma proibida.
  assert.match("const x = await request.json();", /request\.(json|text|arrayBuffer|formData|blob)\(/);
});
