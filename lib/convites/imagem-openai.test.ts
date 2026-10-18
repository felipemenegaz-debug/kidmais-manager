import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { gerarImagem, iaConfigurada, modeloImagem, MODELO_OPENAI, FalhaProvedorImagem } from './imagem.ts';

// Configuração sintética explícita, passada a cada chamada: os testes não leem nem alteram process.env, e o
// resultado independe das variáveis do serviço onde o build roda (ex.: CONVITES_OPENAI_API_KEY ou provedor real).
const ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test', CONVITES_IA_PROVIDER: 'openai', CONVITES_IA_ENABLED: 'true', CONVITES_IA_TETO_DIARIO_MICROUSD: '300000', OPENAI_API_KEY: 'CHAVE_SINTETICA' };
test('OpenAI reutiliza a chave do servidor e falha fechado para provedor desconhecido', async () => {
  assert.equal(iaConfigurada(ENV), true); assert.equal(modeloImagem(ENV), MODELO_OPENAI);
  const semChave: NodeJS.ProcessEnv = { ...ENV, OPENAI_API_KEY: undefined }; assert.equal(iaConfigurada(semChave), false);
  const chaveSeparada: NodeJS.ProcessEnv = { ...semChave, CONVITES_OPENAI_API_KEY: 'CHAVE_SEPARADA' }; assert.equal(iaConfigurada(chaveSeparada), true);
  const invalido: NodeJS.ProcessEnv = { ...chaveSeparada, CONVITES_IA_PROVIDER: 'invalido' }; assert.equal(iaConfigurada(invalido), false);
  let chamadas = 0;
  await assert.rejects(gerarImagem('Espaço', [], async () => { chamadas++; return new Response(); }, invalido));
  assert.equal(chamadas, 0);
});
test('geração OpenAI fixa modelo/custo, retorna imagem normalizada e uso sem revised_prompt', async () => {
  const bytes = await sharp({ create: { width: 768, height: 1024, channels: 3, background: '#334488' } }).webp().toBuffer();
  let chamadas = 0;
  const r = await gerarImagem('Astronauta, azul e roxo', [], async (url, init) => {
    chamadas++; assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer CHAVE_SINTETICA');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, MODELO_OPENAI); assert.equal(body.n, 1);
    assert.equal(body.quality, 'medium'); assert.equal(body.size, '768x1024'); assert.equal(body.output_format, 'webp');
    assert.match(body.prompt, /nem invente dados/); assert.equal(body.response_format, undefined);
    return Response.json({ data: [{ b64_json: bytes.toString('base64'), revised_prompt: 'não persistir' }], usage: { output_tokens: 10 } });
  }, ENV);
  assert.equal(chamadas, 1); assert.equal((await sharp(r.imagem).metadata()).format, 'webp');
  assert.deepEqual(r.uso, { output_tokens: 10 }); assert.equal('revised_prompt' in r, false);
});
test('referências são enviadas como multipart à edição, sem forçar Content-Type', async () => {
  await assert.rejects(gerarImagem('Jardim', [Buffer.from('ref')], async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal((init?.headers as Record<string, string>)['Content-Type'], undefined);
    const form = init?.body as FormData; assert.equal(form.get('model'), MODELO_OPENAI);
    assert.equal(form.getAll('image[]').length, 1); assert.equal((form.get('image[]') as Blob).type, 'image/webp');
    return new Response('{}', { status: 403 });
  }, ENV), e => e instanceof FalhaProvedorImagem && e.diagnostico === 'http_403');
});
test('erros, timeout e respostas ambíguas nunca causam retry ou fallback ao Gemini', async () => {
  for (const status of [401, 429, 500]) {
    let chamadas = 0;
    await assert.rejects(gerarImagem('Jardim', [], async () => { chamadas++; return new Response('segredo do fornecedor', { status }); }, ENV), e => e instanceof FalhaProvedorImagem && e.diagnostico === `http_${status}` && !e.message.includes('segredo'));
    assert.equal(chamadas, 1);
  }
  await assert.rejects(gerarImagem('Jardim', [], async () => { throw new Error('segredo'); }, ENV), e => e instanceof FalhaProvedorImagem && e.diagnostico === 'rede_ou_timeout');
  for (const data of [[], [{ url: 'https://externo.example/imagem' }], [{ b64_json: 'AA' }, { b64_json: 'BB' }]]) {
    await assert.rejects(gerarImagem('Jardim', [], async () => Response.json({ data }), ENV), e => e instanceof FalhaProvedorImagem && e.diagnostico === 'resposta_sem_imagem_unica');
  }
  await assert.rejects(gerarImagem('Jardim', [], async () => new Response('não json'), ENV), e => e instanceof FalhaProvedorImagem && e.diagnostico === 'resposta_json_invalida');
});
test('erro OpenAI expõe somente códigos conhecidos, nunca mensagem ou parâmetro livre', async () => {
  const env = { NODE_ENV:'test' as const, OPENAI_API_KEY:'SINTETICA', CONVITES_IA_PROVIDER:'openai', CONVITES_IA_ENABLED:'true', CONVITES_IA_TETO_DIARIO_MICROUSD:'300000' };
  for (const [error, esperado] of [
    [{code:'moderation_blocked',message:'DADO_PRIVADO'},'http_400_moderation_blocked'],
    [{type:'invalid_request_error',param:'quality',message:'DADO_PRIVADO'},'http_400_pedido_invalido_quality'],
    [{type:'invalid_request_error',param:'DADO_PRIVADO',message:'DADO_PRIVADO'},'http_400_pedido_invalido'],
    [{code:'DADO_PRIVADO',message:'DADO_PRIVADO'},'http_400'],
  ] as const) {
    let calls=0;
    await assert.rejects(gerarImagem('Jardim',[],async () => { calls++; return Response.json({error},{status:400}); },env), e => e instanceof FalhaProvedorImagem && e.diagnostico === esperado && !JSON.stringify(e).includes('DADO_PRIVADO'));
    assert.equal(calls,1);
  }
});

test('recusa preserva request ID e metadados públicos, descartando conteúdo livre sem retry', async () => {
  const env = { NODE_ENV:'test' as const, OPENAI_API_KEY:'SINTETICA', CONVITES_IA_PROVIDER:'openai', CONVITES_IA_ENABLED:'true', CONVITES_IA_TETO_DIARIO_MICROUSD:'300000' };
  let calls = 0;
  await assert.rejects(gerarImagem('Jardim',[],async () => {
    calls++;
    return Response.json({error:{code:'moderation_blocked',message:'PRIVADO',moderation_details:{moderation_stage:'output',categories:['violence','PRIVADO','violence'],scores:'PRIVADO'}}},{status:400,headers:{'x-request-id':'req_test_123'}});
  },env), e => {
    assert(e instanceof FalhaProvedorImagem);
    assert.deepEqual(e.detalhes,{requestId:'req_test_123',etapa:'output',categorias:['violence']});
    assert(!JSON.stringify(e).includes('PRIVADO')); return true;
  });
  assert.equal(calls,1);
  await assert.rejects(gerarImagem('Jardim',[],async () => Response.json({error:{code:'moderation_blocked',moderation_details:{moderation_stage:'PRIVADO',categories:['PRIVADO']}}},{status:400,headers:{'x-request-id':'PRIVADO'}}),env), e => e instanceof FalhaProvedorImagem && !JSON.stringify(e).includes('PRIVADO'));
});
