import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { extrairImagem, gerarImagem, normalizarImagem } from './imagem.ts';
test('upload reencoda imagem, remove metadados e limita dimensões', async () => {
  const input = await sharp({ create: { width: 1800, height: 800, channels: 3, background: '#aa7766' } }).png().toBuffer();
  const b = await normalizarImagem(`data:image/png;base64,${input.toString('base64')}`);
  const meta = await sharp(b).metadata(); assert.equal(meta.format, 'webp'); assert.equal(meta.width, 1400); assert.equal(meta.exif, undefined);
});
test('recusa SVG ativo, arquivo inválido e payload excessivo', async () => {
  for (const s of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,aGVsbG8=', 'x'.repeat(7_000_001)]) await assert.rejects(normalizarImagem(s));
});
test('extrai apenas a imagem final; ignora imagens de raciocínio', () => {
  assert.equal(extrairImagem({ steps: [{ type: 'thought', content: [{ type: 'image', data: 'AAAA', mime_type: 'image/png' }] }, { type: 'model_output', content: [{ type: 'image', data: 'BBBB', mime_type: 'image/webp' }] }] }), 'data:image/webp;base64,BBBB');
  assert.throws(() => extrairImagem({ steps: [{ type: 'model_output', content: [{ type: 'text' }] }] }));
});
test('adaptador usa origem fixa, chave no cabeçalho, limites fixos e não tenta novamente', async () => {
  const env = { ...process.env }; let chamadas = 0;
  process.env.CONVITES_IA_ENABLED = 'true'; process.env.CONVITES_GEMINI_API_KEY = 'CHAVE_SINTETICA'; process.env.CONVITES_IA_TETO_DIARIO_MICROUSD = '300000';
  try {
    await assert.rejects(gerarImagem('Um jardim', [], async (url, init) => {
      chamadas++; assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
      const b = JSON.parse(String(init?.body)); assert.equal(b.store, false); assert.equal(b.response_format.image_size, '1K'); assert.equal(b.generation_config.max_output_tokens, 4096);
      return new Response('{}', { status: 503 });
    }));
    assert.equal(chamadas, 1);
  } finally { for (const k of ['CONVITES_IA_ENABLED', 'CONVITES_GEMINI_API_KEY', 'CONVITES_IA_TETO_DIARIO_MICROUSD']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } }
});
