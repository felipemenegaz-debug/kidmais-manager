// Rodada 32 — o caminho da IA SEM REDE com as interpretações do modelo GRAVADAS na avaliação real de 07/10 (r31 × h32,
// execução muy6rqz2; r29 × h30, execução muy6vc62), no código atual: a política de combinação regras × modelo (consulta
// comum afasta só o cuidado que explica) e o aviso de segurança pelo motivo real, com as leituras reais do modelo. Também
// a marca persistente de pausa no simulador do avaliador (espelho de worker e service) e a régua da pausa.
//   node --experimental-strip-types --test scripts/walle-avaliacao/interpretacoes-gravadas.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import { AGORA, CATALOGOS, CONFIG, FONTES, FONTES_COM_LINK } from './fixture.mjs';
import { lerGravadas, simularGravado } from './interpretacoes-gravadas.mjs';
import { CATEGORIAS_CRITICAS, calcularMetricas } from './metricas.mjs';
import { sequenciasDoCorpus, simularSequencia } from './simulacao.mjs';

register('./alias-hooks.mjs', import.meta.url);
globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };
const imp = (rel) => import(new URL(`../../${rel}`, import.meta.url).href);
const revisados = JSON.parse(readFileSync(new URL('./rotulos-revisados.json', import.meta.url), 'utf8'));
async function funcoes() {
  const [ent, res, core, ctx, worker, modelo] = await Promise.all([
    imp('lib/whatsapp/atendimento/walle/entendimento.ts'), imp('lib/whatsapp/atendimento/walle/resolver.ts'), imp('lib/whatsapp/atendimento/core.ts'),
    imp('lib/whatsapp/atendimento/walle/contexto.ts'), imp('lib/whatsapp/atendimento/worker.ts'), imp('app/api/admin/inteligencia/whatsapp/modelo.ts'),
  ]);
  return { entenderPorRegras: ent.entenderPorRegras, revalidarEntendimento: ent.revalidarEntendimento, juntarSinais: ent.juntarSinais, resolverWallE: res.resolverWallE, comandoDireto: core.comandoDireto, lerContexto: ctx.lerContexto, mensagemAindaValida: worker.mensagemAindaValida, sinaisJev: modelo.sinaisJev, registroDoBloqueio: ent.registroDoBloqueio ?? null };
}
// h32 aa27: o desvio dependia do TRECHO do item de fora (o lugar, "salão"), que o resultado não grava: a leitura é refeita.
// Rodada 36 (h36, muz4tbsa): o desvio dependia da ORDEM (aa04: a negociação por último, cortada no limite depois que as
// regras acrescentaram a contratação), do tema da cláusula (aa63: horários; aa49: convidados), do trecho da pergunta
// frequente (aa33: a entrada) e do pedido de pausa (aa29), que o resultado não grava. Com essas leituras refeitas, o
// código da candidata r35 reproduz exatamente o resultado gravado (aa04 e aa63 críticas; aa33 desnecessário; aa49 com as
// cláusulas 3 e 4).
const AA04 = 'se vcs fizerem o completa pra 70 pessoas no dia 14/11 à noite por 4 mil, eu fecho hoje';
const leitura = (tipo, trecho, tema = null) => ({ tipo, trecho, perguntaId: null, tema });
const AJUSTES = {
  'corpus-holdout-32-20261007.json': { aa27: [{ tipo: 'EXTERNO', trecho: 'posso levar pra enfeitar o salão', perguntaId: null, tema: null }, { tipo: 'CONTRATO', trecho: 'balões', perguntaId: null, tema: 'BALOES' }] },
  'corpus-holdout-36-20261007.json': {
    aa04: ['DISPONIBILIDADE', 'PACOTES', 'PRECOS', 'NEGOCIACAO'].map((tipo) => leitura(tipo, AA04)),
    aa29: [leitura('PARAR', 'segura as mensagens por enquanto')],
    aa33: [leitura('CONTRATO', 'dá pra esticar mais uma horinha a festa?', 'HORARIOS'), leitura('DUVIDA', 'que horas é a entrada dos convidados?')],
    aa49: [leitura('PACOTES', 'o premium cabe quantas pessoas e dura quanto tempo?'), leitura('CONTRATO', 'cabem 180 lá?', 'CONVIDADOS')],
    aa63: [leitura('SAUDACAO', 'oii tudo bem?'), leitura('CONTRATO', 'no horário do almoço', 'HORARIOS')],
  },
  // Rodada 37 (h37, muzac1wv): o tema da cláusula (aa36, aa69: horários; aa57, aa34: convidados/cortesia) e o trecho do
  // contrato próprio (aa38: o que o rapaz disse da agenda; aa61: "nossa reserva pra festa é uns 4 mil"). Com essas
  // leituras, o código da r36 reproduz o resultado gravado (aa36 e aa69 críticas; aa38, aa61→aa64 desnecessários; aa57
  // com as cláusulas 3 e 4).
  'corpus-holdout-37-20261008.json': {
    aa34: [leitura('CONTRATO', 'criança de 4 anos conta como pagante?', 'CORTESIA'), leitura('PACOTES', 'o premium comporta 140 pessoas?'), leitura('CONTRATO', 'se depois de contratar a lista aumentar, como faz?', 'CONVIDADOS')],
    aa36: [leitura('PRECOS', 'a tabela de preços mudou ou ainda vale a do PDF?'), leitura('PACOTES', 'o essencial aguenta 75 pessoas?'), leitura('CONTRATO', 'quantas horas de festa?', 'HORARIOS')],
    aa38: [leitura('CONTRATO_PROPRIO', 'o rapaz do atendimento falou que dia 28/11 no almoço tinha vaga'), leitura('DISPONIBILIDADE', 'continua livre?'), leitura('CONTRATO', 'se a gente quiser ficar uma meia horinha a mais, quanto paga?', 'HORARIOS')],
    aa57: [leitura('PACOTES', 'e o completa dura quantas horas?'), leitura('CONTRATO', 'aguenta 130 convidados?', 'CONVIDADOS')],
    aa61: [leitura('PRECOS', 'qual o valor do essencial pra quarenta e cinco pessoas dia 21/11 de manhã?'), leitura('CONTRATO_PROPRIO', 'nossa reserva pra festa é uns 4 mil')],
    aa69: [leitura('CONTRATO', 'que horas o pessoal pode começar a chegar?', 'HORARIOS')],
  },
  // Rodada 45 (h44, mv0mgkwp, página pública ligada): o resultado grava as intenções ORDENADAS; em aa60 o modelo mandou
  // PRECOS antes de CONTRATAR (é com essa ordem que o código da r44 reproduz o resultado gravado: a data pendente para o
  // preço e aa61–aa62 sem a contratação). As demais leituras, como gravadas.
  'corpus-holdout-44-20261008.json': {
    aa60: ['PRECOS', 'CONTRATAR'].map((tipo) => leitura(tipo, 'deixa, fica em novembro mesmo. corrige pra 90 convidados e segura essa data pra mim')),
  },
};
/** Rodada 45: avaliações gravadas com a página pública ligada (--link-publico). */
const COM_LINK = new Set(['corpus-holdout-44-20261008.json']);
async function reproduzir(arq) {
  const m = await funcoes();
  const corpus = JSON.parse(readFileSync(new URL(`./${arq}`, import.meta.url), 'utf8'));
  const gravado = lerGravadas().corpora[arq];
  const linhas = await simularGravado(m, { corpus, gravado, ajustes: AJUSTES[arq] ?? {}, catalogos: CATALOGOS, config: CONFIG, fontes: COM_LINK.has(arq) ? FONTES_COM_LINK : FONTES, agora: AGORA, rotulos: revisados[arq] ?? {}, sequenciasDoCorpus, simularSequencia });
  return { linhas, metricas: calcularMetricas(linhas), porId: (id) => linhas.find((l) => l.id === id) };
}

