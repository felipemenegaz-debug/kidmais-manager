import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { armazenarConviteCompleto, completoDisponivel, gerarConviteCompletoOpenAI, MODELO_COMPLETO, QUALIDADE_COMPLETO } from './imagem.ts';

const ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test', CONVITES_IA_PROVIDER: 'openai', CONVITES_IA_ENABLED: 'true', CONVITES_IA_TETO_DIARIO_MICROUSD: '3000000', OPENAI_API_KEY: 'SINTETICA' };
const png = (w = 1024, h = 1536) => sharp({ create: { width: w, height: h, channels: 3, background: '#113355' } }).png().toBuffer();

test('convite completo: disponível só com OpenAI configurado no servidor, sem trocar de provedor', async () => {
  assert.equal(completoDisponivel(ENV), true);
  const recusados: NodeJS.ProcessEnv[] = [{ ...ENV, CONVITES_IA_PROVIDER: 'gemini', CONVITES_GEMINI_API_KEY: 'X' }, { ...ENV, CONVITES_IA_PROVIDER: undefined }, { ...ENV, CONVITES_IA_ENABLED: 'false' }, { ...ENV, OPENAI_API_KEY: '' }, { ...ENV, CONVITES_LAB_APIS_ENABLED: 'true', CONVITES_IA_PROVIDER: 'gemini' }];
  for (const env of recusados) {
    assert.equal(completoDisponivel(env), false);
    let chamadas = 0;
    await assert.rejects(gerarConviteCompletoOpenAI('Convite azul', async () => { chamadas++; return Response.json({}); }, env), /não está disponível/);
    assert.equal(chamadas, 0);
  }
});

test('convite completo: uma chamada edits com foto → referência e parâmetros oficiais fixos pelo servidor', async () => {
  const foto = Buffer.from('foto'), referencia = Buffer.from('referencia');
  const saida = await png();
  let chamadas = 0;
  const r = await gerarConviteCompletoOpenAI('Prompt completo', async (url, init) => {
    chamadas++;
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    const body = init?.body as FormData;
    assert.equal(body.get('model'), MODELO_COMPLETO); assert.equal(MODELO_COMPLETO, 'gpt-image-2.5-sunburst');
    assert.equal(body.get('quality'), QUALIDADE_COMPLETO); assert.equal(QUALIDADE_COMPLETO, 'xhigh');
    assert.equal(body.get('size'), '1024x1536'); assert.equal(body.get('output_format'), 'png'); assert.equal(body.get('background'), 'opaque'); assert.equal(body.get('n'), '1');
    assert.equal(body.get('prompt'), 'Prompt completo');
    for (const nome of ['input_fidelity', 'negative_prompt', 'style', 'seed']) assert.equal(body.has(nome), false);
    const refs = body.getAll('image[]') as Blob[];
    assert.deepEqual(Buffer.from(await refs[0].arrayBuffer()), foto);
    assert.deepEqual(Buffer.from(await refs[1].arrayBuffer()), referencia);
    return Response.json({ data: [{ b64_json: saida.toString('base64') }], usage: { output_tokens: 9 } });
  }, ENV, QUALIDADE_COMPLETO, [foto, referencia]);
  assert.equal(chamadas, 1); assert.equal(r.uso.output_tokens, 9);
  const meta = await sharp(r.imagem).metadata();
  assert.equal(meta.width, 1024); assert.equal(meta.height, 1536);
});

test('convite completo: sem foto usa generations; erros falham uma vez, sem retry nem fallback', async () => {
  const saida = await png();
  let chamadas = 0;
  await gerarConviteCompletoOpenAI('Prompt', async (url, init) => {
    chamadas++; assert.equal(url, 'https://api.openai.com/v1/images/generations');
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, MODELO_COMPLETO); assert.equal(body.image, undefined);
    return Response.json({ data: [{ b64_json: saida.toString('base64') }] });
  }, ENV);
  assert.equal(chamadas, 1);
  for (const responder of [() => new Response('x', { status: 500 }), () => Response.json({ error: { code: 'moderation_blocked' } }, { status: 400 }), () => { throw new TypeError('rede'); }, () => Response.json({ data: [] })]) {
    let n = 0;
    await assert.rejects(gerarConviteCompletoOpenAI('Prompt', async () => { n++; return responder(); }, ENV), (e: { diagnostico?: string }) => !!e.diagnostico);
    assert.equal(n, 1);
  }
  let n = 0;
  await assert.rejects(gerarConviteCompletoOpenAI('Prompt', async () => { n++; return Response.json({}); }, ENV, 'xhigh', [Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1)]), /duas referências/);
  await assert.rejects(gerarConviteCompletoOpenAI('Prompt', async () => { n++; return Response.json({}); }, ENV, 'ultra'), /Qualidade inválida/);
  assert.equal(n, 0);
});

test('convite completo: armazenamento WebP cabe na coluna de 1,5 MB sem recortar nem reduzir', async () => {
  // Ruído aleatório é o pior caso de compressão para 1024×1536.
  const ruido = Buffer.alloc(1024 * 1536 * 3); for (let i = 0; i < ruido.length; i++) ruido[i] = (i * 2654435761) >>> 24;
  for (const origem of [await png(), await sharp(ruido, { raw: { width: 1024, height: 1536, channels: 3 } }).png().toBuffer(), await png(768, 1024)]) {
    const webp = await armazenarConviteCompleto(origem);
    const [a, b] = [await sharp(origem).metadata(), await sharp(webp).metadata()];
    assert.equal(b.format, 'webp'); assert.equal(b.width, a.width); assert.equal(b.height, a.height);
    assert.ok(webp.length <= 1_500_000, `${webp.length}`);
  }
});
