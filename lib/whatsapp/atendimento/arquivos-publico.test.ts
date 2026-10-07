import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as nodeCrypto from 'node:crypto';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import * as arquivos from './arquivos.ts';

// Banco simulado: nenhum PostgreSQL real é acessado.
const ID = '7f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f601';
const TOKEN = 'A'.repeat(43);
const PDF = Buffer.from('%PDF-1.4\n% sintético\n%%EOF\n');
function carregar(linha: Record<string, unknown> | null, ambiente = 'staging') {
  const consultas: unknown[][] = [];
  const modulo = carregarComponente('lib/whatsapp/atendimento/arquivos-publico.ts', {
    '../../db/postgres.ts': { db: () => ({ query: async (_sql: string, args: unknown[]) => { consultas.push(args); return { rows: linha ? [linha] : [] }; } }) },
    './configuracao.ts': { ambienteAtendimento: () => ambiente },
    './arquivos.ts': arquivos,
    'node:crypto': nodeCrypto,
  }).modulo as typeof import('./arquivos-publico.ts');
  return { modulo, consultas };
}
const linha = { token: TOKEN, mime: 'application/pdf', nome: 'tabela.pdf', tamanho_bytes: PDF.length, sha256: 'f'.repeat(64), conteudo: PDF };

test('arquivo público: id + token do ambiente; token errado ou fora do formato é "não encontrado" sem consulta extra', async () => {
  const ok = carregar(linha);
  assert.equal((await ok.modulo.lerArquivoPublico(ID, TOKEN))?.nome, 'tabela.pdf');
  assert.deepEqual(ok.consultas[0], [ID, 'staging']);
  assert.equal(await carregar(linha).modulo.lerArquivoPublico(ID, 'B'.repeat(43)), null);
  const fora = carregar(linha);
  assert.equal(await fora.modulo.lerArquivoPublico(ID, 'curto'), null);
  assert.equal(await fora.modulo.lerArquivoPublico('nao-uuid', TOKEN), null);
  assert.equal(fora.consultas.length, 0, 'formato inválido não chega ao banco');
});

test('resposta: inteira ou por intervalo, sem execução no navegador; intervalo impossível 416; ausente 404', async () => {
  const { modulo } = carregar(linha);
  const a = (await modulo.lerArquivoPublico(ID, TOKEN))!;
  const inteira = modulo.respostaArquivo(a, null, false);
  assert.equal(inteira.status, 200);
  assert.equal(inteira.headers.get('content-type'), 'application/pdf');
  assert.equal(inteira.headers.get('x-content-type-options'), 'nosniff');
  assert.match(inteira.headers.get('content-security-policy')!, /sandbox/);
  assert.equal(Buffer.from(await inteira.arrayBuffer()).toString(), PDF.toString());
  const parte = modulo.respostaArquivo(a, 'bytes=0-3', false);
  assert.equal(parte.status, 206);
  assert.equal(parte.headers.get('content-range'), `bytes 0-3/${PDF.length}`);
  assert.equal(Buffer.from(await parte.arrayBuffer()).toString(), '%PDF');
  assert.equal(modulo.respostaArquivo(a, `bytes=${PDF.length + 5}-`, false).status, 416);
  const head = modulo.respostaArquivo(a, null, true);
  assert.equal(head.headers.get('content-length'), String(PDF.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(modulo.respostaArquivo(null, null, false).status, 404);
});
