/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const assets = path.resolve(__dirname, '../.next/server/assets');
const arquivo = fs.readdirSync(assets).find((nome) => /^pdf-worker-runtime\..*\.cjs$/.test(nome));
assert(arquivo, 'Worker executável ausente do build');
// Executa o asset de produção, sem carregar fontes TS, servidor, rede ou banco.
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 80 >>\nstream\nBT /F1 10 Tf (Contratante: Maria Teste) Tj (CPF 529.982.247-25) Tj ET\nendstream\nendobj\n%%EOF', 'latin1');
const worker = new Worker(path.join(assets, arquivo), { workerData: { bytes: new Uint8Array(pdf), opcoes: { prazoMs: 3000 } } });
const timer = setTimeout(() => { void worker.terminate(); process.exitCode = 1; console.error('Worker de produção não respondeu'); }, 5000);
worker.once('error', (erro) => { clearTimeout(timer); throw erro; });
worker.once('message', (resultado) => {
  clearTimeout(timer);
  void worker.terminate();
  assert.equal(resultado.interrompido, null);
  assert.match(resultado.paginas.join('\n'), /Maria Teste/);
  assert.match(resultado.paginas.join('\n'), /529\.982\.247-25/);
  console.log('PASS Worker do build: nome e CPF lidos no asset de produção.');
});