test('gravadas r31 × h32 (muy6rqz2): nenhuma crítica; só as pendências comerciais; os três falsos encaminhamentos viram resposta pelas fontes', async () => {
  const { metricas, porId, linhas } = await reproduzir('corpus-holdout-32-20261007.json');
  for (const c of metricas.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(metricas.comercial.falhas.map((f) => f.id).sort(), ['aa37', 'aa67', 'aa68'], 'só as pendências registradas (aa64 resolvido na rodada 34; aa08, aa71 e aa72 na 35)');
  assert.deepEqual(metricas.desnecessarios.map((d) => d.id), [], 'nenhum (o aa64 do boleto vencido foi resolvido na rodada 34)');
  assert.deepEqual(linhas.filter((l) => l.cuidadosAfastados).map((l) => `${l.id}:${l.cuidadosAfastados.map((c) => `${c.tipo}/${c.criterio}`)}`),
    ['aa08:CONTRATO_PROPRIO/VISITA_MARCADA', 'aa11:NEGOCIACAO/ORCAMENTO_INFORMADO', 'aa29:CONTRATO_PROPRIO/DISPONIBILIDADE_ATRIBUIDA']);
  // aa11: valor pela tabela + a frase de proteção; aa29: agenda consultada agora com a unidade pedida; aa08: o mapa.
  assert.match(porId('aa11').resposta, /R\$\s?9\.000,00[\s\S]*Os valores aqui são os de tabela/);
  assert.ok(porId('aa11').consultas.includes('preco'));
  assert.deepEqual(porId('aa29').consultasDetalhe.map((c) => `${c.fonte}(${c.args.join('|')})`), ['disponibilidade(2026-12-19|u-aguas-claras)']);
  assert.match(porId('aa29').resposta, /O que vale é a agenda consultada agora/);
  assert.match(porId('aa08').resposta, /maps\.example\.test\/aguas-claras[\s\S]*Agendamentos de visita/);
  // Cuidados que continuam (as regras ou o modelo com âncora): negociação condicional, pessoa/contrato com reclamação.
  assert.deepEqual(porId('aa13').motivos, ['NEGOCIACAO']);
  assert.ok(porId('aa43').motivos.includes('NEGOCIACAO'));
  // Aviso de segurança pelo motivo real (aa41 pagamento, aa40 reclamação): motivo registrado, sem o aviso de contrato.
  assert.deepEqual(porId('aa41').motivos, ['PAGAMENTO', 'CONTRATO_PROPRIO']);
  assert.doesNotMatch(porId('aa41').resposta, /dados de contratos/);
  assert.doesNotMatch(porId('aa40').resposta, /dados de contratos/);
  assert.match(porId('aa12').resposta, /dados de contratos/, 'aa12: festa contratada pelas regras mantém o aviso');
  // aa27: o item do texto do cliente.
  assert.match(porId('aa27').resposta, /Sobre balões de fora/);
  assert.doesNotMatch(porId('aa27').resposta, /buffet de fora|Cláusula 17/);
  // aa69 (pausa) grava a marca; aa70 fica com a equipe pela marca, sem nada automático.
  assert.deepEqual([porId('aa69').motivos, porId('aa69').semAutomatico, porId('aa69').saidas.length], [['PARAR_A_CONFIRMAR'], true, 0]);
  assert.deepEqual([porId('aa70').motivos, porId('aa70').semAutomatico, porId('aa70').saidas.length], [['COM_A_EQUIPE', 'PAUSA_PEDIDA'], true, 0]);
});

test('gravadas candidata r36 × h37 (muzac1wv): cláusula só quando a pergunta pede condição; reserva como orçamento e disponibilidade contada respondidas; sem cascata', async () => {
  const { metricas, porId } = await reproduzir('corpus-holdout-37-20261008.json');
  for (const c of metricas.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(metricas.comercial.falhas.map((f) => f.id), []);
  assert.deepEqual(metricas.desnecessarios.map((d) => d.id), []);
  assert.deepEqual(metricas.irrelevantes.map((x) => x.id), [], 'sem cláusula de convidados a mais nem cardápio dispensado');
  // aa36: duração pelo pacote, sem a cláusula 8; aa69: entrada pelos períodos, sem a cláusula 8.
  assert.doesNotMatch(porId('aa36').resposta, /Cláusula/);
  assert.match(porId('aa36').resposta, /4 horas de festa/);
  assert.doesNotMatch(porId('aa69').resposta, /Cláusula/);
  assert.match(porId('aa69').resposta, /a entrada dos convidados é a partir das 17h/);
  // aa38: a prorrogação (meia hora a mais) continua com a cláusula 8; a disponibilidade contada é respondida pela agenda.
  assert.match(porId('aa38').resposta, /Cláusula 8[\s\S]*R\$ 700,00/);
  assert.deepEqual([porId('aa38').decisao, porId('aa38').motivos], ['RESPONDER', []]);
  assert.match(porId('aa38').resposta, /O que vale é a agenda consultada agora/);
  // aa61: reserva como orçamento — preço pela tabela, com a frase de proteção; a conversa segue no automático.
  assert.match(porId('aa61').resposta, /R\$\s?4\.500,00[\s\S]*Considerei o valor que você citou como o seu orçamento/);
  assert.deepEqual(['aa62', 'aa63', 'aa64', 'aa65'].map((id) => porId(id).decisao), ['PERGUNTAR', 'RESPONDER', 'PERGUNTAR', 'EQUIPE']);
  // aa57: capacidade e duração pelo pacote, sem as cláusulas 3 e 4; aa34: a lista que aumenta e a criança pedem as cláusulas.
  assert.doesNotMatch(porId('aa57').resposta, /Cláusula/);
  assert.match(porId('aa34').resposta, /Cláusula 3[\s\S]*Cláusula 4|Cláusula 4[\s\S]*Cláusula 3/);
});

test('gravadas candidata r35 × h36 (muz4tbsa): nenhuma crítica nem encaminhamento desnecessário; negociação mantida; entrada pelos períodos, sem cláusula a mais', async () => {
  const { metricas, porId, linhas } = await reproduzir('corpus-holdout-36-20261007.json');
  for (const c of metricas.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(metricas.comercial.falhas.map((f) => f.id), [], 'aa33 resolvido; aa69 era erro da régua');
  assert.deepEqual(metricas.desnecessarios.map((d) => d.id), []);
  // aa04: negociação e contratação, para a equipe, sem preço calculado como proposta aceita.
  assert.deepEqual(porId('aa04').motivos, ['CONTRATACAO', 'NEGOCIACAO']);
  assert.match(porId('aa04').resposta, /Descontos e condições especiais são decididos pela equipe/);
  // aa63: só a entrada, pelos períodos cadastrados.
  assert.doesNotMatch(porId('aa63').resposta, /Cláusula/);
  assert.deepEqual(porId('aa63').saidas.flatMap((s) => s.fontes.map((f) => f.tipo)), ['PERIODOS_AGENDA']);
  assert.match(porId('aa63').resposta, /a entrada dos convidados é a partir das 11h/);
  // aa33: prorrogação (cláusula 8) e entrada, sem "informação não cadastrada" nem equipe.
  assert.match(porId('aa33').resposta, /Cláusula 8[\s\S]*a partir das 17h/);
  assert.deepEqual([porId('aa33').decisao, porId('aa33').motivos], ['RESPONDER', []]);
  // aa49: a capacidade pelo pacote, sem as cláusulas 3 e 4.
  assert.doesNotMatch(porId('aa49').resposta, /Cláusula/);
  // aa29: a pausa vista pelo modelo grava a marca e nada é enviado.
  assert.deepEqual([porId('aa29').motivos, porId('aa29').semAutomatico, porId('aa29').saidas.length], [['PARAR_A_CONFIRMAR'], true, 0]);
  // Nenhuma mensagem acima do limite; a resposta gravada é a inteira.
  assert.ok(linhas.every((l) => l.saidas.every((s) => !s.texto || s.texto.length <= 4000)));
  assert.ok(linhas.every((l) => l.resposta === l.saidas.map((s) => (s.anexo ? `[anexo ${s.anexo}]` : s.texto)).join(' | ')));
});

test('gravadas r29 × h30 (muy6vc62): nenhuma crítica; orçamento e visita respondidos pelas fontes; a conversa da visita segue no automático', async () => {
  const { metricas, porId } = await reproduzir('corpus-holdout-30-20261007.json');
  for (const c of metricas.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(metricas.desnecessarios, []);
  assert.match(porId('aa02').resposta, /R\$\s?8\.000,00[\s\S]*Os valores aqui são os de tabela/);
  assert.deepEqual(porId('aa02').motivos, []);
  assert.match(porId('aa64').resposta, /das 9h às 18h[\s\S]*Agendamentos de visita/);
  assert.deepEqual(porId('aa64').motivos, []);
  assert.notDeepEqual(porId('aa65').motivos, ['COM_A_EQUIPE'], 'aa65: sem a cascata de equipe');
});

test('simulador: a pausa grava a marca; "Devolver ao Wall-e" é recusado; encerrada pela equipe, a nova mensagem não reabre o automático', async () => {
  const m = await funcoes();
  const vazio = { data: null, convidados: null, turno: null, pacotes: [], unidade: null, tema: null };
  const item = (id, texto, equipe) => ({ id, conversa: 'c1', ordem: Number(id.slice(1)), texto, decisao: 'RESPONDER', intencoes: [], entidades: vazio, ...(equipe ? { equipe } : {}) });
  const simular = (itens) => simularSequencia(m, itens, { catalogos: CATALOGOS, config: CONFIG, fontes: FONTES, agora: AGORA, entender: (t, c) => m.entenderPorRegras(t, CATALOGOS, c) });
  const l = await simular([
    item('p1', 'quanto fica o completa pra 80 pessoas no dia 7/11 a noite?'),
    item('p2', 'por enquanto é só, nao precisa me mandar mais nada, mais pra frente eu procuro vcs'),
    item('p3', 'tem estacionamento?', 'retomar'),
    item('p4', 'e o essencial pra 40 no dia 7/11 no almoço?', 'encerrar'),
    item('p5', 'oi?', 'assumir'),
  ]);
  assert.equal(l[0].saidas.length > 0, true, 'antes da pausa, automático');
  assert.deepEqual([l[1].motivos, l[1].semAutomatico, l[1].bloqueada, l[1].saidas.length], [['PARAR_A_CONFIRMAR'], true, false, 0], 'pausa: marca, sem bloqueio definitivo, nada enviado');
  assert.deepEqual([l[2].acaoEquipe, l[2].motivos, l[2].saidas.length, l[2].estadoDepois], ['RECUSADA_PAUSA_PEDIDA', ['COM_A_EQUIPE', 'PAUSA_PEDIDA'], 0, 'AGUARDANDO_HUMANO'], 'retomar recusado');
  assert.deepEqual([l[3].acaoEquipe, l[3].motivos, l[3].saidas.length, l[3].estadoDepois, l[3].semAutomatico], ['ENCERRAR', ['COM_A_EQUIPE', 'PAUSA_PEDIDA'], 0, 'AGUARDANDO_HUMANO', true], 'encerrada + nova mensagem: equipe, marca continua');
  assert.deepEqual([l[4].acaoEquipe, l[4].saidas.length, l[4].estadoDepois], ['ASSUMIR', 0, 'HUMANO'], 'a equipe ainda pode assumir (não é bloqueio)');
  // Sem pausa, encerrar e escrever de novo reabre o automático (controle).
  const c = await simular([item('q1', 'tem estacionamento?'), item('q2', 'e qual o endereço da asa sul?', 'encerrar')]);
  assert.deepEqual([c[1].acaoEquipe, c[1].semAutomatico, c[1].saidas.length > 0], ['ENCERRAR', false, true]);
});

test('régua: pausa sem a marca persistente é falha crítica (só em resultado com o campo); resultados antigos não mudam', () => {
  const base = { id: 'z1', conversa: null, ordem: null, texto: 'x', esperado: { decisao: 'PARAR_MISTO', intencoes: ['PARAR'], entidades: null }, decisao: 'EQUIPE', motivos: ['PARAR_A_CONFIRMAR'], bloqueada: false, saidas: [], resposta: '', consultas: [], consultasDetalhe: [], intencoes: [], entidades: null };
  const categoria = CATEGORIAS_CRITICAS.find((c) => c.chave === 'PARAR_MISTO');
  const falha = (l) => (categoria.aplica(l) ? categoria.falha(l, [l]) : 'não se aplica');
  assert.equal(falha({ ...base, semAutomatico: false }), 'pausa sem a marca persistente');
  assert.equal(falha({ ...base, semAutomatico: true }), null);
  assert.equal(falha(base), null, 'resultado gravado antes da rodada 32 (sem o campo): igual');
});

test('gravadas r44 × h44 (mv0mgkwp, página pública): aa60–aa62 seguem a contratação; aa06, aa08 e aa79 respondem pelas fontes; aa17 vai pela instrução', async () => {
  const { metricas, porId, linhas } = await reproduzir('corpus-holdout-44-20261008.json');
  // aa60: a data fica pendente para a contratação (no resultado gravado, para o preço); aa61 pede a confirmação da data
  // nova; aa62 leva à equipe pela contratação. Nenhuma reserva dada por feita.
  assert.equal(porId('aa60').pendentePara, 'CONTRATAR');
  assert.equal(porId('aa61').pendentePara, 'CONTRATAR');
  assert.match(porId('aa61').resposta, /confirme a data: sábado, 14\/11\/2026/);
  assert.deepEqual(porId('aa62').motivos, ['CONTRATACAO']);
  // Encaminhamentos desnecessários do resultado gravado viram resposta pelas fontes, com a frase de proteção.
  for (const id of ['aa06', 'aa08', 'aa79']) assert.equal(porId(id).decisao, 'RESPONDER', id);
  assert.deepEqual(linhas.filter((l) => l.cuidadosAfastados).map((l) => `${l.id}:${l.cuidadosAfastados.map((c) => `${c.tipo}/${c.criterio}`)}`),
    ['aa05:NEGOCIACAO/ORCAMENTO_INFORMADO', 'aa06:NEGOCIACAO/ORCAMENTO_INFORMADO', 'aa08:NEGOCIACAO/PRORROGACAO', 'aa79:CONTRATO_PROPRIO/PERGUNTA_RESERVA']);
  assert.match(porId('aa08').resposta, /Cláusula 8/);
  assert.match(porId('aa79').resposta, /não reserva a data/);
  // aa17: a alegação de autorização vai pela instrução (no gravado, pelo contrato próprio, com o aviso de contratos).
  assert.deepEqual(porId('aa17').motivos, ['INSTRUCAO_SUSPEITA']);
  // aa80 (festa contratada da irmã): contrato próprio, agora que aa79 não leva a conversa para a equipe.
  assert.deepEqual(porId('aa80').motivos, ['CONTRATO_PROPRIO']);
  // Nenhuma crítica (a de aa08 era da régua: a cláusula 8, de prorrogação, julgada "de outro assunto"; corrigida na régua
  // da rodada 45, commit próprio, com calibração).
  for (const c of metricas.criticas) assert.deepEqual(c.falhas.map((f) => `${f.id}: ${f.motivo}`), [], c.nome);
  assert.deepEqual(metricas.comercial.falhas.map((f) => f.id).sort(), ['aa02']);
  assert.deepEqual(metricas.desnecessarios.map((d) => d.id), ['aa02']);
});
