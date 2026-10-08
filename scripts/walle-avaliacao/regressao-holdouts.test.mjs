// Regressão do Wall-e com os HOLDOUTS JÁ ANALISADOS (1: 70 mensagens; 2 a 19: 80 mensagens cada, de 05 e 06/10/2026, escritas
// sem acesso ao código). Depois de usados nas correções, deixaram de medir e passaram a proteger. Caminho real da conversa
// simulado sem banco (recepção com PARAR, worker, Wall-e por regras + sinais do JEV pela composition root, como em
// produção), fontes sintéticas, rótulos revisados pelas fontes (rotulos-revisados.json), nenhuma rede. Fica aqui (e não
// em lib/) porque os sinais do JEV vêm da camada de IA, que o Core não importa. A medição nova é sempre um holdout novo.
//   node --experimental-strip-types --test scripts/walle-avaliacao/regressao-holdouts.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import { AGORA, CATALOGOS, CONFIG, FONTES } from './fixture.mjs';
import { calcularMetricas } from './metricas.mjs';
import { sequenciasDoCorpus, simularSequencia } from './simulacao.mjs';

register('./alias-hooks.mjs', import.meta.url);
globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };
const imp = (rel) => import(new URL(`../../${rel}`, import.meta.url).href);
const revisados = JSON.parse(readFileSync(new URL('./rotulos-revisados.json', import.meta.url), 'utf8'));

async function simular(arquivo) {
  const corpus = JSON.parse(readFileSync(new URL(`./${arquivo}`, import.meta.url), 'utf8'));
  const [ent, res, core, ctx, worker, modelo] = await Promise.all([
    imp('lib/whatsapp/atendimento/walle/entendimento.ts'), imp('lib/whatsapp/atendimento/walle/resolver.ts'), imp('lib/whatsapp/atendimento/core.ts'),
    imp('lib/whatsapp/atendimento/walle/contexto.ts'), imp('lib/whatsapp/atendimento/worker.ts'), imp('app/api/admin/inteligencia/whatsapp/modelo.ts'),
  ]);
  const m = { entenderPorRegras: ent.entenderPorRegras, revalidarEntendimento: ent.revalidarEntendimento, juntarSinais: ent.juntarSinais, resolverWallE: res.resolverWallE, comandoDireto: core.comandoDireto, lerContexto: ctx.lerContexto, mensagemAindaValida: worker.mensagemAindaValida, sinaisJev: modelo.sinaisJev, registroDoBloqueio: ent.registroDoBloqueio ?? null };
  const linhas = [];
  for (const seq of sequenciasDoCorpus(corpus.itens)) {
    linhas.push(...await simularSequencia(m, seq, { catalogos: CATALOGOS, config: CONFIG, fontes: FONTES, agora: AGORA, rotulos: revisados[arquivo] ?? {}, entender: (texto, contexto) => ent.entenderPorRegras(texto, CATALOGOS, contexto) }));
  }
  return linhas;
}

// Decisões que podem diferir do rótulo por desenho: mensagem que chega com a conversa já entregue (corretamente) à equipe,
// pedido de contratação em que o Wall-e coleta os dados antes de passar (fluxo mantido até a decisão do usuário) e pedido
// de parar misturado com outro pedido (rótulo PARAR_MISTO = equipe sem NENHUMA saída automática). Quando a frase de parar
// é inequívoca e o resto é desabafo ("Péssimo atendimento… Não me mandem mais nada.", holdout 9 k50), o bloqueio vale
// (rodadas 8 a 10 iguais): nada é enviado, que é o que a categoria crítica PARAR_MISTO exige. Rótulo original mantido.
const porDesenho = (l) => l.motivos.includes('COM_A_EQUIPE') || (l.esperado.intencoes.includes('CONTRATAR') && l.decisao === 'PERGUNTAR' && l.pendentePara === 'CONTRATAR')
  || (l.esperado.decisao === 'PARAR_MISTO' && ['EQUIPE', 'PARAR'].includes(l.decisao) && !l.saidas.length) || reperguntaHerdada(l);
// Pergunta pendente de um assunto ANTERIOR que volta uma vez depois de responder o assunto novo (desenho): a mensagem é
// respondida com a fonte do próprio assunto, mas a decisão fica PERGUNTAR (holdout 4, v78: decoração depois da v77).
function reperguntaHerdada(l) {
  return l.decisao === 'PERGUNTAR' && l.esperado.decisao === 'RESPONDER' && !!l.pendentePara && !l.esperado.intencoes.includes(l.pendentePara) && l.saidas.some((s) => s.fontes.length);
}
/**
 * Rodada 30: pendências NÃO críticas conhecidas e nomeadas (docs §4.32), que a regressão tolera até serem corrigidas;
 * as críticas nunca entram aqui. h30: aa20 (duas cláusulas certas, mais "parte não cadastrada"), aa50 ("fica em
 * novembro msm" não volta à data anterior), aa59 ("e se for no almoço?" não recalcula com a entrada dos convidados) e
 * aa61 (pergunta pendente repetida junto da cláusula 7).
 */
// Rodada 31, h31: aa41 (cláusula 7 certa + "parte não cadastrada"), aa45/aa69/aa70 (tema: "doido pelo X e pelo Y", "apaixonada pela X mas
// também adora a Y", "pensando bem vamos de X"), aa53 ("puxar mais uma horinha" à equipe) com aa54/aa55 em cascata, aa66
// (pergunta pendente repetida) e aa76 (horário de entrada no segundo horário sem fonte).
// Rodada 32, h32 (docs §4.35 da branch de ferramentas e §4.37): aa08 (horário de entrada no almoço sem fonte, junto do mapa
// certo), aa64 ("boleto já tiver vencido" à equipe com a cláusula 7 certa), aa67 (dois meses citados viram ambiguidade),
// aa68 (horário de entrada com a cláusula 8 e uma pergunta) e aa37/aa71/aa72 (tema: dois temas indecisos, "vamos de X").
// Rodada 33, h33 (docs §4.38 da branch de ferramentas e §4.39): aa46 ("se o boleto da parcela vencer" à equipe com a cláusula 7
// certa), aa67/aa77 (indecisão de tema sem "ou"), aa68 ("enfeitar a entrada do salão" sem fonte) com aa69 em cascata e aa78
// ("pensando bem, vai ser X" sem tema anotado).
// Rodada 34, h34 (docs §4.40 da branch de ferramentas e §4.41): aa51 (troca de tema + "vcs fazem?" + comparação de pacotes
// à equipe por uma parte sem fonte) e aa67/aa68 (tema: indecisão sem "ou", "na verdade acho que vai ser X"). O h32 aa64 e o
// h33 aa46 (dúvida geral de atraso) saíram da lista: corrigidos na rodada 34.
// Rodada 42: h40 entra com as pendências não críticas da medição da r39 (§4.49: aa05 "entrada do pessoal", aa09 atraso
// hipotético, aa55 "se o número de convidados aumentar" com aa56/aa57 em cascata, aa66 tabela já baixada); h41 entra sem
// pendências depois da correção da contratação por referência (aa54 e aa55).
// Rodada 35: saíram h31 aa45/aa76, h32 aa08/aa71/aa72 e h33 aa67 (indecisão de tema e horário de entrada, corrigidos nas
// rodadas 34–35); h35 aa67 ("na verdade, pensando bem, ela quer a X" sem tema anotado) entra.
const PENDENCIAS_NAO_CRITICAS = { 'corpus-holdout-40-20261008.json': ['aa05', 'aa09', 'aa55', 'aa56', 'aa57', 'aa66'], 'corpus-holdout-30-20261007.json': ['aa50', 'aa59', 'aa61'], 'corpus-holdout-31-20261007.json': ['aa41', 'aa53', 'aa54', 'aa55', 'aa66', 'aa69', 'aa70'], 'corpus-holdout-32-20261007.json': ['aa37', 'aa67', 'aa68'], 'corpus-holdout-33-20261007.json': ['aa68', 'aa69', 'aa77', 'aa78'], 'corpus-holdout-34-20261007.json': ['aa51', 'aa67', 'aa68'], 'corpus-holdout-39-20261008.json': ['aa46', 'aa61', 'aa68'] };

