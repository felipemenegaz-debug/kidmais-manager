// Avaliação do Wall-e (v4) num corpus HOLDOUT, com o caminho real da conversa simulado sem banco (simulacao.mjs):
// recepção (PARAR bloqueia), worker (só responde com a conversa liberada) e Wall-e. Mede SEPARADAMENTE acertos
// comerciais, falhas críticas por categoria, encaminhamentos desnecessários, custo e latência (metricas.mjs).
// Fontes oficiais SINTÉTICAS em memória (fixture.mjs). Resultados em scripts/walle-avaliacao/resultados/v4/; os
// anteriores (resultados/, v2/, v3/) não são tocados. Em IA real, cada chamada é reservada e fechada no LIVRO ÚNICO de
// uso (livro-uso-ia.mjs, fora das worktrees): o teto do dia vale para avaliadores e demonstrações juntos.
//
//   regras          entendimento pelas regras locais; toda chamada de rede é recusada (guarda-rede.mjs).
//   ia              entendimento pelo roteador real (INTERPRETAR_CONVERSA, ECONOMY, gpt-6-luna) com o modelo, os preços e o
//                   teto JÁ AUTORIZADOS (IA_AUTORIZADA; --teto-usd/--teto-tokens só reduzem) e registro de uso em memória;
//                   rede só https://api.openai.com/v1/. Só por comparar-ia.ps1/avaliar-ia.ps1 (chave em prompt oculto).
//   ia --simular    o mesmo caminho com um provedor FALSO local (sem rede, chave fictícia): ensaio da medição.
//   --codigo <raiz> avalia o código de outro checkout (ex.: a versão "antes"); --versao dá o rótulo (antes/depois).
//   --sha-exigido <sha> recusa se o HEAD do código avaliado for outro. Todo resultado registra o SHA exato (git.sha) e se
//                   a árvore tinha alterações rastreadas (git.alterada); IA REAL com árvore alterada é recusada.
//
// node --experimental-strip-types --no-warnings --import ./scripts/walle-avaliacao/registrar.mjs scripts/walle-avaliacao/avaliar.mjs regras --corpus scripts/walle-avaliacao/corpus-holdout-2-20261005.json
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { criarFetchProtegido } from './guarda-rede.mjs';
import { AGORA, CATALOGOS, CONFIG, EMPRESA, FONTES, FONTES_COM_LINK, HOJE } from './fixture.mjs';
import { caminhoLivro, consumoDoDia, exigirLivro, registroComLivro, TETO } from './livro-uso-ia.mjs';
import { calcularMetricas, markdown } from './metricas.mjs';
import { sequenciasDoCorpus, simularSequencia } from './simulacao.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raizPadrao = path.resolve(aqui, '..', '..');
const args = process.argv.slice(2);
const opcao = (nome, padrao = null) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : padrao; };
const modo = args[0];
const simular = args.includes('--simular');
// Rodada 41: --link-publico liga a página pública sintética (o Wall-e pode enviar o link); sem ela, como antes.
const linkPublico = args.includes('--link-publico');
const corpusArq = path.resolve(opcao('--corpus', path.join(aqui, 'corpus-holdout-20261005.json')));
const codigo = path.resolve(opcao('--codigo', raizPadrao));
const versao = opcao('--versao', codigo === raizPadrao ? 'depois' : 'antes');
if (modo !== 'regras' && modo !== 'ia') { console.error('uso: avaliar.mjs regras|ia [--simular] [--corpus arquivo] [--codigo raiz] [--versao rótulo] [--teto-usd n] [--teto-tokens n]'); process.exit(2); }
if (simular && modo !== 'ia') { console.error('--simular só no modo ia'); process.exit(2); }
if (!/^[a-z0-9-]{1,20}$/.test(versao)) { console.error('--versao inválida'); process.exit(2); }

// Sem banco: nada aqui lê ou grava PostgreSQL. Uma DATABASE_URL presente é recusada (fail closed).
if (process.env.DATABASE_URL) { console.error('Recusado: DATABASE_URL presente. A avaliação não usa banco.'); process.exit(2); }

