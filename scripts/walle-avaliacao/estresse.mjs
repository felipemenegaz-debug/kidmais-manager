// Estresse do Wall-e (modo regras; rede recusada; sem banco; NADA gravado em resultados/): roda corpora de estresse por
// categoria pelo mesmo caminho simulado do avaliador (recepção com PARAR, worker, Wall-e) e imprime, em JSON, as falhas
// críticas, os comerciais perdidos, as passagens desnecessárias e as instruções não reconhecidas — com texto, rótulo e
// resposta — para revisão de rótulo e correção. Não é medição: medição é sempre um holdout novo, lacrado antes de ler.
//   node --experimental-strip-types --no-warnings --import ./scripts/walle-avaliacao/registrar.mjs scripts/walle-avaliacao/estresse.mjs <corpus.json> [...] [--codigo raiz] [--resumo]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { criarFetchProtegido } from './guarda-rede.mjs';
import { AGORA, CATALOGOS, CONFIG, FONTES } from './fixture.mjs';
import { calcularMetricas } from './metricas.mjs';
import { sequenciasDoCorpus, simularSequencia } from './simulacao.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opcao = (nome, padrao = null) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : padrao; };
const arquivos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--codigo');
if (!arquivos.length) { console.error('uso: estresse.mjs <corpus.json> [...] [--codigo raiz] [--resumo]'); process.exit(2); }
if (process.env.DATABASE_URL) { console.error('Recusado: DATABASE_URL presente. O estresse não usa banco.'); process.exit(2); }
const avisos = [];
globalThis.fetch = criarFetchProtegido('regras', globalThis.fetch, (a) => avisos.push(a));

const codigo = path.resolve(opcao('--codigo', path.resolve(aqui, '..', '..')));
const imp = (rel) => import(pathToFileURL(path.join(codigo, rel)).href);
const [ent, res, core, ctx, worker, jev, modelo] = await Promise.all([
  imp('lib/whatsapp/atendimento/walle/entendimento.ts'), imp('lib/whatsapp/atendimento/walle/resolver.ts'), imp('lib/whatsapp/atendimento/core.ts'),
  imp('lib/whatsapp/atendimento/walle/contexto.ts'), imp('lib/whatsapp/atendimento/worker.ts'), imp('lib/inteligencia/jev/motor.ts'),
  imp('app/api/admin/inteligencia/whatsapp/modelo.ts'),
]);
const m = {
  entenderPorRegras: ent.entenderPorRegras, revalidarEntendimento: ent.revalidarEntendimento, juntarSinais: ent.juntarSinais ?? null,
  resolverWallE: res.resolverWallE, comandoDireto: core.comandoDireto, lerContexto: ctx.lerContexto, mensagemAindaValida: worker.mensagemAindaValida,
  sinaisJev: modelo.sinaisJev, triagemMensagem: jev.triagemMensagem, registroDoBloqueio: ent.registroDoBloqueio ?? null,
};

const saida = [];
for (const arq of arquivos) {
  const corpus = JSON.parse(readFileSync(arq, 'utf8'));
  const linhas = [];
  for (const seq of sequenciasDoCorpus(corpus.itens)) {
    linhas.push(...await simularSequencia(m, seq, { catalogos: CATALOGOS, config: CONFIG, fontes: FONTES, agora: AGORA, entender: (texto, contexto) => m.entenderPorRegras(texto, CATALOGOS, contexto) }));
  }
  const met = calcularMetricas(linhas);
  const porId = new Map();
  const marcar = (id, motivo) => { if (!porId.has(id)) porId.set(id, []); porId.get(id).push(motivo); };
  for (const c of met.criticas) for (const f of c.falhas) marcar(f.id, `CRITICA ${c.chave}: ${f.motivo}`);
  for (const f of met.comercial.falhas) marcar(f.id, `COMERCIAL: ${f.motivo ?? ''}`);
  for (const f of met.desnecessarios) marcar(f.id, 'DESNECESSARIO');
  for (const x of met.instrucoes.naoReconhecidas) marcar(x.id, 'INSTRUCAO_NAO_RECONHECIDA');
  saida.push({
    corpus: path.basename(arq), mensagens: linhas.length,
    totalCriticas: met.criticas.reduce((s, c) => s + c.falhas.length, 0),
    criticas: Object.fromEntries(met.criticas.filter((c) => c.casos).map((c) => [c.chave, `${c.falhas.length}/${c.casos}`])),
    comercial: `${met.comercial.acertos}/${met.comercial.casos}`, desnecessarios: met.desnecessarios.length,
    instrucoes: `${met.instrucoes.reconhecidas}/${met.instrucoes.casos}`, violacoes: met.instrucoes.violacoes.length,
    casos: args.includes('--resumo') ? undefined : linhas.filter((l) => porId.has(l.id)).map((l) => ({
      id: l.id, conversa: l.conversa ?? null, ordem: l.ordem ?? null, texto: l.texto, esperado: l.esperado.decisao, intencoesEsperadas: l.esperado.intencoes,
      obtido: l.decisao, motivos: l.motivos, bloqueada: l.bloqueada, resposta: (l.resposta ?? '').replace(/\s*\n+\s*/g, ' | ').slice(0, 320), problemas: porId.get(l.id),
    })),
  });
}
if (avisos.length) console.error(`Rede recusada: ${JSON.stringify(avisos)}`);
console.log(JSON.stringify(saida, null, 2));
