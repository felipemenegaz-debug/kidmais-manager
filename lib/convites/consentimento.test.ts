import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { conteudoCanonicoIA, MEIOS_DO_BUFFET, PROVEDORES_IA, textosAutorizacaoIA, VERSAO_TEXTOS_IA } from './consentimento-textos.ts';
import { hashTextoIA, textosParaTela } from './consentimento.ts';
import { destinoDoProvedor, gerarImagem, HOST_PROVEDOR, provedorImagem } from './imagem.ts';

// Configuração sintética explícita: os testes não leem process.env nem abrem rede.
const env = (provedor: string): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', CONVITES_IA_PROVIDER: provedor, CONVITES_IA_ENABLED: 'true', CONVITES_IA_TETO_DIARIO_MICROUSD: '300000',
  OPENAI_API_KEY: 'CHAVE_SINTETICA', CONVITES_GEMINI_API_KEY: 'CHAVE_SINTETICA' });

test('aviso da Astra com o nome do provedor real; consentimento e foto separados, sem documento', () => {
  const openai = textosAutorizacaoIA('openai', 'CLIENTE'), gemini = textosAutorizacaoIA('gemini', 'CLIENTE');
  assert.equal(openai.aviso, 'Para criar este convite com IA, enviaremos à OpenAI os dados selecionados da festa, que podem incluir nome e idade da criança e informações do evento. A fotografia só será enviada se você autorizar separadamente. A imagem gerada será armazenada no Kidmais e poderá conter esses dados. Consulte as condições de tratamento e retenção antes de continuar.');
  assert.match(gemini.aviso, /^Para criar este convite com IA, enviaremos ao Google \(Gemini\) os dados/);
  assert.doesNotMatch(gemini.aviso + gemini.foto, /OpenAI/); assert.doesNotMatch(openai.aviso + openai.foto, /Gemini/);
  assert.equal(openai.consentimento, 'Declaro ser responsável legal pela criança e autorizo especificamente o uso dos dados selecionados para gerar este convite por IA, nas condições informadas. Sei que posso escolher uma alternativa sem IA e revogar esta autorização para usos futuros.');
  assert.equal(openai.foto, 'Autorizo também o envio desta fotografia ao provedor indicado (OpenAI) para gerar a arte.');
  const buffet = textosAutorizacaoIA('openai', 'BUFFET');
  assert.match(buffet.consentimento, /^Registro que o responsável legal identificado abaixo declarou ser responsável pela criança/);
  assert.match(buffet.foto, /\(OpenAI\)/);
  assert.ok(!(MEIOS_DO_BUFFET as readonly string[]).includes('PROPRIO_RESPONSAVEL'));
  for (const t of [openai, buffet]) assert.doesNotMatch(JSON.stringify(t), /documento|CPF|RG/i);
  assert.throws(() => textosAutorizacaoIA('deepseek' as never, 'CLIENTE'));
  assert.deepEqual(Object.keys(PROVEDORES_IA), ['openai', 'gemini']);
});

test('hash do texto exibido: sha-256 do conteúdo canônico; muda com provedor, operador, foto e versão', () => {
  const t = textosAutorizacaoIA('openai', 'CLIENTE');
  assert.equal(hashTextoIA('openai', 'CLIENTE', false), createHash('sha256').update(conteudoCanonicoIA(t, false)).digest('hex'));
  const hashes = new Set([hashTextoIA('openai', 'CLIENTE', false), hashTextoIA('openai', 'CLIENTE', true), hashTextoIA('gemini', 'CLIENTE', false), hashTextoIA('openai', 'BUFFET', false)]);
  assert.equal(hashes.size, 4);
  assert.notEqual(conteudoCanonicoIA({ ...t, versao: 'outra' }, false), conteudoCanonicoIA(t, false));
  const tela = textosParaTela('gemini', 'BUFFET');
  assert.equal(tela.versao, VERSAO_TEXTOS_IA); assert.equal(tela.provedorNome, 'Google (Gemini)');
  assert.deepEqual(tela.hashes, { semFoto: hashTextoIA('gemini', 'BUFFET', false), comFoto: hashTextoIA('gemini', 'BUFFET', true) });
});

test('destino: cada provedor só aceita o próprio host; nenhum fallback entre provedores', async () => {
  assert.ok(destinoDoProvedor('openai', 'https://api.openai.com/v1/images/edits'));
  assert.ok(destinoDoProvedor('gemini', 'https://generativelanguage.googleapis.com/v1beta/interactions'));
  assert.ok(!destinoDoProvedor('openai', 'https://generativelanguage.googleapis.com/v1beta/interactions'));
  assert.ok(!destinoDoProvedor('gemini', 'https://api.openai.com/v1/images/generations'));
  assert.ok(!destinoDoProvedor('openai', 'https://api.openai.com.exemplo.test/'));
  assert.ok(!destinoDoProvedor('deepseek', 'https://api.deepseek.com/'));
  assert.deepEqual(Object.keys(HOST_PROVEDOR), ['openai', 'gemini']);
  // Configuração mudou para Gemini depois da autorização para a OpenAI: recusa antes de montar o pedido.
  let chamadas = 0;
  await assert.rejects(gerarImagem('Jardim', [], async () => { chamadas++; return new Response(); }, env('gemini'), 'openai'), /provedor de IA mudou/);
  await assert.rejects(gerarImagem('Jardim', [], async () => { chamadas++; return new Response(); }, env('openai'), 'gemini'), /provedor de IA mudou/);
  assert.equal(chamadas, 0);
  // Falha do provedor autorizado: uma chamada, ao próprio host, e o erro sobe (sem tentar o outro provedor).
  for (const provedor of ['openai', 'gemini']) {
    const urls: string[] = [];
    await assert.rejects(gerarImagem('Jardim', [], async (url) => { urls.push(String(url)); return new Response('{}', { status: 503 }); }, env(provedor), provedor),
      (e: { diagnostico?: string }) => e.diagnostico === 'http_503');
    assert.equal(urls.length, 1); assert.ok(destinoDoProvedor(provedor, urls[0]), urls[0]);
    assert.equal(provedorImagem(env(provedor)), provedor);
  }
});
