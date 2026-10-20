// Comparação regras × IA do MESMO código (mesmo SHA) nos mesmos holdouts, por categoria, com respostas completas e
// fontes. Só lê resultados já gravados pelo avaliar.mjs e escreve um markdown; nenhuma chamada de modelo, rede ou banco.
//
//   node scripts/walle-avaliacao/comparar-regras-ia.mjs --pasta <resultados/v4> --versao <rótulo> --holdouts 28,29,30 [--simulado]
//
// Lê <pasta>/<versao>-holdoutNN-regras.json e <pasta>/<versao>-holdoutNN-ia.json (ou -ia-simulado.json com --simulado).
// Recusa comparar quando os dois resultados não têm o mesmo git.sha ou quando algum foi gravado com árvore alterada.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opcao = (nome) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : null; };
const pasta = opcao('--pasta');
const versao = opcao('--versao');
const holdouts = String(opcao('--holdouts') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const simulado = args.includes('--simulado');
if (!pasta || !versao || !holdouts.length) { console.error('uso: comparar-regras-ia.mjs --pasta <dir> --versao <rótulo> --holdouts 28,29,30 [--simulado]'); process.exit(2); }

const ler = (arquivo) => (existsSync(arquivo) ? JSON.parse(readFileSync(arquivo, 'utf8')) : null);
const ids = (falhas) => (falhas.length ? falhas.map((f) => f.id).join(', ') : '—');
const bloco = (t) => (t ? t.split('\n').map((l) => `    ${l}`).join('\n') : '    (nada enviado)');
const fontes = (l) => {
  const todas = l.saidas.flatMap((s) => s.fontes ?? []);
  return todas.length ? todas.map((f) => [f.tipo, f.codigo ?? f.id ?? f.finalidade, f.versao != null ? `v${f.versao}` : null].filter(Boolean).join(':')).join('; ') : 'nenhuma';
};
const anexos = (l) => l.saidas.map((s) => s.anexo).filter(Boolean);
const resumoLinha = (rot, l) => [
  `- **${rot}:** ${l.decisao}${l.motivos?.length ? ` [${l.motivos.join(', ')}]` : ''}${l.bloqueada ? ' · bloqueada' : ''} · intenções ${(l.intencoes ?? []).join(', ') || '—'}`,
  `  - fontes: ${fontes(l)}${anexos(l).length ? ` · anexos: ${anexos(l).join(', ')}` : ''}`,
  '  - resposta completa:', bloco(l.resposta),
];

const saida = [`# Regras × IA — ${versao} (holdouts ${holdouts.join(', ')})${simulado ? ' — IA SIMULADA' : ''}`, ''];
const geral = [];
for (const h of holdouts) {
  const r = ler(path.join(pasta, `${versao}-holdout${h}-regras.json`));
  const i = ler(path.join(pasta, `${versao}-holdout${h}-ia${simulado ? '-simulado' : ''}.json`));
  saida.push(`## Holdout ${h}`, '');
  if (!r) { saida.push('Resultado em regras ausente: rode o avaliador em modo regras neste SHA.', ''); continue; }
  if (!i) { saida.push(`IA ainda não medida neste SHA (${r.git?.sha ?? '?'}). Só regras: ${r.metricas.criticas.reduce((n, c) => n + c.falhas.length, 0)} falhas críticas.`, ''); continue; }
  if (!r.git?.sha || r.git.sha !== i.git?.sha) { saida.push(`**Recusado:** SHAs diferentes (regras ${r.git?.sha ?? 'sem git'} × IA ${i.git?.sha ?? 'sem git'}).`, ''); continue; }
  if (r.git.alterada || (i.git.alterada && !simulado)) { saida.push('**Recusado:** resultado gravado com árvore alterada.', ''); continue; }
  const [mr, mi] = [r.metricas, i.metricas];
  const totR = mr.criticas.reduce((n, c) => n + c.falhas.length, 0), totI = mi.criticas.reduce((n, c) => n + c.falhas.length, 0);
  const msgR = new Set(mr.criticas.flatMap((c) => c.falhas.map((f) => f.id))), msgI = new Set(mi.criticas.flatMap((c) => c.falhas.map((f) => f.id)));
  geral.push([h, msgR.size, msgI.size, mr.comercial, mi.comercial]);
  saida.push(`SHA \`${r.git.sha}\` (${r.git.branch}). Regras gravadas em ${r.executadoEm}; IA em ${i.executadoEm}${i.execucao ? ` (execução ${i.execucao})` : ''}.`, '');
  if (mi.modelo) saida.push(`Modelo (IA): ${JSON.stringify(mi.modelo)}`, '');
  saida.push('| Categoria crítica | Casos | Regras | IA |', '|---|---|---|---|');
  for (const c of mr.criticas) {
    const ci = mi.criticas.find((x) => x.chave === c.chave) ?? { falhas: [] };
    saida.push(`| ${c.nome} | ${c.casos} | **${c.falhas.length}** (${ids(c.falhas)}) | **${ci.falhas.length}** (${ids(ci.falhas)}) |`);
  }
  saida.push(`| **Total de falhas (mensagens distintas)** | | **${totR} (${msgR.size})** | **${totI} (${msgI.size})** |`, '');
  const linha = (nome, a, b) => `| ${nome} | ${a} | ${b} |`;
  saida.push('| Não crítico | Regras | IA |', '|---|---|---|',
    linha('Comerciais com fonte oficial', `${mr.comercial.acertos}/${mr.comercial.casos}`, `${mi.comercial.acertos}/${mi.comercial.casos}`),
    linha('Encaminhamentos desnecessários', mr.desnecessarios.length, mi.desnecessarios.length),
    linha('Conteúdo irrelevante', mr.irrelevantes?.length ?? 0, mi.irrelevantes?.length ?? 0),
    linha('Menu genérico indevido', mr.menusIndevidos?.length ?? 0, mi.menusIndevidos?.length ?? 0),
    linha('Dados extraídos errados', mr.dadosExtraidosErrados?.length ?? 0, mi.dadosExtraidosErrados?.length ?? 0),
    linha('Perguntas desnecessárias', mr.perguntasDesnecessarias?.length ?? 0, mi.perguntasDesnecessarias?.length ?? 0),
    linha('Instruções reconhecidas', `${mr.instrucoes.reconhecidas}/${mr.instrucoes.casos}`, `${mi.instrucoes.reconhecidas}/${mi.instrucoes.casos}`),
    linha('Instrução obedecida (violação efetiva)', mr.instrucoes.violacoes.length, mi.instrucoes.violacoes.length), '');
  // Mensagens em que os dois caminhos divergem (decisão, motivos ou texto), críticas primeiro; respostas completas.
  const porId = new Map(i.linhas.map((l) => [l.id, l]));
  const div = r.linhas.filter((a) => { const b = porId.get(a.id); return b && (a.decisao !== b.decisao || String(a.motivos) !== String(b.motivos) || a.resposta !== b.resposta); });
  div.sort((a, b) => Number(msgR.has(b.id) || msgI.has(b.id)) - Number(msgR.has(a.id) || msgI.has(a.id)));
  saida.push(`### Mensagens com resultado diferente (${div.length} de ${r.linhas.length})`, '');
  for (const a of div) {
    const b = porId.get(a.id);
    const marca = [msgR.has(a.id) && 'crítica em regras', msgI.has(a.id) && 'crítica na IA'].filter(Boolean).join(' · ');
    saida.push(`#### ${a.id}${a.conversa ? ` (${a.conversa}, ${a.ordem})` : ''}${marca ? ` — ${marca}` : ''}`, '',
      `> ${a.texto}`, '', `Esperado: ${a.esperado.decisao} · ${a.esperado.intencoes.join(', ')}${a.esperado.nota ? ` — ${a.esperado.nota}` : ''}`, '',
      ...resumoLinha('Regras', a), ...resumoLinha('IA', b), '');
  }
  // Críticas iguais nos dois caminhos (mesma resposta): listadas com a resposta, para não sumirem da leitura.
  const iguais = r.linhas.filter((a) => msgR.has(a.id) && msgI.has(a.id) && !div.includes(a));
  if (iguais.length) {
    saida.push(`### Críticas iguais nos dois caminhos (${iguais.length})`, '');
    for (const a of iguais) saida.push(`#### ${a.id}`, '', `> ${a.texto}`, '', ...resumoLinha('Regras = IA', a), '');
  }
}
if (geral.length) {
  saida.splice(2, 0, '| Holdout | Mensagens críticas — regras | — IA | Comerciais — regras | — IA |', '|---|---|---|---|---|',
    ...geral.map(([h, a, b, ca, cb]) => `| ${h} | ${a} | ${b} | ${ca.acertos}/${ca.casos} | ${cb.acertos}/${cb.casos} |`), '');
}
const destino = path.join(pasta, `comparacao-${versao}-regras-ia${simulado ? '-simulado' : ''}.md`);
writeFileSync(destino, saida.join('\n') + '\n');
console.log(`Comparação: ${destino}`);
console.log(geral.map(([h, a, b]) => `holdout ${h}: críticas regras ${a} × IA ${b}`).join('\n') || 'Nenhum holdout com regras e IA no mesmo SHA.');
