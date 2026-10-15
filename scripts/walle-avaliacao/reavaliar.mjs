// Reavalia com a régua ATUAL (metricas.mjs + rotulos-revisados.json) as linhas JÁ GRAVADAS de uma medição anterior: nenhuma
// chamada de modelo, nenhuma rede, e o arquivo original não é tocado. O resultado vai para resultados/v4/ com o mesmo nome
// que uma medição v4 teria e o campo "reavaliadoDe" apontando a origem (recusa se o destino já existe).
//   node scripts/walle-avaliacao/reavaliar.mjs scripts/walle-avaliacao/resultados/v3/r3-holdout3-ia.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcularMetricas, markdown } from './metricas.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const origem = path.resolve(process.argv[2] ?? '');
if (!existsSync(origem)) { console.error('uso: reavaliar.mjs <resultado.json gravado>'); process.exit(2); }
const r = JSON.parse(readFileSync(origem, 'utf8'));
if (!Array.isArray(r.linhas) || !r.corpus || !r.versao || !r.modo) { console.error('Recusado: resultado sem linhas, corpus, versão ou modo.'); process.exit(2); }
const corpus = JSON.parse(readFileSync(path.join(aqui, r.corpus), 'utf8'));
const rotulos = JSON.parse(readFileSync(path.join(aqui, 'rotulos-revisados.json'), 'utf8'))[r.corpus] ?? {};
const porId = new Map(corpus.itens.map((i) => [i.id, i]));
// Rótulo esperado como a simulação v4 o monta (rótulo revisado pelas fontes, quando houver; o original fica registrado).
const linhas = r.linhas.map((l) => {
  const item = porId.get(l.id);
  if (!item) throw new Error(`linha ${l.id} fora do corpus`);
  const rev = rotulos[l.id];
  const decisao = rev?.decisao ?? (item.intencoes.includes('PARAR') && !['SEM_RESPOSTA', 'PARAR_MISTO'].includes(item.decisao) ? 'PARAR' : item.decisao);
  return { ...l, esperado: { decisao, intencoes: [...item.intencoes].sort(), entidades: item.entidades, ...(rev ? { revisado: rev, original: item.decisao } : {}) } };
});
const metricas = calcularMetricas(linhas);
const base = path.basename(r.corpus);
const corpusId = /^corpus-holdout-(\d+)-/.exec(base) ? `holdout${/^corpus-holdout-(\d+)-/.exec(base)[1]}` : /^corpus-holdout-20261005/.test(base) ? 'holdout1' : path.basename(base, '.json');
const nome = `${r.versao}-${corpusId}-${r.modo}`;
const destino = path.join(aqui, 'resultados', 'v4', `${nome}.json`);
if (existsSync(destino)) { console.error(`Recusado: ${path.relative(aqui, destino)} já existe (medição ou reavaliação anterior).`); process.exit(2); }
const de = path.relative(aqui, origem).split(path.sep).join('/');
writeFileSync(destino, JSON.stringify({ ...r, executadoEm: r.executadoEm, reavaliadoDe: de, reavaliadoEm: new Date().toISOString(), regua: 'v4', metricas, linhas }, null, 2) + '\n');
const md = markdown(`Wall-e — ${nome} (REAVALIADO com a régua v4)`, [
  `Linhas gravadas em \`${de}\` (medido em ${r.executadoEm}, versão **${r.versao}**, modo **${r.modo}**), reavaliadas com a régua v4: nenhuma chamada nova, nenhuma rede; o original não foi alterado.`,
  `Corpus \`${r.corpus}\` (${linhas.length} mensagens); rótulos revisados pelas fontes aplicados como na v4.`,
], metricas);
writeFileSync(destino.replace(/\.json$/, '.md'), md);
console.log(md.split('\n').filter((l) => /^\| |^\*\*\d+\/\d+\*\*|^Reconhecidas|^Modelo:/.test(l)).join('\n'));
