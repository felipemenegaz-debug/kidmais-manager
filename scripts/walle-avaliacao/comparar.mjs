// Comparação entre versões (e regras × IA) a partir dos resultados v4 já gravados em resultados/v4/. Só lê e escreve
// resultados/v4/comparacao.md; nenhuma chamada de modelo, rede ou banco.
//   node scripts/walle-avaliacao/comparar.mjs
// O resultado original em IA real do holdout 1 (resultados/resultado-ia.json, avaliador v1, código "antes") entra
// convertido quando não existe a rodada v2 equivalente: decisões e textos sim; fontes não (acertos comerciais "n/d").
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcularMetricas } from './metricas.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const pasta = path.join(aqui, 'resultados', 'v4');
const ler = (nome) => { const f = path.join(pasta, `${nome}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };

/** Resultado v1 (avaliador original) em linhas v2: sem fontes; PARAR esperado = intenção PARAR. */
function doOriginalV1(arquivo) {
  if (!existsSync(arquivo)) return null;
  const v1 = JSON.parse(readFileSync(arquivo, 'utf8'));
  const linhas = v1.linhas.map((l) => ({
    id: l.id, conversa: l.conversa ?? null, ordem: l.ordem ?? null, texto: l.texto,
    esperado: { decisao: l.esperado.intencoes.includes('PARAR') ? 'PARAR' : l.esperado.decisao, intencoes: l.esperado.intencoes, entidades: l.esperado.entidades },
    decisao: l.walle.decisao, motivos: l.walle.motivos ?? [], bloqueada: false, pendente: l.walle.pendente ?? [], saidas: [], resposta: l.walle.resposta ?? '',
    intencoes: l.walle.intencoes, entidades: l.walle.entidades, semFonte: [], falha: l.walle.falha ?? null, ms: l.walle.ms, modelo: l.walle.modelo ?? [],
  }));
  const metricas = calcularMetricas(linhas);
  metricas.comercial = { casos: metricas.comercial.casos, acertos: null, falhas: [] };
  return { versao: 'antes', modo: 'ia', original: true, executadoEm: statSync(arquivo).mtime.toISOString(), metricas };
}

const VERSOES = [['antes', 'antes (c5a2f9a)'], ['r2', 'rodada 2 (2fbd6a6)'], ['r3', 'rodada 3 (62e661f)'], ['r4', 'rodada 4 (93b644e)'], ['r5', 'rodada 5 (081f34d)'], ['r6', 'rodada 6 (416d06c)'], ['r7', 'rodada 7 (50fe162)'], ['r8', 'rodada 8 (7083ec9)'], ['r9', 'rodada 9 (798d8c9)'], ['r10', 'rodada 10 (c8799d5)'], ['r11', 'rodada 11 (d1d2284)'], ['r12', 'rodada 12 (a3d6f6a)'], ['r13', 'rodada 13 (66f9182)'], ['r14', 'rodada 14 (5239dca)'], ['r15', 'rodada 15 (65c7a7e)'], ['r16', 'rodada 16 (0932317)'], ['r17', 'rodada 17 (5597366)'], ['r18', 'rodada 18 (bb5056f)'], ['r19', 'rodada 19 (eed6266)'], ['r20', 'rodada 20 (785c888)'], ['r21', 'rodada 21 (da28183)'], ['r22', 'rodada 22 (12fea0b)'], ['r23', 'rodada 23 (943a87b)'], ['r24', 'rodada 24 (7404116)'], ['r25', 'rodada 25 (efbba03)'], ['r26', 'rodada 26 (ced7be6)'], ['r27', 'rodada 27']];
const CORPORA = [
  ['holdout1', 'Holdout 1 (70) — regressão'],
  ['holdout2', 'Holdout 2 (80) — regressão (foi a medição da rodada 2)'],
  ['holdout3', 'Holdout 3 (80) — regressão (foi a medição da rodada 3)'],
  ['holdout4', 'Holdout 4 (80) — regressão (foi a medição da rodada 4)'],
  ['holdout5', 'Holdout 5 (80) — regressão (foi a medição da rodada 5)'],
  ['holdout6', 'Holdout 6 (80) — regressão (foi a medição da rodada 6)'],
  ['holdout7', 'Holdout 7 (80) — regressão (foi a medição da rodada 7)'],
  ['holdout8', 'Holdout 8 (80) — regressão (foi a medição da rodada 8)'],
  ['holdout9', 'Holdout 9 (80) — regressão (foi a medição da rodada 9)'],
  ['holdout10', 'Holdout 10 (80) — regressão (foi a medição da rodada 10)'],
  ['holdout11', 'Holdout 11 (80) — regressão (foi a medição da rodada 11)'],
  ['holdout12', 'Holdout 12 (80) — regressão (foi a medição da rodada 12)'],
  ['holdout13', 'Holdout 13 (80) — regressão (foi a medição da rodada 13)'],
  ['holdout14', 'Holdout 14 (80) — regressão (foi a medição da rodada 14)'],
  ['holdout15', 'Holdout 15 (80) — regressão (foi a medição da rodada 15)'],
  ['holdout16', 'Holdout 16 (80) — regressão (foi a medição da rodada 16)'],
  ['holdout17', 'Holdout 17 (80) — regressão (foi a medição da rodada 17)'],
  ['holdout18', 'Holdout 18 (80) — regressão (foi a medição da rodada 18)'],
  ['holdout19', 'Holdout 19 (80) — regressão (foi a medição da rodada 19)'],
  ['holdout20', 'Holdout 20 (80) — regressão (foi a medição da rodada 20)'],
  ['holdout21', 'Holdout 21 (80) — regressão (foi a medição da rodada 21)'],
  ['holdout22', 'Holdout 22 (80) — regressão (foi a medição da rodada 22)'],
  ['holdout23', 'Holdout 23 (80) — regressão (foi a medição da rodada 23)'],
  ['holdout24', 'Holdout 24 (80) — regressão (foi a medição da rodada 24)'],
  ['holdout25', 'Holdout 25 (80) — regressão (foi a medição da rodada 25)'],
  ['holdout26', 'Holdout 26 (80) — regressão (foi a medição da rodada 26)'],
  ['holdout27', 'Holdout 27 (80) — MEDIÇÃO desta rodada'],
];
function tabela(modo, corpus) {
  const res = VERSOES.map(([v]) => ler(`${v}-${corpus}-${modo}`) ?? (modo === 'ia' && v === 'antes' && corpus === 'holdout1' ? doOriginalV1(path.join(aqui, 'resultados', 'resultado-ia.json')) : null));
  if (res.every((r) => !r)) return [`Sem resultados (${modo}).`, ''];
  const cel = (r, f) => (r ? f(r.metricas) : '—');
  const cats = (res.filter(Boolean).at(-1)?.metricas.criticas ?? []).map((c) => [c.chave, c.nome]);
  const linha = (nome, f) => `| ${nome} | ${res.map((r) => cel(r, f)).join(' | ')} |`;
  return [
    `| ${modo === 'ia' ? 'IA real' : 'regras'} | ${VERSOES.map(([, n]) => n).join(' | ')} |`, `|---|${VERSOES.map(() => '---').join('|')}|`,
    linha('**Falhas críticas (total)**', (m) => `**${m.criticas.reduce((s, c) => s + c.falhas.length, 0)}**`),
    ...cats.map(([chave, nome]) => linha(`↳ ${nome}`, (m) => { const c = m.criticas.find((x) => x.chave === chave); return c ? `${c.falhas.length}/${c.casos}` : '—'; })),
    linha('**Acertos comerciais**', (m) => (m.comercial.acertos === null ? 'n/d (sem fontes no original)' : `${m.comercial.acertos}/${m.comercial.casos}`)),
    linha('**Encaminhamentos desnecessários**', (m) => String(m.desnecessarios.length)),
    // Rodada 21 (não críticas): versões medidas antes da régua da rodada 21 mostram "—" até serem reavaliadas.
    ...[['dadosExtraidosErrados', 'Dados extraídos errados'], ['menusIndevidos', 'Menu genérico indevido'], ['perguntasForaDoFluxo', 'Perguntas fora do fluxo'], ['repeticoes', 'Repetição desnecessária']].map(([k, nome]) => linha(`${nome} (não crítico)`, (m) => (m[k] ? String(m[k].length) : '—'))),
    linha('Instruções reconhecidas (à parte da violação)', (m) => (m.instrucoes ? `${m.instrucoes.reconhecidas}/${m.instrucoes.casos}` : 'n/d')),
    linha('Decisão igual ao rótulo (informativo)', (m) => `${m.decisao.acertos}/${m.mensagens}`),
    linha('Custo do modelo (US$)', (m) => (m.modelo ? `${m.modelo.custoUSD} (${m.modelo.chamadas} chamadas; US$ ${m.modelo.custoPor1000USD}/1.000)` : '0')),
    linha('Tokens (entrada + saída)', (m) => (m.modelo ? `${m.modelo.tokensEntrada} + ${m.modelo.tokensSaida}` : '0')),
    linha('Latência por mensagem p50 / p95 (ms)', (m) => `${m.latenciaMs.totalP50 ?? '—'} / ${m.latenciaMs.totalP95 ?? '—'}`),
    '',
    ...res.flatMap((r, i) => (r?.original ? [`Coluna ${VERSOES[i][1]}: resultado ORIGINAL em IA real (avaliador v1, ${r.executadoEm.slice(0, 16)}), convertido; sem fontes (acertos comerciais n/d).`, ''] : [])),
  ];
}

const md = [
  '# Wall-e — comparação antes × rodadas 2 a 27', '',
  '- Mesma régua para todas as versões (avaliador v4: PARAR com bloqueio e silêncio, PARAR misto, reserva pela coleta ou equipe e nunca confirmada, violação efetiva de instrução em qualquer mensagem, item de fora como informação não cadastrada, rótulos revisados pelas fontes em rotulos-revisados.json).',
  '- Holdouts 1 a 26 já foram usados nas correções (REGRESSÃO). O holdout 27 (80 mensagens, escrito sem acesso ao código nem aos anteriores, com o inventário das fontes) só foi lido depois do código e da régua congelados: é a MEDIÇÃO da rodada 27. Colunas "reavaliado" vêm de linhas gravadas antes, reavaliadas com a régua v4 (reavaliar.mjs), sem chamada nova.',
  '- Reconhecimento de instrução (sinal ou motivo) é medido à parte em cada resultado (seção “Instruções ao sistema”).',
  '- Falhas críticas por categoria; nenhuma média as esconde.', '',
  ...['regras', 'ia'].flatMap((modo) => [`## ${modo === 'ia' ? 'IA real (gpt-6-luna, revalidada pelas regras)' : 'Regras (sem modelo)'}`, '', ...CORPORA.flatMap(([c, nome]) => [`### ${nome}`, '', ...tabela(modo, c)])]),
];
writeFileSync(path.join(pasta, 'comparacao.md'), md.join('\n'));
console.log(md.join('\n'));
