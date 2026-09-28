import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Proteção contra regressão da demo (não é fronteira de segurança):
 * a importação não fala com rede, repositório ou SQL, e a UI de IA só chama o endpoint somente leitura.
 */
const IMPORTACAO = [
  'lib/importacao-contrato/modelo.ts',
  'lib/importacao-contrato/demo-extracao.ts',
  'lib/importacao-contrato/revisao.ts',
  'components/admin/importacao/ImportarContratoAntigo.tsx',
  'app/admin/contratos/importar/page.tsx',
];

const UI_IA = [
  ...readdirSync('components/admin/inteligencia').filter((nome) => /\.tsx?$/.test(nome) && !nome.includes('.test.')).map((nome) => join('components/admin/inteligencia', nome)),
  'components/admin/InteligenciaCard.tsx',
];

const SQL = /\b(select\s+[\w*"(]|insert\s+into|update\s+[\w".]+\s+set|delete\s+from|truncate\s|drop\s+table|alter\s+table)/i;
const REDE = new Set(['fetch', 'adminFetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'FormData', 'FileReader', 'arrayBuffer', 'createObjectURL', 'eval', 'Function']);

function analisar(arquivo: string) {
  const fonte = ts.createSourceFile(arquivo, readFileSync(arquivo, 'utf8'), ts.ScriptTarget.Latest, true, arquivo.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports: string[] = [];
  const identificadores = new Set<string>();
  const literais: string[] = [];
  const visitar = (no: ts.Node) => {
    if (ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) {
      if (no.moduleSpecifier && ts.isStringLiteral(no.moduleSpecifier)) imports.push(no.moduleSpecifier.text);
    } else if (ts.isStringLiteralLike(no)) {
      literais.push(no.text);
    }
    if (ts.isCallExpression(no) && no.expression.kind === ts.SyntaxKind.ImportKeyword) imports.push('import()');
    if (ts.isIdentifier(no)) identificadores.add(no.text);
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return { imports, identificadores, literais };
}

test('importação: nenhuma função chama rede, repositório, serviço de domínio ou SQL', () => {
  const permitido = /^(react|next\/link|\.\/[\w.-]+|@\/lib\/importacao-contrato\/[\w-]+|@\/components\/admin\/importacao\/[\w-]+)$/;
  for (const arquivo of IMPORTACAO) {
    const { imports, identificadores, literais } = analisar(arquivo);
    for (const origem of imports) assert.match(origem, permitido, `${arquivo} importa ${origem}`);
    for (const proibido of REDE) assert.equal(identificadores.has(proibido), false, `${arquivo} usa ${proibido}`);
    for (const literal of literais) {
      assert.doesNotMatch(literal, SQL, `${arquivo}: SQL em literal`);
      assert.doesNotMatch(literal, /\/api\//, `${arquivo}: endpoint ${literal}`);
    }
    assert.doesNotMatch(readFileSync(arquivo, 'utf8'), /repositor|lib\/db|from ['"]pg['"]|method:\s*['"](POST|PUT|PATCH|DELETE)/i, arquivo);
  }
});

test('importação: o adapter de demonstração é explícito e isolado', () => {
  const adapter = readFileSync('lib/importacao-contrato/demo-extracao.ts', 'utf8');
  assert.match(adapter, /DEMO ADAPTER — NÃO É EXTRAÇÃO REAL/);
  assert.match(adapter, /export function demoContractExtraction/);
  assert.match(adapter, /fonte: "DEMONSTRACAO"/);
  const tela = readFileSync('components/admin/importacao/ImportarContratoAntigo.tsx', 'utf8');
  assert.match(tela, /extracao\.fonte === 'DEMONSTRACAO'/);
  assert.match(tela, /A persistência definitiva será habilitada após validação do Import Engine\./);
});

test('UI de IA: só o endpoint somente leitura, sem SQL, sem repositório e sem camada de IA importada', () => {
  const endpoints = new Set<string>();
  for (const arquivo of UI_IA) {
    const { imports, literais } = analisar(arquivo);
    for (const origem of imports) assert.doesNotMatch(origem, /lib\/(inteligencia|db|.*repositor)|^pg$|services?\//, `${arquivo} importa ${origem}`);
    for (const literal of literais) {
      assert.doesNotMatch(literal, SQL, `${arquivo}: SQL em literal`);
      if (literal.startsWith('/api/')) endpoints.add(literal);
    }
    assert.doesNotMatch(readFileSync(arquivo, 'utf8'), /method:\s*['"](PUT|PATCH|DELETE)/, arquivo);
  }
  assert.deepEqual([...endpoints], ['/api/admin/inteligencia']);
});
