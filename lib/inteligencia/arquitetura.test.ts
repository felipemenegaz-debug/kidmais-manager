import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Proteção contra regressão, não fronteira de segurança.
 * A segurança vem do guard, do Tenant Context, da política e do registro fechado de ferramentas.
 * Estes testes só impedem que uma mudança futura puxe driver, SQL ou domínios não aprovados
 * para a camada de IA sem que alguém perceba.
 */

const raiz = join(import.meta.dirname, "..", "..");
const ROTA = "app/api/admin/inteligencia/route.ts";

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return nome === "node_modules" || nome.startsWith(".") ? [] : arquivos(caminho);
    return /\.(ts|tsx)$/.test(nome) ? [caminho] : [];
  });
}

const camadaIA = [
  ...arquivos(join(raiz, "lib", "inteligencia")).filter((arquivo) => !arquivo.endsWith(".test.ts")),
  join(raiz, ROTA),
];

/** Lista fechada, por destino já resolvido: leitura do Financeiro, tenant, guard e utilitários. */
const PERMITIDOS: Readonly<Record<string, readonly string[]>> = {
  "zod": ["ZodError", "z"],
  "next/server": ["NextRequest"],
  "node:crypto": ["randomUUID"],
  "lib/financeiro/servico": ["listarRecebiveis", "Recebivel"],
  "lib/financeiro/calculos": ["reaisDe", "hojeBrasilia"],
  "lib/saas/provar-tenant": ["SessaoParaTenant", "TenantComprovado", "withTenantTransaction"],
  "lib/clientes/services/errors": ["ClienteServiceError"],
  "lib/comercial/pacotes-admin": ["PacoteAdminError"],
  "lib/autenticacao/service": ["Papel"],
  "lib/db/contracts": ["DbExecutor"],
  "lib/http/admin-crm-api": ["exigirApiAdminCrmDisponivel"],
  "lib/http/api-response": ["jsonNoStore"],
};

