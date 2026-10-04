/* eslint-disable @typescript-eslint/no-require-imports */
// Turbopack copia o asset do Worker sem compilar suas dependências TypeScript.
// Geramos um único arquivo CommonJS, com o parser e apenas imports nativos de Node.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const raiz = path.resolve(__dirname, '..');
const dir = path.join(raiz, 'lib/importacao-contrato');
const parser = fs.readFileSync(path.join(dir, 'pdf-texto.ts'), 'utf8');
const worker = fs.readFileSync(path.join(dir, 'pdf-worker.ts'), 'utf8').replace(/^import .*from "\.\/pdf-texto\.ts";\r?\n/m, '');
const resultado = ts.transpileModule(parser + '\n' + worker, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const gerado = '/* eslint-disable */\n// Gerado por scripts/gerar-pdf-worker.cjs; editar os fontes TypeScript.\n' + resultado.outputText;
const destino = path.join(dir, 'pdf-worker-runtime.cjs');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destino, 'utf8').replace(/\r\n/g, '\n') !== gerado) throw new Error('Worker desatualizado: execute node scripts/gerar-pdf-worker.cjs');
} else fs.writeFileSync(destino, gerado);
