// Fatia 7 (Wall-e): a pergunta que nenhuma fonte respondeu (passagem INFORMACAO_INDISPONIVEL) vira resposta aprovada pelo
// caminho da tela: o texto gravado na passagem (trechoParaRegistro) → perguntaSugerida (máscara de novo) → a pessoa
// escreve a resposta → configuração salva. Depois disso, a mesma pergunta e variações (holdout sintético escrito para
// esta fatia, que não entra em nenhum ajuste das regras) são respondidas com a resposta aprovada, sem passagem.
// Caminho real da conversa simulado sem banco e sem rede, como em regressao-holdouts.test.mjs.
//   node --experimental-strip-types --test scripts/walle-avaliacao/sem-fonte-holdout.test.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { AGORA, CATALOGOS, CONFIG, FONTES } from './fixture.mjs';
import { simularSequencia } from './simulacao.mjs';

register('./alias-hooks.mjs', import.meta.url);
globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };
const imp = (rel) => import(new URL(`../../${rel}`, import.meta.url).href);

async function modulos() {
  const [ent, res, core, ctx, worker, modelo, texto] = await Promise.all([
    imp('lib/whatsapp/atendimento/walle/entendimento.ts'), imp('lib/whatsapp/atendimento/walle/resolver.ts'), imp('lib/whatsapp/atendimento/core.ts'),
    imp('lib/whatsapp/atendimento/walle/contexto.ts'), imp('lib/whatsapp/atendimento/worker.ts'), imp('app/api/admin/inteligencia/whatsapp/modelo.ts'),
    imp('lib/whatsapp/atendimento/sem-fonte-texto.ts'),
  ]);
  const m = { entenderPorRegras: ent.entenderPorRegras, revalidarEntendimento: ent.revalidarEntendimento, juntarSinais: ent.juntarSinais, resolverWallE: res.resolverWallE, comandoDireto: core.comandoDireto, pausaPedidaNaRecepcao: core.pausaPedidaNaRecepcao ?? null, lerContexto: ctx.lerContexto, mensagemAindaValida: worker.mensagemAindaValida, sinaisJev: modelo.sinaisJev, registroDoBloqueio: ent.registroDoBloqueio ?? null };
  return { m, ent, res, core, texto };
}
const item = (id, texto) => ({ id, texto, intencoes: ['DUVIDA'], decisao: 'RESPONDER', entidades: {} });

// Perguntas sem fonte na empresa sintética, cada uma com variações escritas como clientes escrevem.
const CASOS = [
  { id: 'fraldario', pergunta: 'Vocês têm fraldário no salão?', resposta: 'Resposta aprovada sintética: temos fraldário no banheiro feminino e no masculino.',
    variacoes: ['tem fraldario?', 'O espaço tem fraldário pra trocar o bebê?', 'boa tarde! no salão de vcs tem fraldário?'] },
  { id: 'wifi', pergunta: 'O salão tem wi-fi para os convidados?', resposta: 'Resposta aprovada sintética: temos wi-fi liberado para os convidados.',
    variacoes: ['tem wifi pros convidados?', 'Tem wi-fi no salão?', 'os convidados podem usar o wi-fi do salão?'] },
];