/** SQL em qualquer caixa, só em literais de string/template: comentários não executam. */
const SQL = /\b(select\s+(distinct\b|[\w*"(])|insert\s+into|update\s+[\w".]+\s+set|delete\s+from|merge\s+into|truncate\s|drop\s+(table|schema|index)|alter\s+table|create\s+(table|index|function|trigger)|on\s+conflict|grant\s)/i;

/** Identificadores que permitem alcançar código ou o executor por caminhos indiretos. */
const INDIRETOS = new Set(["eval", "Reflect", "globalThis", "Function", "require"]);

type Destino = { tipo: "pacote"; chave: string } | { tipo: "arquivo"; chave: string; teste: boolean };

/** Resolve o especificador contra o arquivo importador e normaliza para caminho do repositório sem extensão. */
function resolverDestino(origem: string, importador: string): Destino {
  let caminho: string;
  if (origem.startsWith("@/")) caminho = resolve(raiz, origem.slice(2));
  else if (origem.startsWith(".") || origem.startsWith("/")) caminho = resolve(dirname(importador), origem);
  else return { tipo: "pacote", chave: origem };
  const chave = relative(raiz, caminho).replaceAll("\\", "/").replace(/\.(ts|tsx|mts|js|mjs|cjs)$/, "").replace(/\/index$/, "");
  return { tipo: "arquivo", chave, teste: /\.test(\.|$)/.test(basename(caminho)) };
}

function daCamadaIA(destino: Destino) {
  return destino.tipo === "arquivo" && destino.chave.startsWith("lib/inteligencia/");
}

/** Analisa a AST do TypeScript e devolve cada violação encontrada. */
function violacoes(codigo: string, importador = join(raiz, "lib", "inteligencia", "amostra.ts")): string[] {
  const fonte = ts.createSourceFile(importador, codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const achados: string[] = [];
  const visitar = (no: ts.Node) => {
    if (ts.isImportDeclaration(no)) {
      const origem = (no.moduleSpecifier as ts.StringLiteral).text;
      const destino = resolverDestino(origem, importador);
      const clausula = no.importClause;
      if (destino.tipo === "arquivo" && destino.teste) achados.push(`importa arquivo de teste: ${origem}`);
      if (!clausula) {
        achados.push(`import sem ligação: ${origem}`);
      } else {
        if (clausula.namedBindings && ts.isNamespaceImport(clausula.namedBindings)) achados.push(`import * de ${origem}`);
        if (!daCamadaIA(destino)) {
          const lista = PERMITIDOS[destino.chave];
          if (!lista) achados.push(`destino não aprovado: ${origem} → ${destino.chave}`);
          else {
            if (clausula.name) achados.push(`import default de ${origem}`);
            if (clausula.namedBindings && ts.isNamedImports(clausula.namedBindings)) {
              for (const elemento of clausula.namedBindings.elements) {
                const importado = (elemento.propertyName ?? elemento.name).text;
                if (!lista.includes(importado)) achados.push(`${importado} de ${destino.chave}`);
              }
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(no) && no.moduleSpecifier) {
      achados.push("re-export de módulo");
    } else if (ts.isImportEqualsDeclaration(no)) {
      achados.push("import = require");
    } else if (ts.isCallExpression(no) && no.expression.kind === ts.SyntaxKind.ImportKeyword) {
      achados.push("import() dinâmico");
    } else if (ts.isCallExpression(no) && ts.isElementAccessExpression(no.expression) && !ts.isStringLiteralLike(no.expression.argumentExpression)) {
      achados.push("chamada por chave computada");
    } else if (ts.isPropertyAccessExpression(no) && no.name.text === "query") {
      achados.push(".query");
    } else if (ts.isElementAccessExpression(no) && ts.isStringLiteralLike(no.argumentExpression) && no.argumentExpression.text === "query") {
      achados.push("[\"query\"]");
    } else if (ts.isBindingElement(no) && ((no.propertyName && ts.isIdentifier(no.propertyName) && no.propertyName.text === "query") || (ts.isIdentifier(no.name) && no.name.text === "query"))) {
      achados.push("desestruturação de query");
    } else if (ts.isIdentifier(no) && INDIRETOS.has(no.text) && !ts.isTypeReferenceNode(no.parent)) {
      achados.push(`acesso indireto: ${no.text}`);
    } else if (ts.isStringLiteralLike(no) || ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) {
      if (SQL.test(no.text)) achados.push(`SQL: ${no.text.slice(0, 40)}`);
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return achados;
}

test("12. a camada de IA não fala com o PostgreSQL e só importa o que está na lista fechada", () => {
  assert.ok(camadaIA.length >= 5);
  for (const arquivo of camadaIA) {
    const codigo = readFileSync(arquivo, "utf8");
    const nome = relative(raiz, arquivo);
    assert.deepEqual(violacoes(codigo, arquivo), [], nome);
    assert.doesNotMatch(codigo, /process\.env\.(DATABASE_URL|ADMIN_AUTH_SECRET)|\.env\.local/, `${nome} lê secrets`);
  }
});

test("o analisador detecta cada forma de contornar a lista fechada", () => {
  const proibidos = [
    // Namespace, default, módulo e nome fora da lista.
    'import * as servico from "../financeiro/servico.ts";',
    'import { painelGeral } from "../financeiro/servico.ts";',
    'import { listarContasPagar as listar } from "../financeiro/servico.ts";',
    'import pg from "pg";',
    'import { Pool } from "pg";',
    'import { db } from "../db/postgres.ts";',
    'import "../db/postgres.ts";',
    'import { consultarFestas } from "../festas/service.ts";',
    // Caminhos equivalentes que parecem locais (achados da revisão do Codex).
    'import { painelGeral } from "./../financeiro/servico.ts";',
    'import { db } from "@/lib/inteligencia/../db/postgres";',
    'import { db } from "./../../lib/db/postgres.ts";',
    'import { listarRecebiveis } from "@/../fora/servico";',
    // Arquivos de teste, mesmo dentro da camada.
    'import { bancoFalso } from "./gateway.test.ts";',
    'import { bancoFalso } from "@/lib/inteligencia/gateway.test";',
    // Re-export, CommonJS e import dinâmico.
    'export * from "../financeiro/servico.ts";',
    'export { painelGeral } from "../financeiro/servico.ts";',
    'import pg = require("pg");',
    'const pg = require("pg");',
    'const servico = await import("../financeiro/servico.ts");',
    // Acesso direto ou indireto ao executor.
    'await tx.query("x");',
    'await tx["query"]("x");',
    "const consultar = tx.query;",
    "const { query } = tx;",
    "const { query: consultar } = tx;",
    "await tx[metodo](texto);",
    "Reflect.apply(fn, tx, []);",
    'globalThis["req" + "uire"]("pg");',
    'new Function("return 1")();',
    'eval("1");',
    // SQL em qualquer caixa.
    'const sql = "select * from clientes";',
    'const sql = "SeLeCt id FROM festas";',
    "const sql = `delete from festas where id = ${id}`;",
    'const sql = "Update pacotes set nome = 1";',
    'const sql = "insert into auditoria values (1)";',
    'const sql = "INSERT INTO x (a) VALUES (1) on conflict do nothing";',
    'const sql = "drop table x";',
  ];
  for (const amostra of proibidos) {
    assert.notDeepEqual(violacoes(amostra), [], amostra);
  }
  const permitidos = [
    'import { listarRecebiveis, type Recebivel } from "../financeiro/servico.ts";',
    'import type { DbExecutor } from "../db/contracts.ts";',
    'import { autorizarFerramenta } from "./politica.ts";',
    'import { withTenantTransaction } from "@/lib/saas/provar-tenant";',
    'const texto = "Selecione o período. Nenhum pagamento vencido.";',
    "const item = ferramentas[nome];",
  ];
  for (const amostra of permitidos) {
    assert.deepEqual(violacoes(amostra), [], amostra);
  }
});

test("a rota usa o guard administrativo e o Tenant Context existentes, somente por POST", () => {
  const rota = readFileSync(join(raiz, ROTA), "utf8");
  assert.match(rota, /exigirApiAdminCrmDisponivel\(request\)/);
  assert.match(rota, /withTenantTransaction/);
  assert.match(rota, /export async function POST/);
  assert.doesNotMatch(rota, /export (async )?function (GET|PUT|PATCH|DELETE)/);
  assert.match(rota, /searchParams\.get\("empresaId"\)/);
});

test("10. o Core não depende da IA: nenhum import fora da IA resolve para lib/inteligencia", () => {
  const foraDaIA = [...arquivos(join(raiz, "lib")), ...arquivos(join(raiz, "app")), ...arquivos(join(raiz, "components"))]
    .filter((arquivo) => !camadaIA.includes(arquivo) && !relative(raiz, arquivo).replaceAll("\\", "/").startsWith("lib/inteligencia/"));
  assert.ok(foraDaIA.length > 100);
  for (const arquivo of foraDaIA) {
    const fonte = ts.createSourceFile(arquivo, readFileSync(arquivo, "utf8"), ts.ScriptTarget.Latest, true);
    const visitar = (no: ts.Node) => {
      const especificador = ts.isImportDeclaration(no) || ts.isExportDeclaration(no) ? no.moduleSpecifier
        : ts.isCallExpression(no) && (no.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(no.expression) && no.expression.text === "require")) ? no.arguments[0]
          : undefined;
      if (especificador && ts.isStringLiteralLike(especificador)) {
        assert.equal(daCamadaIA(resolverDestino(especificador.text, arquivo)), false, `${relative(raiz, arquivo)} importa ${especificador.text}`);
      }
      ts.forEachChild(no, visitar);
    };
    visitar(fonte);
  }
});

test("a flag só é lida pela IA; o Core não consulta INTELIGENCIA_ENABLED", () => {
  const leitores = [...arquivos(join(raiz, "lib")), ...arquivos(join(raiz, "app")), ...arquivos(join(raiz, "components"))]
    .filter((arquivo) => !arquivo.endsWith(".test.ts") && readFileSync(arquivo, "utf8").includes("INTELIGENCIA_ENABLED"))
    .map((arquivo) => relative(raiz, arquivo).replaceAll("\\", "/"));
  assert.deepEqual(leitores, ["lib/inteligencia/gateway.ts"]);
});