for (const [arquivo, total] of [['corpus-holdout-20261005.json', 70], ['corpus-holdout-2-20261005.json', 80], ['corpus-holdout-3-20261005.json', 80], ['corpus-holdout-4-20261005.json', 80], ['corpus-holdout-5-20261005.json', 80], ['corpus-holdout-6-20261005.json', 80], ['corpus-holdout-7-20261005.json', 80], ['corpus-holdout-8-20261005.json', 80], ['corpus-holdout-9-20261006.json', 80], ['corpus-holdout-10-20261006.json', 80], ['corpus-holdout-11-20261006.json', 80], ['corpus-holdout-12-20261006.json', 80], ['corpus-holdout-13-20261006.json', 80], ['corpus-holdout-14-20261006.json', 80], ['corpus-holdout-15-20261006.json', 80], ['corpus-holdout-16-20261006.json', 80], ['corpus-holdout-17-20261006.json', 80], ['corpus-holdout-18-20261006.json', 80], ['corpus-holdout-19-20261006.json', 80], ['corpus-holdout-20-20261007.json', 80], ['corpus-holdout-21-20261007.json', 80], ['corpus-holdout-22-20261007.json', 80], ['corpus-holdout-23-20261007.json', 80], ['corpus-holdout-24-20261007.json', 80], ['corpus-holdout-25-20261007.json', 80], ['corpus-holdout-26-20261007.json', 80], ['corpus-holdout-27-20261007.json', 80], ['corpus-holdout-28-20261007.json', 80], ['corpus-holdout-29-20261007.json', 80], ['corpus-holdout-30-20261007.json', 80], ['corpus-holdout-31-20261007.json', 80], ['corpus-holdout-32-20261007.json', 80], ['corpus-holdout-33-20261007.json', 80], ['corpus-holdout-34-20261007.json', 80], ['corpus-holdout-35-20261007.json', 80], ['corpus-holdout-36-20261007.json', 80], ['corpus-holdout-37-20261008.json', 80], ['corpus-holdout-38-20261008.json', 80], ['corpus-holdout-39-20261008.json', 80], ['corpus-holdout-40-20261008.json', 80], ['corpus-holdout-41-20261008.json', 80]]) {
  test(`${arquivo} (regressão): nenhuma falha crítica — PARAR bloqueia e silencia, alergia, contrato, reserva, pessoa e demais vão para a equipe`, async () => {
    const linhas = await simular(arquivo);
    assert.equal(linhas.length, total);
    const metricas = calcularMetricas(linhas);
    for (const c of metricas.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  });
  test(`${arquivo} (regressão): comercial com fonte oficial, sem passagem desnecessária; decisões iguais ao rótulo salvo por desenho`, async () => {
    const linhas = await simular(arquivo);
    const metricas = calcularMetricas(linhas);
    const pendente = (id) => (PENDENCIAS_NAO_CRITICAS[arquivo] ?? []).includes(id);
    assert.deepEqual(metricas.comercial.falhas.filter((f) => !pendente(f.id) && !reperguntaHerdada(linhas.find((l) => l.id === f.id))), []);
    assert.deepEqual(metricas.desnecessarios.filter((d) => !pendente(d.id)), []);
    assert.deepEqual(linhas.filter((l) => l.decisao !== l.esperado.decisao && !porDesenho(l) && !pendente(l.id)).map((l) => `${l.id}: ${l.esperado.decisao} → ${l.decisao}`), []);
    // As pendências registradas continuam pendentes: quando uma for corrigida, sai da lista (o teste avisa).
    for (const id of PENDENCIAS_NAO_CRITICAS[arquivo] ?? []) assert.ok(metricas.comercial.falhas.some((f) => f.id === id) || metricas.desnecessarios.some((d) => d.id === id), `pendência ${id} já corrigida: tirar da lista`);
  });
}

test('holdout 2 (regressão): PARAR natural no meio da conversa bloqueia e nada sai depois', async () => {
  const linhas = await simular('corpus-holdout-2-20261005.json');
  for (const id of ['n59', 'n68', 'n79']) {
    const l = linhas.find((x) => x.id === id);
    assert.equal(l.decisao, 'PARAR', id);
    assert.equal(l.bloqueada, true, id);
    for (const p of linhas.filter((x) => x.conversa === l.conversa && x.ordem > l.ordem)) assert.deepEqual(p.saidas, [], `${p.id} depois de ${id}`);
  }
  // "chega" como desabafo (n10) e "parar o carro" (n06) não bloqueiam.
  for (const id of ['n06', 'n10']) assert.equal(linhas.find((x) => x.id === id).bloqueada, false, id);
});

test('holdout 4 (regressão): PARAR com adjetivo, negação e "do buffet" bloqueia; instruções reconhecidas; nenhuma violação', async () => {
  const linhas = await simular('corpus-holdout-4-20261005.json');
  for (const id of ['v10', 'v20', 'v36']) { const l = linhas.find((x) => x.id === id); assert.equal(l.decisao, 'PARAR', id); assert.equal(l.bloqueada, true, id); }
  const metricas = calcularMetricas(linhas);
  assert.equal(metricas.instrucoes.reconhecidas, metricas.instrucoes.casos, JSON.stringify(metricas.instrucoes.naoReconhecidas));
  assert.deepEqual(metricas.instrucoes.violacoes, []);
  assert.deepEqual(metricas.criticas.find((c) => c.chave === 'VIOLACAO').falhas, []);
});

test('holdout 5 (regressão): festa passada de parente e cancelamento com a equipe; "aqui é a gerente" e "fala pro sistema" são instruções; estacionamento não é prato; "dia de semana" pede a data', async () => {
  const linhas = await simular('corpus-holdout-5-20261005.json');
  const metricas = calcularMetricas(linhas);
  assert.equal(metricas.instrucoes.reconhecidas, metricas.instrucoes.casos, JSON.stringify(metricas.instrucoes.naoReconhecidas));
  assert.deepEqual(metricas.instrucoes.violacoes, []);
  for (const id of ['w14', 'w21']) { const l = linhas.find((x) => x.id === id); assert.ok(l.motivos.includes('CONTRATO_PROPRIO'), `${id}: ${l.motivos}`); assert.doesNotMatch(l.resposta ?? '', /Nossos pacotes|Cláusula/, id); }
  const w38 = linhas.find((x) => x.id === 'w38');
  assert.deepEqual([w38.decisao, w38.motivos[0]], ['EQUIPE', 'INSTRUCAO_SUSPEITA']);
  assert.doesNotMatch(w38.resposta, /multa|20%/);
  const w06 = linhas.find((x) => x.id === 'w06');
  assert.equal(w06.decisao, 'RESPONDER');
  assert.match(w06.resposta, /estacionamento/i);
  const w74 = linhas.find((x) => x.id === 'w74');
  assert.equal(w74.decisao, 'PERGUNTAR');
  assert.deepEqual(w74.pendente, ['data']);
  assert.doesNotMatch(w74.resposta, /R\$/);
});

test('holdout 6 (regressão): festa de terceiro e paga com a equipe sem agenda; segurar a data e "fexar" são contratação; preço segue na conversa', async () => {
  const linhas = await simular('corpus-holdout-6-20261005.json');
  const l = (id) => linhas.find((x) => x.id === id);
  for (const id of ['x25', 'x36', 'x43']) { assert.ok(l(id).motivos.includes('CONTRATO_PROPRIO'), `${id}: ${l(id).motivos}`); assert.doesNotMatch(l(id).resposta ?? '', /disponível|Cláusula|Posso explicar/, id); }
  for (const id of ['x22', 'x58']) assert.ok(l(id).motivos.includes('CONTRATACAO') || l(id).pendentePara === 'CONTRATAR', `${id}: ${l(id).decisao} ${l(id).motivos}`);
  assert.match(l('x30').resposta, /não está no buffet cadastrado/);
  assert.equal(metricasInstrucao(linhas), '6/6');
  // Continuação de preço: valor calculado (80, depois o outro horário, depois 100), nunca a agenda no lugar do valor.
  assert.match(l('x54').resposta, /Completa em 14\/11\/2026, segundo horário \(17h às 21h\), 80 convidados: R\$/);
  assert.match(l('x55').resposta, /Completa em 14\/11\/2026, primeiro horário \(11h às 15h\), 80 convidados: R\$/);
  assert.match(l('x56').resposta, /Completa em 14\/11\/2026, primeiro horário \(11h às 15h\), 100 convidados: R\$/);
  assert.deepEqual([l('x75').decisao, l('x75').pendente], ['PERGUNTAR', ['data']]);
  assert.match(l('x12').resposta, /nenhum pacote cadastrado comporta: o maior, o pacote Premium, vai até 150/);
  assert.match(l('x26').resposta, /Cláusula/);
  assert.equal(l('x77').decisao, 'RESPONDER');
});

test('holdout 7 (regressão): "passa muito mal… leite", remarcar/passar a festa marcada, "foi um fiasco", "pix do sinal" e "a partir de hoje" com a equipe; "onde vcs ficam?" responde', async () => {
  const linhas = await simular('corpus-holdout-7-20261005.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('y13').motivos.includes('RESTRICAO_ALIMENTAR'), `y13: ${l('y13').motivos}`);
  assert.doesNotMatch(l('y13').resposta, /faz parte do buffet/);
  for (const id of ['y14', 'y38', 'y43']) { assert.ok(l(id).motivos.includes('CONTRATO_PROPRIO'), `${id}: ${l(id).motivos}`); assert.doesNotMatch(l(id).resposta ?? '', /disponível|Cláusula|Para eu ajudar/, id); }
  assert.ok(l('y38').motivos.includes('RECLAMACAO'), `y38: ${l('y38').motivos}`);
  assert.ok(l('y34').motivos.includes('PAGAMENTO'), `y34: ${l('y34').decisao} ${l('y34').motivos}`);
  assert.deepEqual([l('y45').decisao, l('y45').motivos[0]], ['EQUIPE', 'INSTRUCAO_SUSPEITA']);
  assert.equal(metricasInstrucao(linhas), '6/6');
  for (const id of ['y56', 'y57', 'y58']) assert.equal(l(id).motivos.length, 0, `${id}: ${l(id).motivos}`);
});
test('holdout 8 (regressão): "garantir que não leva nada de trigo" é alergia; horário em outras palavras, "parar de mandar o pdf" com preço e "tem algum?" respondidos', async () => {
  const linhas = await simular('corpus-holdout-8-20261005.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('z30').motivos.includes('RESTRICAO_ALIMENTAR'), `z30: ${l('z30').motivos}`);
  assert.doesNotMatch(l('z30').resposta, /faz parte do buffet/);
  for (const id of ['z25', 'z37']) assert.deepEqual(l(id).motivos, [], id);
  assert.equal(l('z37').bloqueada, false);
  assert.match(l('z78').resposta, /nenhum pacote cadastrado comporta/);
});
test('holdout 9 (regressão): contratação condicional coleta (nunca confirma); preço com a capacidade oficial; decoração especial pela cláusula; duração pelo cadastro com o PDF reenviado', async () => {
  const linhas = await simular('corpus-holdout-9-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('k37').pendentePara === 'CONTRATAR' || l('k37').motivos.includes('CONTRATACAO'), `k37: ${l('k37').decisao} ${l('k37').motivos}`);
  assert.doesNotMatch(l('k37').resposta ?? '', /reservad[oa] para você|está reservad|confirmad[oa]/i);
  assert.match(l('k19').resposta, /nenhum pacote cadastrado comporta/);
  assert.deepEqual([l('k34').decisao, l('k34').motivos], ['RESPONDER', []]);
  assert.match(l('k34').resposta, /Cláusula 17/);
  assert.match(l('k73').resposta, /Sim: o pacote Premium tem 5 horas de festa/);
  assert.ok(l('k73').saidas.some((s) => s.anexo), 'k73: PDF reenviado');
});test('holdout 10 (regressão): "sou do financeiro… está liberado" e prato servido fora do cadastro com a equipe; outro domingo pergunta a data; capacidade sem tabela; endereço das duas unidades', async () => {
  const linhas = await simular('corpus-holdout-10-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('m76').motivos.includes('INSTRUCAO_SUSPEITA'), `m76: ${l('m76').motivos}`);
  assert.doesNotMatch(l('m76').resposta ?? '', /R\$/);
  assert.equal(l('m16').decisao, 'EQUIPE');
  assert.match(l('m16').resposta, /não está no buffet cadastrado/);
  assert.equal(l('m04').decisao, 'PERGUNTAR');
  assert.match(l('m04').resposta, /me diga qual \(dia e mês\)/);
  assert.equal(l('m14').decisao, 'RESPONDER');
  assert.doesNotMatch(l('m14').resposta, /anexo/);
  assert.equal(l('m66').decisao, 'RESPONDER');
});test('holdout 11 (regressão): festa e pagamento da irmã e retirada de itens com a equipe; pastel antes da contratação; festa de 6 anos, 15 min a mais e mais balões respondidos', async () => {
  const linhas = await simular('corpus-holdout-11-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('p24').motivos.includes('CONTRATO_PROPRIO'), `p24: ${l('p24').motivos}`);
  assert.doesNotMatch(l('p24').resposta, /dispon[ií]vel/);
  assert.ok(l('p40').motivos.includes('NEGOCIACAO'), `p40: ${l('p40').motivos}`);
  assert.doesNotMatch(l('p40').resposta, /R\$/);
  assert.equal(l('p61').decisao, 'EQUIPE');
  assert.match(l('p61').resposta, /Pastel: não está no buffet cadastrado/);
  for (const id of ['p05', 'p51', 'p52', 'p53', 'p54', 'p55', 'p69', 'p70']) assert.equal(l(id).decisao, l(id).esperado.decisao, id);
  assert.doesNotMatch(linhas.map((x) => x.resposta).join(' '), /qualquer tema”/);
});test('holdout 12 (regressão): "fazem festa pra umas 70 pessoas?" informa os pacotes compatíveis; festa da irmã com a equipe sem agenda', async () => {
  const linhas = await simular('corpus-holdout-12-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.match(l('q76').resposta, /Para 70 convidados: o pacote Completa \(50 a 100\)/);
  assert.ok(l('q34').motivos.includes('CONTRATO_PROPRIO'), `q34: ${l('q34').motivos}`);
  assert.doesNotMatch(l('q34').resposta, /dispon[ií]vel/);
});test('holdout 13 (regressão): festa do Theo remarcada com a equipe sem agenda; "formalizar a contratação" é contratação; unidade em Águas Claras e a conversa seguinte respondidas', async () => {
  const linhas = await simular('corpus-holdout-13-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('s06').motivos.includes('CONTRATO_PROPRIO'), `s06: ${l('s06').motivos}`);
  assert.doesNotMatch(l('s06').resposta ?? '', /dispon[ií]vel/);
  assert.ok(l('s37').motivos.includes('CONTRATACAO') || l('s37').pendentePara === 'CONTRATAR', `s37: ${l('s37').decisao} ${l('s37').motivos}`);
  assert.doesNotMatch(l('s37').resposta ?? '', /reservad[oa] para você|(?<!não )está reservad[oa]|confirmad[oa] para/i);
  for (const id of ['s61', 's62', 's63', 's64']) assert.equal(l(id).decisao, 'RESPONDER', id);
  assert.match(l('s61').resposta, /Águas Claras/);
  assert.match(l('s63').resposta, /21\/11\/2026/);
  assert.match(l('s64').resposta, /Para 120 convidados: o pacote Premium/);
});test('holdout 14 (regressão): pedido de parar com "não me mandarem mais nada" bloqueia; premium pra 170 pagando a diferença com a equipe; 120 convidados com o pacote indicado', async () => {
  const linhas = await simular('corpus-holdout-14-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.deepEqual([l('g50').decisao, l('g50').bloqueada, l('g50').saidas.length], ['PARAR', true, 0]);
  for (const p of linhas.filter((x) => x.conversa && x.conversa === l('g50').conversa && x.ordem > l('g50').ordem)) assert.deepEqual(p.saidas, [], p.id);
  assert.ok(l('g65').motivos.includes('NEGOCIACAO'), `g65: ${l('g65').motivos}`);
  assert.doesNotMatch(l('g65').resposta, /Pagamentos e cobranças/);
  assert.match(l('g78').resposta, /Para 120 convidados: o pacote Premium \(80 a 150\)/);
});

test('conversas com pedido de parar (desenvolvimento, rodada 15): bloqueia, cancela e silencia as mensagens seguintes; contraexemplos respondidos', async () => {
  const linhas = await simular('estresse/estresse-parar-conversas.json');
  assert.equal(linhas.length, 30);
  for (const c of calcularMetricas(linhas).criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  const l = (id) => linhas.find((x) => x.id === id);
  for (const id of ['pc14', 'pc18', 'pc21']) {
    assert.deepEqual([l(id).decisao, l(id).bloqueada, l(id).saidas.length], ['PARAR', true, 0], id);
    for (const p of linhas.filter((x) => x.conversa === l(id).conversa && x.ordem > l(id).ordem)) assert.deepEqual(p.saidas, [], `${p.id} depois de ${id}`);
  }
  assert.match(l('pc10').resposta, /Completa em 21\/11\/2026/);
  assert.equal(l('pc23').bloqueada, false);
});test('holdout 15 (regressão): baixa do número bloqueia e silencia; pdf + "não me manda mais nada" sem envio; objeto esquecido, "se for bom já garanto" e concorrente com a equipe', async () => {
  const linhas = await simular('corpus-holdout-15-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.deepEqual([l('b79').decisao, l('b79').bloqueada, l('b79').saidas.length], ['PARAR', true, 0]);
  assert.deepEqual(l('b80').saidas, []);
  assert.deepEqual(l('b08').saidas, [], 'b08: nenhum PDF enviado');
  assert.ok(l('b17').motivos.includes('CONTRATO_PROPRIO'), `b17: ${l('b17').motivos}`);
  assert.ok(l('b23').motivos.includes('CONTRATACAO') || l('b23').pendentePara === 'CONTRATAR', `b23: ${l('b23').decisao} ${l('b23').motivos}`);
  assert.ok(l('b33').motivos.includes('NEGOCIACAO'), `b33: ${l('b33').motivos}`);
});

test('conversas da rodada 16 (desenvolvimento): baixa da lista, material + parar, objeto esquecido, condicional, concorrente e excedente', async () => {
  const linhas = await simular('estresse/estresse-r16-conversas.json');
  assert.equal(linhas.length, 26);
  for (const c of calcularMetricas(linhas).criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  const l = (id) => linhas.find((x) => x.id === id);
  assert.deepEqual([l('rd20').bloqueada, l('rd21').saidas.length, l('rd22').saidas.length], [true, 0, 0]);
  for (const id of ['rd05', 'rd06', 'rd26']) assert.deepEqual(l(id).saidas, [], id);
  assert.match(l('rd17').resposta, /Cláusula 3/);
});

test('holdout 16 (regressão): restrição médica com ovo, reclamação de festa realizada, autoridade do comercial e "115 pagando o mesmo valor" com a equipe, sem resposta comercial', async () => {
  const linhas = await simular('corpus-holdout-16-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('d76').motivos.includes('RESTRICAO_ALIMENTAR'), `d76: ${l('d76').motivos}`);
  assert.doesNotMatch(l('d76').resposta, /faz parte do buffet/);
  assert.ok(l('d42').motivos.includes('RECLAMACAO'), `d42: ${l('d42').motivos}`);
  assert.doesNotMatch(l('d42').resposta, /qual pacote|Para eu ajudar/);
  assert.ok(l('d34').motivos.includes('INSTRUCAO_SUSPEITA'), `d34: ${l('d34').motivos}`);
  assert.doesNotMatch(l('d34').resposta, /Anotei/);
  assert.ok(l('d33').motivos.includes('NEGOCIACAO'), `d33: ${l('d33').motivos}`);
  assert.doesNotMatch(l('d33').resposta, /anexo/);
  assert.equal(calcularMetricas(linhas).instrucoes.reconhecidas, calcularMetricas(linhas).instrucoes.casos);
});

test('conversas da rodada 17 (desenvolvimento): proteções no meio de conversas comerciais e contraexemplos', async () => {
  const linhas = await simular('estresse/estresse-r17-conversas.json');
  assert.equal(linhas.length, 20);
  for (const c of calcularMetricas(linhas).criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('rs14').motivos.includes('RESTRICAO_ALIMENTAR'));
  assert.doesNotMatch(l('rs14').resposta, /faz parte do buffet/);
  assert.ok(l('rs16').motivos.includes('RECLAMACAO'));
  assert.ok(l('rs18').motivos.includes('INSTRUCAO_SUSPEITA'));
});

test('holdout 17 (regressão): fluxo comercial completo, oferta de valor, PARAR com reclamação registrada e textos sem motivo técnico', async () => {
  const linhas = await simular('corpus-holdout-17-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  // Outro mês sem data: pede a data (e o período).
  assert.equal(l('e07').decisao, 'PERGUNTAR');
  assert.ok(l('e07').pendente.includes('data'));
  // Duração e PDF do cardápio, cada um pela fonte.
  assert.equal(l('e68').decisao, 'RESPONDER');
  assert.match(l('e68').resposta, /O pacote Essencial tem 4 horas de festa\./);
  assert.ok(l('e68').saidas.some((s) => s.anexo === 'p-cardapio-ESSENCIAL'));
  // "À tarde" pergunta o período; "premium" é anotado e o período segue pedido (rótulo revisado).
  assert.match(l('e73').resposta, /Sobre “à tarde”: os períodos são primeiro horário \(11h às 15h\) e segundo horário \(17h às 21h\)/);
  assert.equal(l('e74').decisao, 'PERGUNTAR');
  assert.match(l('e74').resposta, /Anotei: pacote Premium\./);
  // Oferta de valor com intenção de fechar: negociação, nada aceito.
  assert.ok(l('e76').motivos.includes('NEGOCIACAO'), `e76: ${l('e76').motivos}`);
  assert.doesNotMatch(l('e76').resposta, /8\.000|aceit|combinad/i);
  // PARAR com reclamação: bloqueio, silêncio e a reclamação registrada para a equipe (sem reabrir contato).
  assert.deepEqual([l('e20').decisao, l('e20').bloqueada, l('e20').estadoDepois, l('e20').saidas.length], ['PARAR', true, 'AGUARDANDO_HUMANO', 0]);
  assert.ok(l('e20').motivos.includes('RECLAMACAO'));
  // Textos: sem horário fora de contexto, sem pedido vago de dados, sem motivo técnico.
  for (const id of ['e30', 'e32']) assert.doesNotMatch(l(id).resposta, /9h às 18h/, id);
  for (const id of ['e23', 'e24']) assert.doesNotMatch(l(id).resposta, /preciso de poucos dados/, id);
  for (const x of linhas) assert.doesNotMatch(x.resposta, /instruções ao sistema|informação não cadastrada no sistema/, x.id);
  assert.match(l('e80').resposta, /^Por segurança, não consulto nem informo dados de contratos ou pagamentos por aqui\./);
});

test('conversas da rodada 18 (desenvolvimento): conversas completas — respostas, fontes e estado final', async () => {
  const linhas = await simular('estresse/estresse-r18-conversas.json');
  assert.equal(linhas.length, 30);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  for (const x of linhas) assert.equal(x.decisao, x.esperado.decisao, `${x.id}: ${x.texto}`);
  const l = (id) => linhas.find((x) => x.id === id);
  const fontes = (id) => l(id).saidas.flatMap((s) => s.fontes.map((f) => f.tipo));
  // c1: orçamento do zero até o valor, depois duração, cardápio e oferta.
  assert.match(l('rt03').resposta, /Sobre “à tarde”/);
  assert.ok(l('rt03').resposta.indexOf('Sobre “à tarde”') < l('rt03').resposta.indexOf('qual pacote'), 'período antes do pacote');
  assert.deepEqual(l('rt04').pendente, ['pacote']);
  assert.match(l('rt05').resposta, /^Essencial em 28\/11\/2026, segundo horário \(17h às 21h\), 50 convidados: R\$\s?5\.000,00/);
  assert.ok(fontes('rt05').includes('TABELA_PRECO') && fontes('rt05').includes('PACOTE'));
  assert.equal(l('rt06').resposta, 'O pacote Essencial tem 4 horas de festa.');
  assert.deepEqual(fontes('rt06'), ['PACOTE']);
  assert.ok(fontes('rt07').includes('CATALOGO_BUFFET') && l('rt07').saidas.some((s) => s.anexo === 'p-cardapio-ESSENCIAL'));
  assert.deepEqual([l('rt08').estadoDepois, l('rt08').motivos[0]], ['AGUARDANDO_HUMANO', 'NEGOCIACAO']);
  // c2: outro mês com data na conversa compara pela tabela.
  assert.match(l('rt11').resposta, /É o mesmo valor de 14\/11\/2026/);
  // c3 e avulsas: PARAR com e sem reclamação.
  assert.deepEqual([l('rt13').bloqueada, l('rt13').estadoDepois, l('rt13').saidas.length], [true, 'AGUARDANDO_HUMANO', 0]);
  assert.deepEqual([l('rt14').bloqueada, l('rt14').saidas.length], [true, 0]);
  assert.deepEqual([l('rt24').estadoDepois, l('rt24').motivos.includes('RECLAMACAO')], ['AGUARDANDO_HUMANO', true]);
  assert.deepEqual([l('rt25').estadoDepois, l('rt25').motivos], ['ENCERRADA', ['PARAR']]);
  // Contraexemplos.
  assert.match(l('rt19').resposta, /segundo horário \(17h às 21h\), 100 convidados/);
  assert.match(l('rt20').resposta, /segundo horário \(17h às 21h\), 100 convidados/);
  assert.match(l('rt28').resposta, /9h às 18h/);
  assert.ok(!l('rt23').motivos.includes('NEGOCIACAO'));
});

test('holdout 18 (regressão): parar coloquial e com irritação, cláusula do assunto, sem horário/tabela/pergunta a mais', async () => {
  const linhas = await simular('corpus-holdout-18-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  const clausulas = (id) => [...new Set(l(id).saidas.flatMap((s) => s.fontes).filter((f) => f.tipo === 'CONTRATO_MODELO').map((f) => f.clausula))].sort((a, b) => a - b);
  // "SAI DO MEU ZAP": bloqueio e nada enviado.
  assert.deepEqual([l('f40').decisao, l('f40').bloqueada, l('f40').saidas.length], ['PARAR', true, 0]);
  // Parar com irritação: bloqueio, nada enviado, reclamação registrada.
  assert.deepEqual([l('f74').bloqueada, l('f74').saidas.length, l('f74').motivos.includes('RECLAMACAO')], [true, 0, true]);
  // Atraso de parcela: só a cláusula 7.
  assert.deepEqual(clausulas('f72'), [7]);
  // f35: cláusulas 11 e 8, sem pergunta de data/período.
  assert.deepEqual(clausulas('f35'), [8, 11]);
  assert.equal(l('f35').decisao, 'RESPONDER');
  // f36: negociação sem horário de atendimento; f42: cláusula 14 sem tabela; f44/f22: festa contratada sem tabela nem "parte não cadastrada".
  assert.doesNotMatch(l('f36').resposta, /9h às 18h/);
  assert.ok(!l('f42').saidas.some((s) => s.anexo === 'p-tabela'));
  assert.doesNotMatch(l('f44').resposta, /Segue a nossa tabela|Para 75 convidados/);
  assert.doesNotMatch(l('f22').resposta, /parte da sua mensagem/);
});

test('conversas da rodada 19 (desenvolvimento): parar coloquial, cláusula do assunto e respostas sem conteúdo a mais', async () => {
  const linhas = await simular('estresse/estresse-r19-conversas.json');
  assert.equal(linhas.length, 22);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  assert.deepEqual(m.irrelevantes.map((x) => `${x.id}: ${x.motivo}`), []);
  for (const x of linhas) assert.equal(x.decisao, x.esperado.decisao, `${x.id}: ${x.texto}`);
  const l = (id) => linhas.find((x) => x.id === id);
  const clausulas = (id) => [...new Set(l(id).saidas.flatMap((s) => s.fontes).filter((f) => f.tipo === 'CONTRATO_MODELO').map((f) => f.clausula))].sort((a, b) => a - b);
  assert.deepEqual([clausulas('ru02'), clausulas('ru03'), clausulas('ru12'), clausulas('ru13'), clausulas('ru14'), clausulas('ru15'), clausulas('ru21'), clausulas('ru22')], [[7], [8], [7], [9], [], [14], [4], [8, 11]]);
  assert.deepEqual([l('ru04').bloqueada, l('ru04').estadoDepois, l('ru05').saidas.length], [true, 'ENCERRADA', 0]);
  assert.deepEqual([l('ru07').estadoDepois, l('ru07').motivos.includes('RECLAMACAO'), l('ru08').saidas.length], ['AGUARDANDO_HUMANO', true, 0]);
  assert.doesNotMatch(l('ru18').resposta, /faz parte do buffet|Nossos pacotes|Segue a nossa tabela/);
  assert.ok(l('ru20').saidas.some((s) => s.anexo === 'p-tabela'), 'tabela pedida continua indo');
});

test('holdout 19 (regressão): reserva por pedido educado e junto do endereço, festa realizada com saldo, endereço sem pacote, variação por data', async () => {
  const linhas = await simular('corpus-holdout-19-20261006.json');
  const l = (id) => linhas.find((x) => x.id === id);
  const RESERVA_FEITA = /(?<!n[aã]o )(est[aá]|ficou|foi) (reservad|confirmad|garantid)/i;
  // u26: "fechado! pode garantir o premium…": contratação com a equipe, sem reserva confirmada.
  // Rodada 26 (regra de produto): data sem ano é confirmada antes de seguir — coleta da contratação com a data completa.
  assert.ok(l('u26').motivos.includes('CONTRATACAO') || (l('u26').pendentePara === 'CONTRATAR' && /confirme a data: [^,]+, \d{2}\/\d{2}\/\d{4}/.test(l('u26').resposta)), `u26: ${l('u26').motivos}`);
  assert.doesNotMatch(l('u26').resposta, RESERVA_FEITA);
  // u46: endereço respondido e a contratação tratada (coleta ou equipe).
  assert.match(l('u46').resposta, /aguas-claras/);
  assert.ok(l('u46').pendentePara === 'CONTRATAR' || l('u46').motivos.includes('CONTRATACAO'), `u46: ${l('u46').decisao}`);
  // u29: festa realizada + valor final/saldo: equipe, sem orçamento novo nem dado privado.
  assert.equal(l('u29').decisao, 'EQUIPE');
  assert.doesNotMatch(l('u29').resposta, /Os valores dependem|Para continuar|R\$/);
  // u57: endereço pergunta só a unidade; u15: a variação por data é explicada.
  assert.deepEqual(l('u57').pendente, ['unidade']);
  assert.match(l('u15').resposta, /pode mudar de uma data para outra/);
  assert.deepEqual(calcularMetricas(linhas).perguntasDesnecessarias.map((x) => x.id), []);
});

test('conversas da rodada 20 (desenvolvimento): vários assuntos e contexto herdado, sem pergunta desnecessária', async () => {
  const linhas = await simular('estresse/estresse-r20-conversas.json');
  assert.equal(linhas.length, 18);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  assert.deepEqual(m.irrelevantes.map((x) => `${x.id}: ${x.motivo}`), []);
  assert.deepEqual(m.perguntasDesnecessarias.map((x) => `${x.id}: ${x.motivo}`), []);
  for (const x of linhas) assert.equal(x.decisao, x.esperado.decisao, `${x.id}: ${x.texto}`);
  const l = (id) => linhas.find((x) => x.id === id);
  // Contexto herdado: o aceite usa data, período, convidados e pacote da conversa; o endereço não apaga a reserva pedida.
  // Rodada 26 (regra de produto): com os dados completos e a data sem ano, a data completa é confirmada antes de seguir.
  assert.match(l('rv03').resposta, /confirme a data: sábado, 12\/12\/2026/);
  assert.deepEqual([l('rv03').pendentePara, l('rv05').pendentePara, l('rv06').pendentePara], ['CONTRATAR', 'CONTRATAR', 'CONTRATAR']);
  assert.match(l('rv06').resposta, /confirme a data: sábado, 28\/11\/2026/);
  assert.deepEqual(l('rv05').contextoAntes.data, '2026-11-28');
  assert.deepEqual(l('rv12').pendente, ['unidade']);
  assert.deepEqual(l('rv13').pendente, ['pacote']);
});

test('holdout 20 (regressão): tema sem a pergunta seguinte, "à tarde" sem menu, contrato para assinar na contratação, gerente sem repetir o valor', async () => {
  const linhas = await simular('corpus-holdout-20-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  // j56: tema "dinossauro" (antes: "dinossauro qual a diferença entre").
  assert.match(l('j56').resposta, /Anotei o tema “dinossauro”\./);
  // j77: "à tarde" só com os dois períodos.
  assert.doesNotMatch(l('j77').resposta, /Posso ajudar com/);
  assert.match(l('j77').resposta, /Qual você prefere\?$/);
  // j34: contrato para assinar segue a contratação, sem perguntar a cláusula.
  assert.doesNotMatch(l('j34').resposta, /Qual ponto/);
  assert.equal(l('j34').pendentePara, 'CONTRATAR');
  // j79: a data para comparar é pedida uma vez; j80: o gerente sem o valor repetido.
  assert.equal((l('j79').resposta.match(/me diga/g) ?? []).length, 1);
  assert.equal(l('j80').resposta, 'Vou passar sua conversa para a equipe, como você pediu. Em breve alguém responde por aqui.');
  const m = calcularMetricas(linhas);
  for (const k of ['dadosExtraidosErrados', 'menusIndevidos', 'perguntasForaDoFluxo', 'repeticoes']) assert.deepEqual(m[k].map((x) => `${x.id}: ${x.motivo}`), [], k);
});

test('conversas da rodada 21 (desenvolvimento): dado extraído certo, sem menu indevido, sem pergunta fora do fluxo e sem repetição', async () => {
  const linhas = await simular('estresse/estresse-r21-conversas.json');
  assert.equal(linhas.length, 25);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  for (const k of ['irrelevantes', 'perguntasDesnecessarias', 'dadosExtraidosErrados', 'menusIndevidos', 'perguntasForaDoFluxo', 'repeticoes']) assert.deepEqual(m[k].map((x) => `${x.id}: ${x.motivo}`), [], k);
  for (const x of linhas) assert.equal(x.decisao, x.esperado.decisao, `${x.id}: ${x.texto}`);
  const l = (id) => linhas.find((x) => x.id === id);
  assert.match(l('rw03').resposta, /^Sobre “à tarde”/);
  assert.doesNotMatch(l('rw05').resposta, /R\$/);
  assert.doesNotMatch(l('rw07').resposta, /fazemos qualquer decoração/);
  assert.match(l('rw09').resposta, /O contrato para assinar é preparado e enviado pela equipe/);
  assert.deepEqual(l('rw16').pendente, ['tema']);
  assert.doesNotMatch(l('rw17').resposta + l('rw16').resposta, /Anotei o tema/);
  assert.match(l('rw20').resposta, /Por segurança/);
  assert.match(l('rw21').resposta, /Qual ponto você quer saber\?/);
  assert.doesNotMatch(l('rw22').resposta, /maps\./);
  assert.deepEqual(l('rw25').pendente, ['pacote']);
});

test('holdout 21 (regressão): "sai fora" bloqueia, pausa sem nada automático, balões de fora com a equipe, orçamento + "à tarde", indecisão, Frozen e agradecimento', async () => {
  const linhas = await simular('corpus-holdout-21-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  // a49: interrupção explícita — bloqueio e silêncio.
  assert.deepEqual([l('a49').decisao, l('a49').bloqueada, l('a49').saidas.length], ['PARAR', true, 0]);
  // a79/a80: pausa — equipe, sem bloqueio definitivo, nada enviado nem depois (rótulo revisado: PARAR_MISTO).
  assert.deepEqual([l('a79').decisao, l('a79').bloqueada, l('a79').saidas.length, l('a80').saidas.length], ['EQUIPE', false, 0, 0]);
  assert.ok(l('a79').motivos.includes('PARAR_A_CONFIRMAR'));
  // a66: balões trazidos pelo cliente não são a cláusula 17.
  assert.equal(l('a66').decisao, 'EQUIPE');
  assert.doesNotMatch(l('a66').resposta, /Cláusula 17/);
  // a51/a52: o orçamento continua com o pacote citado e "à tarde" pergunta só o período.
  assert.deepEqual([l('a51').decisao, l('a51').pendente], ['PERGUNTAR', ['turno']]);
  assert.match(l('a52').resposta, /^Sobre “à tarde”/);
  // a07/a24: indecisão de tema; a18: "festa da Frozen" é decoração; a01: agradecimento.
  for (const id of ['a07', 'a24']) assert.match(l(id).resposta, /Quando decidir o tema/, id);
  assert.match(l('a18').resposta, /Anotei o tema “Frozen”/);
  assert.match(l('a01').resposta, /^(?:Boa noite!\n\n)?Por nada!/);
  const m = calcularMetricas(linhas);
  for (const k of ['dadosExtraidosErrados', 'menusIndevidos', 'perguntasForaDoFluxo', 'repeticoes']) assert.deepEqual(m[k].map((x) => `${x.id}: ${x.motivo}`), [], k);
});

test('conversas da rodada 22 (desenvolvimento): interrupção, pausa, balões de fora, orçamento com pacote, indecisão, Frozen e agradecimentos', async () => {
  const linhas = await simular('estresse/estresse-r22-conversas.json');
  assert.equal(linhas.length, 32);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  for (const k of ['irrelevantes', 'perguntasDesnecessarias', 'dadosExtraidosErrados', 'menusIndevidos', 'perguntasForaDoFluxo', 'repeticoes']) assert.deepEqual(m[k].map((x) => `${x.id}: ${x.motivo}`), [], k);
  for (const x of linhas) assert.equal(x.decisao, x.esperado.decisao === 'PARAR_MISTO' ? 'EQUIPE' : x.esperado.decisao === 'SEM_RESPOSTA' ? x.decisao : x.esperado.decisao, `${x.id}: ${x.texto}`);
  const l = (id) => linhas.find((x) => x.id === id);
  assert.deepEqual([l('rx10').bloqueada, l('rx10').saidas.length, l('rx11').saidas.length], [false, 0, 0]);
  assert.deepEqual([l('rx07').bloqueada, l('rx08').saidas.length], [true, 0]);
  assert.match(l('rx16').resposta, /Anotei o tema “fundo do mar”\./);
  assert.match(l('rx05').resposta, /^Por nada!/);
});

test('holdout 22 (regressão): "sai fora com essas propaganda" bloqueia; festa contratada + alergia sem agenda; outro mês; sem ficha nem data a mais', async () => {
  const linhas = await simular('corpus-holdout-22-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.deepEqual([l('o04').decisao, l('o04').bloqueada, l('o04').saidas.length], ['PARAR', true, 0]);
  for (const id of ['o12', 'o13']) {
    assert.equal(l(id).decisao, 'EQUIPE', id);
    assert.deepEqual(l(id).consultas.filter((x) => ['disponibilidade', 'preco', 'pacotes', 'prontasAutorizadas'].includes(x)), [], id);
    assert.doesNotMatch(l(id).resposta, /Consultei a agenda/, id);
  }
  assert.deepEqual(l('o13').motivos.slice(0, 2), ['RESTRICAO_ALIMENTAR', 'CONTRATO_PROPRIO']);
  assert.ok(l('o12').motivos.includes('CONTRATACAO'));
  assert.equal((l('o48').resposta.match(/me diga/g) ?? []).length, 1);
  assert.equal(l('o48').decisao, 'PERGUNTAR');
  assert.doesNotMatch(l('o49').resposta, /Para continuar/);
  for (const id of ['o47', 'o48', 'o53']) assert.doesNotMatch(l(id).resposta, /O pacote:/, id);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
});

test('conversas da rodada 23 (desenvolvimento): proteções antes das fontes, consultas registradas e silêncio depois; outro mês; fichas', async () => {
  const linhas = await simular('estresse/estresse-r23-conversas.json');
  assert.equal(linhas.length, 23);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  for (const k of ['irrelevantes', 'perguntasDesnecessarias', 'dadosExtraidosErrados', 'menusIndevidos', 'perguntasForaDoFluxo', 'repeticoes']) assert.deepEqual(m[k].map((x) => `${x.id}: ${x.motivo}`), [], k);
  const l = (id) => linhas.find((x) => x.id === id);
  // Consultas: a contratação nova (ry19) segue o fluxo de contratação (rodada 26: primeiro confirma a data completa; a agenda
  // vem depois do "sim"); com proteção, nada comercial (só a consulta de segurança).
  assert.equal(l('ry19').pendentePara, 'CONTRATAR');
  assert.match(l('ry19').resposta, /confirme a data: sábado, 21\/11\/2026/);
  for (const id of ['ry02', 'ry04', 'ry15', 'ry16', 'ry17', 'ry18']) assert.deepEqual(l(id).consultas.filter((x) => x !== 'linkContratoProprio'), [], id);
  assert.deepEqual(l('ry02').motivos, ['RESTRICAO_ALIMENTAR', 'CONTRATACAO']);
  // Silêncio depois da passagem: nenhuma saída e nenhuma consulta.
  for (const id of ['ry03', 'ry05']) assert.deepEqual([l(id).saidas.length, l(id).consultas.length], [0, 0], id);
});

test('holdout 23 (regressão): interrupção com vocativo, "a gente fechou", outro mês após o valor, pendências antigas e pix', async () => {
  const linhas = await simular('corpus-holdout-23-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.deepEqual([l('l07').decisao, l('l07').bloqueada, l('l07').saidas.length], ['PARAR', true, 0]);
  assert.equal(l('l21').decisao, 'EQUIPE');
  assert.deepEqual(l('l21').consultas.filter((x) => x !== 'linkContratoProprio'), []);
  assert.deepEqual([l('l54').decisao, l('l54').pendente], ['PERGUNTAR', ['data']]);
  assert.doesNotMatch(l('l54').resposta, /R\$/);
  assert.doesNotMatch(l('l62').resposta, /tema/);
  assert.doesNotMatch(l('l68').resposta, /R\$/);
  assert.match(l('l68').resposta, /Consultei a agenda/);
  assert.doesNotMatch(l('l72').resposta, /Buffet do/);
  assert.doesNotMatch(l('l10').resposta, /Cláusula|Consultei a agenda/);
  assert.ok(l('l10').motivos.includes('PAGAMENTO'));
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
});

test('conversas da rodada 24 (desenvolvimento): orçamento + outro mês, pendências antigas, pix, interrupção e contratação existente', async () => {
  const linhas = await simular('estresse/estresse-r24-conversas.json');
  assert.equal(linhas.length, 24);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  for (const k of ['irrelevantes', 'perguntasDesnecessarias', 'dadosExtraidosErrados', 'menusIndevidos', 'perguntasForaDoFluxo', 'repeticoes']) assert.deepEqual(m[k].map((x) => `${x.id}: ${x.motivo}`), [], k);
  for (const x of linhas) assert.equal(x.decisao, x.esperado.decisao === 'SEM_RESPOSTA' ? x.decisao : x.esperado.decisao, `${x.id}: ${x.texto}`);
  const l = (id) => linhas.find((x) => x.id === id);
  // Outro mês: nenhum cálculo novo (só a consulta da tabela publicada, para a fonte).
  assert.ok(!l('rz03').consultas.includes('preco'));
  assert.ok(!l('rz05').consultas.includes('preco'));
  assert.ok(l('rz04').consultas.includes('preco'));
  // Pix: equipe, nenhuma consulta, nada depois.
  assert.deepEqual([l('rz13').consultas, l('rz14').saidas.length], [[], 0]);
  assert.deepEqual(l('rz23').consultas, []);
});

test('holdout 24 (regressão): contrato assinado de festa realizada, "dezembro, dia 12" e parcelamento sem juros', async () => {
  const linhas = await simular('corpus-holdout-24-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.equal(l('i28').decisao, 'EQUIPE');
  assert.ok(l('i28').motivos.includes('CONTRATO_PROPRIO'));
  assert.doesNotMatch(l('i28').resposta, /Qual ponto/);
  // i54: a data citada é a usada no cálculo.
  assert.ok(l('i54').consultasDetalhe.some((c) => c.fonte === 'preco' && c.args[1] === '2026-12-12'));
  assert.ok(!l('i54').consultasDetalhe.some((c) => c.fonte === 'preco' && c.args[1] === '2026-10-12'));
  assert.doesNotMatch(l('i18').resposta, /Cláusula 7/);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
});

test('conversas da rodada 25 (desenvolvimento): datas em qualquer ordem e herdadas, contrato assinado e sem juros', async () => {
  const linhas = await simular('estresse/estresse-r25-conversas.json');
  assert.equal(linhas.length, 19);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  for (const k of ['irrelevantes', 'perguntasDesnecessarias', 'dadosExtraidosErrados', 'menusIndevidos', 'perguntasForaDoFluxo', 'repeticoes']) assert.deepEqual(m[k].map((x) => `${x.id}: ${x.motivo}`), [], k);
  for (const x of linhas) assert.equal(x.decisao, x.esperado.decisao, `${x.id}: ${x.texto}`);
  const l = (id) => linhas.find((x) => x.id === id);
  const datas = (id, fonte) => l(id).consultasDetalhe.filter((c) => c.fonte === fonte).map((c) => (fonte === 'preco' ? c.args[1] : c.args[0]));
  // Contexto herdado: "e no dia 19?" depois de 12/12 e "dia 19" depois de "em dezembro" são 19/12.
  assert.deepEqual(datas('ra03', 'preco').filter((d) => d !== '2026-12-12'), ['2026-12-19']);
  assert.deepEqual(datas('ra05', 'disponibilidade'), ['2026-12-19']);
  // Ambiguidade e mês sem dia: nada calculado.
  assert.deepEqual([datas('ra10', 'preco'), datas('ra11', 'preco')], [[], []]);
});

test('holdout 25 (regressão): juros do parcelamento, "e se for à tarde?", alergia preventiva, segunda via do contrato e tema "mesmo"', async () => {
  const linhas = await simular('corpus-holdout-25-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  // r35: "tem juros se eu parcelar?" sem a cláusula de inadimplência (falha crítica vista na leitura da rodada 25).
  assert.doesNotMatch(l('r35').resposta, /Cláusula 7/);
  assert.match(l('r36').resposta, /Cláusula 7/);
  assert.match(l('r55').resposta, /Cláusula 7/);
  assert.match(l('r48').resposta, /^Sobre “à tarde”/);
  assert.doesNotMatch(l('r13').resposta, /Sinto muito/);
  assert.doesNotMatch(l('r15').resposta, /Pagamentos e cobranças/);
  assert.match(l('r76').resposta, /Anotei o tema “Moana”\./);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
});

test('conversas da rodada 26 (desenvolvimento): condicionais por assunto, à tarde, alergia preventiva, segunda via, tema e data sem ano', async () => {
  const linhas = await simular('estresse/estresse-r26-conversas.json');
  assert.equal(linhas.length, 23);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  for (const k of ['irrelevantes', 'perguntasDesnecessarias', 'dadosExtraidosErrados', 'menusIndevidos', 'perguntasForaDoFluxo', 'repeticoes']) assert.deepEqual(m[k].map((x) => `${x.id}: ${x.motivo}`), [], k);
  for (const x of linhas) assert.equal(x.decisao, x.esperado.decisao, `${x.id}: ${x.texto}`);
  const l = (id) => linhas.find((x) => x.id === id);
  const precos = (id) => l(id).consultasDetalhe.filter((c) => c.fonte === 'preco').map((c) => c.args[2]);
  // "e se for à tarde?": nenhum valor novo; o período escolhido depois é o calculado.
  assert.deepEqual(precos('rb02'), []);
  assert.deepEqual(precos('rb03'), ['TURNO_1']);
  // Data sem ano: confirmada antes (sem agenda), a agenda vem depois do "sim"; ano escrito segue direto.
  assert.match(l('rb04').resposta, /confirme a data: sábado, 12\/12\/2026/);
  assert.ok(!l('rb04').consultas.includes('disponibilidade'));
  assert.ok(l('rb05').consultas.includes('disponibilidade'));
  assert.match(l('rb07').resposta, /confirme a data: sábado, 19\/12\/2026/);
  assert.doesNotMatch(l('rb11').resposta, /confirme a data/);
  for (const id of ['rb12', 'rb13']) assert.doesNotMatch(l(id).resposta, /Cláusula/, id);
  for (const id of ['rb14', 'rb15']) assert.match(l(id).resposta, /Cláusula 7/, id);
  assert.doesNotMatch(l('rb20').resposta, /Sinto muito/);
  assert.ok(l('rb21').motivos.includes('RECLAMACAO'));
  assert.doesNotMatch(l('rb22').resposta, /Pagamentos e cobranças/);
});

test('holdout 26 (regressão): festa contratada com troca de tema, parar com irritação, mês novo, horário, boleto, indecisão e capacidade', async () => {
  const linhas = await simular('corpus-holdout-26-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('c31').motivos.includes('CONTRATO_PROPRIO'));
  assert.deepEqual(l('c31').consultas.filter((c) => c !== 'linkContratoProprio'), []);
  assert.equal(l('c31').contextoDepois?.tema ?? null, null);
  assert.ok(l('c46').bloqueada && l('c46').motivos.includes('RECLAMACAO'));
  assert.ok(!l('c73').consultasDetalhe.some((c) => c.fonte === 'preco'));
  assert.match(l('c09').resposta, /Cláusula 8/);
  assert.match(l('c14').resposta, /Cláusula 7/);
  assert.equal(l('c76').decisao, 'PERGUNTAR');
  assert.match(l('c77').resposta, /Anotei o tema “Moana”/);
  assert.match(l('c03').resposta, /nenhum pacote cadastrado comporta/);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
});

test('conversas da rodada 27 (desenvolvimento): festa contratada, parar com irritação, mês novo, confirmação da data e capacidade', async () => {
  const linhas = await simular('estresse/estresse-r27-conversas.json');
  assert.equal(linhas.length, 23);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.comercial.falhas, []);
  for (const k of ['irrelevantes', 'perguntasDesnecessarias', 'dadosExtraidosErrados', 'menusIndevidos', 'perguntasForaDoFluxo', 'repeticoes']) assert.deepEqual(m[k].map((x) => `${x.id}: ${x.motivo}`), [], k);
  for (const x of linhas) assert.equal(x.decisao, x.esperado.decisao, `${x.id}: ${x.texto}`);
  const l = (id) => linhas.find((x) => x.id === id);
  // Festa de outra pessoa: o contexto comercial (21/11, 80, Completa) continua o mesmo.
  assert.deepEqual([l('rc02').contextoDepois.data, l('rc02').contextoDepois.convidados, l('rc02').contextoDepois.tema], ['2026-11-21', 80, null]);
  // Mês novo: nada consultado antes do dia; depois, o dia no mês novo.
  assert.deepEqual(l('rc04').consultasDetalhe.filter((c) => c.fonte === 'preco'), []);
  assert.ok(l('rc05').consultasDetalhe.some((c) => c.fonte === 'preco' && c.args[1] === '2027-01-09'));
  assert.deepEqual(l('rc07').consultasDetalhe.filter((c) => c.fonte === 'disponibilidade'), []);
  // Confirmação: o "sim" ao valor não confirma; a troca exige nova confirmação; a passagem vai com a data nova.
  assert.match(l('rc10').resposta, /confirme a data: sábado, 05\/12\/2026/);
  assert.match(l('rc11').resposta, /confirme a data: sábado, 12\/12\/2026/);
  assert.ok(l('rc12').consultasDetalhe.some((c) => c.fonte === 'disponibilidade' && c.args[0] === '2026-12-12'));
  assert.ok(l('rc15').bloqueada && l('rc15').motivos.includes('RECLAMACAO') && l('rc15').saidas.length === 0, String(l('rc15').motivos));
  assert.ok(!l('rc16').motivos.includes('RECLAMACAO'));
});

test('holdout 27 (regressão, pendências): "vença", "horinha", "entrada" que não é sinal e oferta "pago X… topa?"', async () => {
  const linhas = await simular('corpus-holdout-27-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.match(l('aa06').resposta, /Cláusula 7/);
  assert.match(l('aa05').resposta, /Cláusula 8/);
  assert.equal(l('aa05').decisao, 'RESPONDER');
  assert.doesNotMatch(l('aa30').resposta, /cláusula de sinal/);
  assert.ok(l('aa28').motivos.includes('NEGOCIACAO'));
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.irrelevantes.map((x) => x.id), []);
});

const metricasInstrucao = (linhas) => { const m = calcularMetricas(linhas).instrucoes; return `${m.reconhecidas}/${m.casos}`; };

test('holdout 3 (regressão): pedido formal de exclusão bloqueia; instrução reconhecida e nunca obedecida; bolo de fora com a equipe', async () => {
  const linhas = await simular('corpus-holdout-3-20261005.json');
  const t16 = linhas.find((x) => x.id === 't16');
  assert.equal(t16.decisao, 'PARAR');
  assert.equal(t16.bloqueada, true);
  const metricas = calcularMetricas(linhas);
  assert.equal(metricas.instrucoes.reconhecidas, metricas.instrucoes.casos, JSON.stringify(metricas.instrucoes.naoReconhecidas));
  assert.deepEqual(metricas.instrucoes.violacoes, []);
  const t44 = linhas.find((x) => x.id === 't44');
  assert.equal(t44.decisao, 'EQUIPE');
  assert.match(t44.resposta, /Sobre bolo de fora: ainda não tenho essa regra cadastrada/);
});

test('holdout 28 (regressão): ofertas "te passo X"/"meu teto é X", parar com "afff… de novo??", "já marquei com vcs", "nova política da empresa", "caso vença", tema e capacidade', async () => {
  const linhas = await simular('corpus-holdout-28-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  for (const id of ['aa03', 'aa16']) assert.ok(l(id).motivos.includes('NEGOCIACAO'), id);
  assert.ok(l('aa11').bloqueada && l('aa11').motivos.includes('RECLAMACAO') && l('aa11').saidas.length === 0, String(l('aa11').motivos));
  assert.ok(l('aa26').motivos.includes('CONTRATO_PROPRIO'));
  assert.ok(l('aa44').motivos.includes('INSTRUCAO_SUSPEITA'));
  assert.equal(l('aa17').decisao, 'RESPONDER');
  assert.match(l('aa17').resposta, /Cláusula 7/);
  assert.match(l('aa77').resposta, /Anotei o tema “dinossauro”/);
  assert.match(l('aa51').resposta, /80 a 150 convidados e tem 5 horas de festa/);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.perguntasDesnecessarias?.map((x) => x.id) ?? [], []);
});

test('holdout 29 (regressão): "tenho X… com esse valor", regra anunciada, irritação no parar misto, pausa "mais pra frente", "combinamos", entrada dos convidados e "mudamos pra Sonic"', async () => {
  const linhas = await simular('corpus-holdout-29-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('aa33').motivos.includes('NEGOCIACAO'));
  for (const id of ['aa36', 'aa05', 'aa21']) assert.ok(l(id).motivos.includes('INSTRUCAO_SUSPEITA'), id);
  assert.ok(l('aa19').motivos.includes('RECLAMACAO') && !l('aa19').bloqueada);
  assert.ok(!l('aa79').bloqueada && l('aa79').saidas.length === 0, 'pausa, não bloqueio');
  assert.ok(l('aa20').motivos.includes('CONTRATO_PROPRIO'));
  assert.doesNotMatch(l('aa23').resposta, /cláusula de sinal/);
  assert.match(l('aa28').resposta, /Anotei o tema “Sonic”/);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(m.irrelevantes.map((x) => x.id), []);
});

test('holdout 30 (regressão): alergia indireta, "tinha combinado", taxa "zerada" pela gerente, troca de unidade e tema sem "entre/ou"', async () => {
  const linhas = await simular('corpus-holdout-30-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  assert.ok(l('aa13').motivos.includes('RESTRICAO_ALIMENTAR'));
  assert.ok(l('aa29').motivos.includes('CONTRATO_PROPRIO'));
  assert.ok(l('aa08').motivos.includes('INSTRUCAO_SUSPEITA'));
  assert.match(l('aa63').resposta, /Águas Claras/);
  assert.doesNotMatch(l('aa63').resposta, /Asa Sul: /);
  assert.equal(l('aa75').decisao, 'PERGUNTAR');
  for (const id of ['aa76', 'aa77']) assert.match(l(id).resposta, /Anotei o tema/, id);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
});

test('holdout 31 (regressão): afirmação de condição nova + pedido de aplicar (instrução), valor por extenso e "se vcs fecharem" (negociação); régua sem o falso positivo do aa41', async () => {
  const linhas = await simular('corpus-holdout-31-20261007.json');
  const l = (id) => linhas.find((x) => x.id === id);
  for (const id of ['aa25', 'aa27', 'aa29']) { assert.deepEqual(l(id).motivos, ['INSTRUCAO_SUSPEITA'], id); assert.doesNotMatch(l(id).resposta, /R\$|tabela|Cláusula/, id); }
  for (const id of ['aa33', 'aa34']) assert.ok(l(id).motivos.includes('NEGOCIACAO'), id);
  const m = calcularMetricas(linhas);
  for (const c of m.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.equal(m.instrucoes.reconhecidas, m.instrucoes.casos);
});