test('fatia 7: pergunta sem fonte passa para a equipe, vira resposta aprovada mascarada e depois é respondida pelo Wall-e', { timeout: 120_000 }, async () => {
  const { m, ent, res, core, texto } = await modulos();
  const entender = (catalogos) => (t, contexto) => ent.entenderPorRegras(t, catalogos, contexto);
  for (const caso of CASOS) {
    // 1) Antes: sem fonte → equipe com INFORMACAO_INDISPONIVEL, e a passagem guarda só o trecho mascarado.
    const comDados = `Oi, aqui é a Fulana Teste, meu número é 11987654321 e meu e-mail fulana@exemplo.com. ${caso.pergunta}`;
    const entendimento = ent.entenderPorRegras(comDados, CATALOGOS, {});
    const r = await res.resolverWallE({ texto: comDados, entendimento, contexto: {}, config: CONFIG, catalogos: CATALOGOS, agora: AGORA }, FONTES);
    assert.ok(r.passagem?.motivos.includes('INFORMACAO_INDISPONIVEL'), `${caso.id}: ${JSON.stringify(r.passagem?.motivos)}`);
    const sugerida = texto.perguntaSugerida(r.passagem.ultimaMensagem);
    assert.ok(sugerida, caso.id);
    assert.ok(!/1198765|fulana@|exemplo\.com/i.test(sugerida), `${caso.id}: dado à mostra: ${sugerida}`);
    assert.equal(texto.perguntaComDadoPessoal(sugerida), true, `${caso.id}: a pessoa precisa revisar o texto com marcador`);
    // 2) A mensagem só com a pergunta: o pré-preenchimento sai limpo e é aceito como está.
    const [antes] = await simularSequencia(m, [item(`${caso.id}-antes`, caso.pergunta)], { catalogos: CATALOGOS, config: CONFIG, fontes: FONTES, agora: AGORA, entender: entender(CATALOGOS) });
    assert.equal(antes.decisao, 'EQUIPE', `${caso.id}: ${antes.decisao} ${antes.motivos}`);
    assert.ok(antes.motivos.includes('INFORMACAO_INDISPONIVEL'), `${caso.id}: ${antes.motivos}`);
    const r2 = await res.resolverWallE({ texto: caso.pergunta, entendimento: ent.entenderPorRegras(caso.pergunta, CATALOGOS, {}), contexto: {}, config: CONFIG, catalogos: CATALOGOS, agora: AGORA }, FONTES);
    const prefill = texto.perguntaSugerida(r2.passagem.ultimaMensagem);
    assert.equal(prefill, caso.pergunta);
    assert.equal(texto.perguntaComDadoPessoal(prefill), false);
    // 3) A pessoa escreve a resposta e salva (mesmo schema da configuração, limite de 30).
    const nova = { id: `faq_${caso.id}`, pergunta: prefill, resposta: caso.resposta };
    const config = core.configuracaoSchema.parse({ ...CONFIG, perguntas: [...CONFIG.perguntas, nova] });
    const catalogos = { ...CATALOGOS, perguntas: config.perguntas };
    // 4) Depois: a pergunta e as variações são respondidas com a resposta aprovada, sem passar para a equipe.
    for (const [i, t] of [caso.pergunta, ...caso.variacoes].entries()) {
      const [depois] = await simularSequencia(m, [item(`${caso.id}-${i}`, t)], { catalogos, config, fontes: FONTES, agora: AGORA, entender: entender(catalogos) });
      assert.equal(depois.decisao, 'RESPONDER', `${caso.id} "${t}": ${depois.decisao} ${depois.motivos} ${depois.resposta}`);
      assert.ok(depois.resposta.includes(caso.resposta), `${caso.id} "${t}": ${depois.resposta}`);
      assert.ok(!depois.motivos.includes('INFORMACAO_INDISPONIVEL'));
    }
  }
});

test('fatia 7: a resposta aprovada nova não captura perguntas de outros assuntos', { timeout: 120_000 }, async () => {
  const { m, ent, core } = await modulos();
  const novas = CASOS.map((c) => ({ id: `faq_${c.id}`, pergunta: c.pergunta, resposta: c.resposta }));
  const config = core.configuracaoSchema.parse({ ...CONFIG, perguntas: [...CONFIG.perguntas, ...novas] });
  const catalogos = { ...CATALOGOS, perguntas: config.perguntas };
  for (const t of ['Vocês têm estacionamento?', 'Pode levar pula-pula próprio?', 'Qual é o horário de atendimento?']) {
    const [l] = await simularSequencia(m, [item('outro', t)], { catalogos, config, fontes: FONTES, agora: AGORA, entender: (x, c) => ent.entenderPorRegras(x, catalogos, c) });
    for (const c of CASOS) assert.ok(!l.resposta.includes(c.resposta), `"${t}" respondeu com ${c.id}: ${l.resposta}`);
  }
});