// SHA exato do código avaliado. Alterações rastreadas tornam o resultado não reproduzível; next-env.d.ts e tsconfig.json
// (reescritos pelo next dev de uma demo no ar) não entram no caminho avaliado e só são anotados.
const IGNORADOS_GIT = ['next-env.d.ts', 'tsconfig.json'];
function estadoGit(raiz) {
  try {
    const g = (...a) => execFileSync('git', ['-C', raiz, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const alterados = g('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).map((l) => l.slice(3));
    return { sha: g('rev-parse', 'HEAD').trim(), branch: g('rev-parse', '--abbrev-ref', 'HEAD').trim(), alterada: alterados.some((f) => !IGNORADOS_GIT.includes(f)),
      alterados: alterados.filter((f) => !IGNORADOS_GIT.includes(f)), ignorados: alterados.filter((f) => IGNORADOS_GIT.includes(f)) };
  } catch { return { sha: null, branch: null, alterada: true, alterados: ['(git indisponível)'], ignorados: [] }; }
}
const git = estadoGit(codigo);
const shaExigido = opcao('--sha-exigido');
if (shaExigido && git.sha !== shaExigido) { console.error(`Recusado: HEAD ${git.sha} diferente do SHA exigido ${shaExigido}.`); process.exit(2); }
if (modo === 'ia' && !simular && git.alterada) { console.error(`Recusado: IA real com alterações não commitadas (${git.alterados.join(', ')}); o resultado não teria SHA exato.`); process.exit(2); }

/** Modelo, preços e teto já autorizados para o modo IA da demonstração (iguais a $IA_DEMO em demo.ps1). */
export const IA_AUTORIZADA = Object.freeze({
  INTELIGENCIA_ENABLED: 'true', AI_OPENAI_BASE_URL: 'https://api.openai.com/v1', AI_WORKLOAD_TIERS: '{"FAQ":"ECONOMY","INTERPRETAR_CONVERSA":"ECONOMY"}',
  AI_PROVIDER_PRIMARY: 'OPENAI', AI_PROVIDER_ECONOMY: 'OPENAI', AI_OPENAI_MODEL_ECONOMY: 'gpt-6-luna',
  AI_OPENAI_REASONING_EFFORT_ECONOMY: 'none', AI_FALLBACK_ENABLED: 'false', AI_MODEL_MAX_RETRIES: '0', AI_MODEL_TIMEOUT_MS: '15000',
  AI_PRICING_JSON: '{"moeda":"USD","modelos":{"OPENAI:gpt-6-luna":{"entrada":0.10,"saida":0.50,"cache":0.01}}}',
  AI_BUDGET_JSON: '{"moeda":"USD","porEmpresa":{"tokensDiario":300000,"custoDiario":0.20,"tokensMensal":300000,"custoMensal":0.20},"porCapacidade":{"whatsapp_atendimento":{"tokensDiario":300000,"custoDiario":0.20}}}',
});
/**
 * Uso de hoje pelo LIVRO ÚNICO (todas as worktrees, avaliadores e demonstrações): saldos anteriores ao livro, chamadas
 * fechadas pelo real, chamadas no ar e cotas abertas pelo máximo, e o consumo lido das demonstrações que não usam o livro.
 */
function usoDeHoje() { const c = consumoDoDia(); return { tokens: c.tokens, usd: c.usd, emAberto: c.emAberto.length, existe: existsSync(caminhoLivro()) }; }
/** Teto desta execução: o autorizado menos o já usado hoje (e menos ainda, se pedido); nunca aumentado. */
function orcamentoDaExecucao(mensagens) {
  const b = JSON.parse(IA_AUTORIZADA.AI_BUDGET_JSON);
  // Ensaio simulado: provedor falso, sem rede, NADA reservado nem gasto no livro; o teto é só o do processo (em memória).
  // O uso REAL de hoje no livro é mostrado mesmo assim, para a mensagem nunca sugerir que o teto do dia está livre.
  // Rodada paga: o livro único precisa existir e nenhum livro antigo do AppData pode estar em uso (ver livro-uso-ia.mjs).
  if (!simular) { try { exigirLivro(); } catch (erro) { console.error(`Recusado: ${erro.message}`); process.exit(3); } }
  const real = usoDeHoje();
  const usado = simular ? { tokens: 0, usd: 0, emAberto: 0 } : real;
  // O teto do livro é o mesmo autorizado; --teto-usd/--teto-tokens só reduzem.
  const usd = +Math.min(Math.min(b.porEmpresa.custoDiario, TETO.usd) - usado.usd, Number(opcao('--teto-usd', b.porEmpresa.custoDiario))).toFixed(6);
  const tokens = Math.floor(Math.min(Math.min(b.porEmpresa.tokensDiario, TETO.tokens) - usado.tokens, Number(opcao('--teto-tokens', b.porEmpresa.tokensDiario))));
  // Medido: ~900–1.050 tokens por mensagem; as chamadas são em sequência (uma reserva aberta por vez, ~1.500). Conta
  // conservadora: 1.200 por mensagem + 2.000 de folga. Rodada que não cabe inteira nem começa (sem medição pela metade).
  if (!(usd > 0) || tokens < mensagens * 1200 + 2000) { console.error(`Recusado: o teto de hoje não comporta esta rodada (usado hoje no livro único: ${usado.tokens} tokens, US$ ${usado.usd.toFixed(5)}, ${usado.emAberto} em aberto; restam ${Math.max(0, tokens)} tokens para ${mensagens} mensagens).`); process.exit(3); }
  if (simular) console.error(`Ensaio SIMULADO (provedor falso local, sem rede): nada é reservado nem gasto no livro único; teto do ensaio, só em memória: ${tokens} tokens. ${real.existe ? `Uso REAL de hoje no livro: ${real.tokens} tokens, US$ ${real.usd.toFixed(5)}, ${real.emAberto} em aberto (restam ${Math.max(0, TETO.tokens - real.tokens)} tokens para rodadas reais).` : `Livro único AUSENTE em ${caminhoLivro()}: nenhuma rodada real é permitida até criar ou migrar.`}`);
  else console.error(`Teto desta rodada: ${tokens} tokens e US$ ${usd} (usado hoje no livro único antes dela: ${usado.tokens} tokens, US$ ${usado.usd.toFixed(5)}, ${usado.emAberto} em aberto).`);
  return JSON.stringify({ moeda: 'USD', porEmpresa: { tokensDiario: tokens, custoDiario: usd, tokensMensal: tokens, custoMensal: usd }, porCapacidade: { whatsapp_atendimento: { tokensDiario: tokens, custoDiario: usd } } });
}

// ---------------------------------------------------------------- rede: guarda antes de importar qualquer módulo
const avisosRede = [];
let m = null;
const provedorFalso = async (_alvo, opcoes) => {
  // Provedor FALSO (só --simular): devolve o entendimento das regras no formato do modelo, com uso estimado pelo tamanho.
  const corpo = JSON.parse(opcoes.body);
  const e = m.entenderPorRegras(corpo.messages.at(-1).content, CATALOGOS, {});
  const conteudo = JSON.stringify({ intencoes: e.intencoes.map((i) => ({ tipo: i.tipo, trecho: i.trecho, perguntaId: i.perguntaId ?? null, tema: i.tema ?? null })), data: e.entidades.data, turno: e.entidades.turno, convidados: e.entidades.convidados, pacotes: e.entidades.pacotes, unidade: e.entidades.unidade, tema: e.entidades.tema, reenviar: e.reenviar, alergia: e.alergia });
  const usage = { prompt_tokens: Math.ceil(opcoes.body.length / 3.6), completion_tokens: Math.ceil(conteudo.length / 3.6), prompt_tokens_details: { cached_tokens: 0 } };
  return new Response(JSON.stringify({ id: 'simulado', model: corpo.model, choices: [{ message: { role: 'assistant', content: conteudo } }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
};
globalThis.fetch = criarFetchProtegido(modo === 'ia' ? 'ia' : 'regras', simular ? provedorFalso : globalThis.fetch, (a) => avisosRede.push(a));

// ---------------------------------------------------------------- código avaliado (deste checkout ou de --codigo)
const imp = (rel) => import(pathToFileURL(path.join(codigo, rel)).href);
const [ent, res, core, ctx, worker, jev, orc, modelo] = await Promise.all([
  imp('lib/whatsapp/atendimento/walle/entendimento.ts'), imp('lib/whatsapp/atendimento/walle/resolver.ts'), imp('lib/whatsapp/atendimento/core.ts'),
  imp('lib/whatsapp/atendimento/walle/contexto.ts'), imp('lib/whatsapp/atendimento/worker.ts'), imp('lib/inteligencia/jev/motor.ts'),
  imp('lib/inteligencia/modelos/orcamento.ts'), imp('app/api/admin/inteligencia/whatsapp/modelo.ts'),
]);
m = {
  entenderPorRegras: ent.entenderPorRegras, revalidarEntendimento: ent.revalidarEntendimento, juntarSinais: ent.juntarSinais ?? null,
  resolverWallE: res.resolverWallE, comandoDireto: core.comandoDireto, lerContexto: ctx.lerContexto, mensagemAindaValida: worker.mensagemAindaValida,
  sinaisJev: modelo.sinaisJev, triagemMensagem: jev.triagemMensagem, registroDoBloqueio: ent.registroDoBloqueio ?? null,
};

// ---------------------------------------------------------------- execução
const corpus = JSON.parse(readFileSync(corpusArq, 'utf8'));
// Rótulos revisados pelas fontes disponíveis (o corpus original não muda; --sem-revisao usa só os originais).
const arqRotulos = path.join(aqui, 'rotulos-revisados.json');
const rotulos = args.includes('--sem-revisao') || !existsSync(arqRotulos) ? {} : JSON.parse(readFileSync(arqRotulos, 'utf8'))[path.basename(corpusArq)] ?? {};
const execucao = `${versao}-${path.basename(corpusArq, '.json')}-${Date.now().toString(36)}`;
const real = modo === 'ia' && !simular;
// IA real: cada chamada reservada e fechada no livro único (o teto vale também contra outros processos e worktrees).
const registro = real ? registroComLivro(orc.criarRegistroUsoEmMemoria(), { consumidor: 'avaliador', execucao }) : orc.criarRegistroUsoEmMemoria();
let entender = (texto, contexto) => m.entenderPorRegras(texto, CATALOGOS, contexto);
if (modo === 'ia') {
  // Saldo do livro único conferido ANTES da chave (rodada 10): sem saldo para a rodada inteira, a recusa vem primeiro.
  const orcamento = orcamentoDaExecucao(corpus.itens.length);
  const chave = simular ? 'sk-simulado-sem-rede-0000000000000000' : process.env.OPENAI_API_KEY;
  if (!chave || chave.length < 20) { console.error('Recusado: chave ausente (use comparar-ia.ps1 ou avaliar-ia.ps1).'); process.exit(2); }
  delete process.env.OPENAI_API_KEY; // a chave fica só no objeto entregue ao roteador
  const ia = modelo.entenderPeloRoteador(registro, { ...IA_AUTORIZADA, AI_BUDGET_JSON: orcamento, OPENAI_API_KEY: chave });
  entender = async (texto, contexto) => m.revalidarEntendimento(await ia(EMPRESA, texto, contexto, CATALOGOS), texto, CATALOGOS, contexto);
}
const linhas = [];
let feitas = 0;
for (const seq of sequenciasDoCorpus(corpus.itens)) {
  linhas.push(...await simularSequencia(m, seq, { catalogos: CATALOGOS, config: CONFIG, fontes: linkPublico ? FONTES_COM_LINK : FONTES, agora: AGORA, entender, usos: () => registro.usos, rotulos }));
  // Progresso (stderr, aparece na hora): uma rodada em IA real leva 2–3 minutos.
  const antes = feitas; feitas += seq.length;
  if (modo === 'ia' && (Math.floor(feitas / 10) > Math.floor(antes / 10) || feitas === corpus.itens.length)) process.stderr.write(`  ${feitas}/${corpus.itens.length} mensagens` + '\n');
}
const metricas = calcularMetricas(linhas);

const corpusId = (/^corpus-holdout-(\d+)-/.exec(path.basename(corpusArq)) ? `holdout${/^corpus-holdout-(\d+)-/.exec(path.basename(corpusArq))[1]}` : /^corpus-holdout-20261005/.test(path.basename(corpusArq)) ? 'holdout1' : path.basename(corpusArq, '.json')) + (args.includes('--sem-revisao') ? '-original' : '');
// Com --link-publico, o rótulo da versão diz isso (o nome do arquivo segue o padrão que os comparadores leem).
const nome = `${versao}-${corpusId}-${modo}${simular ? '-simulado' : ''}`;
// v4: régua desta rodada (violação efetiva × reconhecimento de instrução, item de fora, pratos do buffet); v2, v3 e os
// originais ficam intactos.
const pasta = path.join(aqui, 'resultados', 'v4');
mkdirSync(pasta, { recursive: true });
const cabecalho = [
  `Versão **${versao}** (código em \`${path.basename(codigo)}\`), corpus \`${path.basename(corpusArq)}\` (${linhas.length} mensagens), modo **${simular ? 'IA simulada (provedor falso local, sem rede)' : modo}**, hoje ${HOJE}.`,
  'Fontes oficiais sintéticas em memória; sem banco. Caminho da conversa simulado: recepção (PARAR bloqueia), worker e Wall-e.',
  `Página pública de disponibilidade (link): ${linkPublico ? "LIGADA (--link-publico)" : "desligada"}.`,
  `Rede: ${avisosRede.length ? JSON.stringify(avisosRede) : 'nenhuma chamada recusada'}.`,
  `Código: \`${git.sha ?? 'sem git'}\` (${git.branch ?? '?'})${git.alterada ? `, COM alterações não commitadas (${git.alterados.join(', ')})` : ', árvore sem alterações rastreadas'}${git.ignorados.length ? ` (ignorados: ${git.ignorados.join(', ')})` : ''}.`,
];
writeFileSync(path.join(pasta, `${nome}.json`), JSON.stringify({ versao, codigo: path.basename(codigo), git, linkPublico, corpus: path.basename(corpusArq), modo: simular ? 'ia-simulado' : modo, executadoEm: new Date().toISOString(), execucao: real ? execucao : null, metricas, linhas }, null, 2) + '\n');
const md = markdown(`Wall-e — ${nome}`, cabecalho, metricas);
writeFileSync(path.join(pasta, `${nome}.md`), md);
console.log(md);
