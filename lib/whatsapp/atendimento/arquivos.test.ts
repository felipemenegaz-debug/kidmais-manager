import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caminhoPublicoArquivo, detectarFormato, intervaloPedido, LIMITE_ARQUIVO, nomeArquivoSeguro, urlPublicaArquivo, validarArquivo } from './arquivos.ts';

const bytes = (...partes: Array<number[] | string>) => new Uint8Array(partes.flatMap((p) => (typeof p === 'string' ? Array.from(Buffer.from(p, 'latin1')) : p)));
const JPG = bytes([0xff, 0xd8, 0xff, 0xe0], 'resto');
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR');
const PDF = bytes('%PDF-1.4\n1 0 obj\n%%EOF\n');
const MP4 = bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0]);
const GP3 = bytes([0, 0, 0, 0x18], 'ftyp3gp4', [0, 0, 2, 0]);

test('formato vem dos primeiros bytes, não da extensão', () => {
  assert.deepEqual(detectarFormato(JPG), { tipo: 'IMAGEM', mime: 'image/jpeg', extensao: 'jpg' });
  assert.deepEqual(detectarFormato(PNG), { tipo: 'IMAGEM', mime: 'image/png', extensao: 'png' });
  assert.deepEqual(detectarFormato(PDF), { tipo: 'DOCUMENTO', mime: 'application/pdf', extensao: 'pdf' });
  assert.deepEqual(detectarFormato(MP4), { tipo: 'VIDEO', mime: 'video/mp4', extensao: 'mp4' });
  assert.deepEqual(detectarFormato(GP3), { tipo: 'VIDEO', mime: 'video/3gpp', extensao: '3gp' });
  assert.equal(detectarFormato(bytes('%PDF-1.4 sem final')), null, 'PDF truncado (sem %%EOF) é recusado');
  assert.equal(detectarFormato(bytes('GIF89a')), null);
  assert.equal(detectarFormato(bytes('<html><script>')), null);
  assert.equal(detectarFormato(bytes([0, 0, 0, 0x18], 'ftypqt  ')), null, 'QuickTime não é aceito');
});

test('validação: vazio, formato, tipo esperado e tamanho por tipo', () => {
  assert.throws(() => validarArquivo('a.pdf', new Uint8Array()), { message: 'ARQUIVO_VAZIO' });
  assert.throws(() => validarArquivo('foto.jpg', bytes('<svg>')), { message: 'ARQUIVO_FORMATO_NAO_ACEITO' });
  assert.throws(() => validarArquivo('tabela.pdf', JPG, 'DOCUMENTO'), { message: 'ARQUIVO_TIPO_DIFERENTE' });
  const grande = new Uint8Array(LIMITE_ARQUIVO.IMAGEM + 1); grande.set([0xff, 0xd8, 0xff]);
  assert.throws(() => validarArquivo('x.jpg', grande), { message: 'ARQUIVO_GRANDE_DEMAIS' });
  const v = validarArquivo('C:\\fotos\\Salgados da festa.JPEG', JPG, 'IMAGEM');
  assert.equal(v.nome, 'Salgados da festa.jpg', 'pasta removida e extensão real');
  assert.equal(v.tamanho, JPG.length);
});

test('nome seguro: sem controle, sem caracteres de caminho, até 240 com extensão', () => {
  assert.equal(nomeArquivoSeguro('../../etc/passwd', 'pdf'), 'passwd.pdf');
  assert.equal(nomeArquivoSeguro('ta\u0000be\u202ela "preços".exe', 'pdf'), 'ta be la preços.pdf', 'extensão falsa trocada pela real');
  assert.equal(nomeArquivoSeguro('', 'png'), 'arquivo.png');
  const longo = nomeArquivoSeguro('a'.repeat(500), 'pdf');
  assert.equal(longo.length, 240);
  assert.ok(longo.endsWith('.pdf'));
});

test('URL pública só com origem https; caminho termina na extensão', () => {
  const id = '11111111-2222-4333-8444-555555555555', token = 'A'.repeat(43);
  assert.equal(caminhoPublicoArquivo(id, token, 'Tabela 2027.pdf'), `/api/publico/atendimento/arquivos/${id}/${token}/Tabela%202027.pdf`);
  assert.equal(urlPublicaArquivo('https://kidmais.exemplo.test/admin', id, token, 'a.pdf'), `https://kidmais.exemplo.test/api/publico/atendimento/arquivos/${id}/${token}/a.pdf`);
  for (const o of [undefined, 'http://localhost:3070', 'https://localhost', 'https://user:x@kidmais.test', 'nada']) assert.equal(urlPublicaArquivo(o, id, token, 'a.pdf'), null, String(o));
});

test('intervalo (Range) para vídeo', () => {
  assert.equal(intervaloPedido(null, 100), null);
  assert.deepEqual(intervaloPedido('bytes=0-9', 100), { inicio: 0, fim: 9 });
  assert.deepEqual(intervaloPedido('bytes=90-', 100), { inicio: 90, fim: 99 });
  assert.deepEqual(intervaloPedido('bytes=-10', 100), { inicio: 90, fim: 99 });
  assert.deepEqual(intervaloPedido('bytes=0-999', 100), { inicio: 0, fim: 99 });
  assert.equal(intervaloPedido('bytes=100-', 100), 'INVALIDO');
  assert.equal(intervaloPedido('bytes=5-1', 100), 'INVALIDO');
  assert.equal(intervaloPedido('bytes=0-1,5-6', 100), null, 'múltiplos intervalos: resposta inteira');
});
