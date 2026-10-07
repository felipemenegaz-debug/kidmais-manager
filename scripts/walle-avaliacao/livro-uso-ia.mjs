// Livro ÚNICO do uso de IA real do Wall-e: avaliadores de qualquer worktree, demonstração e o que vier depois somam no
// MESMO teto diário autorizado (America/Sao_Paulo). Um arquivo JSONL fora das worktrees, só acrescentado, com trava
// exclusiva entre processos para conferir e reservar. Só números e rótulos: nunca prompt, resposta, texto de cliente ou chave.
//
//   saldo-inicial  uso anterior ao livro, semeado uma vez por (dia, origem)
//   reserva/fecha  uma chamada de modelo: reservada ANTES (em andamento conta pelo máximo) e fechada com o uso real
//                  (zero se não chegou ao provedor; uso desconhecido fica pelo máximo). Rodada interrompida: as chamadas
//                  fechadas contam pelo real e a que estava no ar, pelo máximo.
//   cota/fecha-cota  consumidor que mede no próprio banco (demonstração): a cota inteira conta enquanto aberta e, ao
//                  encerrar, fica o uso real lido do banco dela.
//   observado      leitura (só leitura) do consumo de uma demonstração que NÃO usa o livro; vale a última do dia.
//
// Consumo do dia = saldos + observados + fechados (pelo real) + abertos (pelo máximo). Reserva ou cota que passaria do
// teto é recusada. O teto vem do que foi autorizado (TETO) e só pode ser REDUZIDO por quem chama.
//
// LOCAL: `%USERPROFILE%\.kidmais-walle\uso-ia\livro.jsonl`, FORA do AppData. O app Claude é empacotado (MSIX) e o
// Windows redireciona o que os processos dele gravam em AppData\Local para uma pasta privada do pacote: em 05/10 o livro
// em AppData ficou dividido em dois (o do app e o do terminal do usuário) e o teto do dia não foi somado. Sem livro
// criado/migrado, ou com um livro antigo do AppData voltando a ser usado, nada é reservado (exigirLivro).
//
//   node scripts/walle-avaliacao/livro-uso-ia.mjs estado [--dia AAAA-MM-DD]
//   node scripts/walle-avaliacao/livro-uso-ia.mjs conferir --tokens N [--usd X]                (só leitura; 3 = não cabe)
//   node scripts/walle-avaliacao/livro-uso-ia.mjs semear --dia D --origem O --tokens N --usd X --nota "..."
//   node scripts/walle-avaliacao/livro-uso-ia.mjs abrir-cota --consumidor C --tokens N --usd X [--descricao "..."]
//   node scripts/walle-avaliacao/livro-uso-ia.mjs fechar-cota --id ID --tokens N --usd X [--nota "..."]
//   node scripts/walle-avaliacao/livro-uso-ia.mjs observar --origem O --tokens N --usd X [--nota "..."]
//   node scripts/walle-avaliacao/livro-uso-ia.mjs migrar --de ARQ [--de ARQ…] [--nota "..."]   (união dos livros antigos)
//   node scripts/walle-avaliacao/livro-uso-ia.mjs fechar-reserva --id ID --nota "..."            (pelo máximo reservado)
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Teto AUTORIZADO por dia para todo o uso real do Wall-e (empresa sintética, capacidade whatsapp_atendimento). */
export const TETO = Object.freeze({ tokens: 300000, usd: 0.20 });
export const diaOperacao = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(d);
/** Fora de qualquer worktree e fora do AppData (ver LOCAL acima); KIDMAIS_WALLE_LIVRO_USO só para teste. */
export function caminhoLivro() {
  return process.env.KIDMAIS_WALLE_LIVRO_USO || path.join(homedir(), '.kidmais-walle', 'uso-ia', 'livro.jsonl');
}
/**
 * Livros antigos do AppData (antes de 06/10): o caminho comum e as cópias redirecionadas de apps empacotados
 * (AppData\Local\Packages\<app>\LocalCache\Local\…). Depois da migração eles ficam renomeados; se um voltar a existir, um
 * código antigo gravou ali e o teto não é mais somado: nada é reservado. KIDMAIS_WALLE_LIVRO_LEGADO só para teste.
 */
export function livrosAntigos() {
  if (process.env.KIDMAIS_WALLE_LIVRO_LEGADO !== undefined) return process.env.KIDMAIS_WALLE_LIVRO_LEGADO.split(path.delimiter).filter(Boolean);
  const local = path.join(homedir(), 'AppData', 'Local');
  const rel = path.join('kidmais-walle', 'uso-ia', 'livro.jsonl');
  const pacotes = path.join(local, 'Packages');
  let redirecionados = [];
  try { redirecionados = readdirSync(pacotes).map((p) => path.join(pacotes, p, 'LocalCache', 'Local', rel)); } catch { /* sem apps empacotados */ }
  return [path.join(local, rel), ...redirecionados];
}
/**
 * Antes de qualquer gasto: o livro existe (criado ou migrado), nenhum livro antigo do AppData está em uso e nenhum desvio
 * de caminho está ativo. KIDMAIS_WALLE_LIVRO_USO/LEGADO existem só para teste (com KIDMAIS_WALLE_LIVRO_TESTE=1): numa
 * rodada paga eles fariam o processo somar num livro à parte — o mesmo defeito do livro dividido de 05/10.
 */
export function exigirLivro() {
  if ((process.env.KIDMAIS_WALLE_LIVRO_USO || process.env.KIDMAIS_WALLE_LIVRO_LEGADO !== undefined) && process.env.KIDMAIS_WALLE_LIVRO_TESTE !== '1')
    throw new Error('LIVRO_USO_DESVIADO: KIDMAIS_WALLE_LIVRO_USO/LEGADO só valem em teste (KIDMAIS_WALLE_LIVRO_TESTE=1); remova-os para usar o livro único.');
  const arquivo = caminhoLivro();
  if (!existsSync(arquivo)) throw new Error(`LIVRO_USO_AUSENTE: ${arquivo} não existe; crie ou migre o livro (livro-uso-ia.mjs migrar) antes de qualquer gasto.`);
  const antigos = livrosAntigos().filter((f) => existsSync(f));
  if (antigos.length) throw new Error(`LIVRO_USO_ANTIGO_EM_USO: ${antigos.join(', ')} — um código antigo gravou no livro do AppData; migre-o para o livro único antes de qualquer gasto.`);
}
const usd6 = (x) => Math.round(x * 1e6) / 1e6;

function ler(arquivo = caminhoLivro()) {
  if (!existsSync(arquivo)) return [];
  const linhas = [];
  for (const l of readFileSync(arquivo, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { linhas.push(JSON.parse(l)); } catch { /* linha final incompleta (escrita em andamento): ignorada */ }
  }
  return linhas;
}

const esperar = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Trava exclusiva entre processos (arquivo criado com O_EXCL). Trava abandonada há mais de 30 s é desfeita. */
function comTrava(trabalho, arquivo = caminhoLivro()) {
  mkdirSync(path.dirname(arquivo), { recursive: true });
  const trava = `${arquivo}.trava`;
  const limite = Date.now() + 15000;
  let fd = null;
  while (fd === null) {
    try { fd = openSync(trava, 'wx'); }
    catch (erro) {
      // Ocupada: existe (EEXIST) ou está sendo apagada por outro processo (no Windows, EPERM/EACCES/EBUSY).
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(erro.code)) throw erro;
      let idade = 0;
      try { idade = Date.now() - statSync(trava).mtimeMs; } catch { /* sumiu ou está sumindo: tenta de novo */ }
      if (idade > 30000) { try { unlinkSync(trava); } catch { /* outro processo já desfez */ } continue; }
      if (Date.now() > limite) throw new Error('LIVRO_USO_TRAVADO');
      esperar(5 + Math.floor(Math.random() * 20));
    }
  }
  try { writeSync(fd, `${process.pid} ${new Date().toISOString()}`); return trabalho(); }
  finally { closeSync(fd); try { unlinkSync(trava); } catch { /* já removida */ } }
}
/** Só acrescenta a um livro EXISTENTE: livro novo só nasce por migrar/criarLivro (nunca vazio por engano). */
function acrescentar(linha, arquivo = caminhoLivro()) {
  if (!existsSync(arquivo)) throw new Error('LIVRO_USO_AUSENTE');
  appendFileSync(arquivo, JSON.stringify({ em: new Date().toISOString(), ...linha }) + '\n');
}

/** Consumo do dia pelo livro: o que já foi (real), o que está no ar (máximo) e o que veio de fora (observado). */
export function consumoDoDia(dia = diaOperacao(), linhas = ler()) {
  const doDia = linhas.filter((l) => l.dia === dia || (l.evento === 'fecha' || l.evento === 'fecha-cota'));
  const abertas = new Map();
  const fechadas = new Map();
  const observados = new Map();
  let tokens = 0, usd = 0;
  for (const l of doDia) {
    if (l.evento === 'saldo-inicial' && l.dia === dia) { tokens += l.tokens; usd += l.usd; }
    else if (l.evento === 'observado' && l.dia === dia) observados.set(l.origem, l);
    else if ((l.evento === 'reserva' || l.evento === 'cota') && l.dia === dia) abertas.set(l.id, l);
    else if (l.evento === 'fecha' || l.evento === 'fecha-cota') fechadas.set(l.id, l);
  }
  const emAberto = [];
  for (const [id, r] of abertas) {
    const f = fechadas.get(id);
    if (f) { tokens += f.tokens; usd += f.usd; } else { tokens += r.tokens; usd += r.usd; emAberto.push(r); }
  }
  for (const o of observados.values()) { tokens += o.tokens; usd += o.usd; }
  return { dia, tokens, usd: usd6(usd), emAberto, observados: [...observados.values()] };
}

function cabe(consumo, pedido, teto) {
  return consumo.tokens + pedido.tokens <= teto.tokens && usd6(consumo.usd + pedido.usd) <= teto.usd;
}
const tetoValido = (teto) => ({ tokens: Math.min(TETO.tokens, teto?.tokens ?? TETO.tokens), usd: Math.min(TETO.usd, teto?.usd ?? TETO.usd) });

/** Reserva de UMA chamada (antes de chamar o provedor). Recusada se o dia passaria do teto ou sem o livro único. */
export function reservar({ id = randomUUID(), consumidor, execucao = null, tokens, usd, teto, dia = diaOperacao() }) {
  try { exigirLivro(); } catch { return { ok: false, id, consumo: consumoDoDia(dia) }; }
  return comTrava(() => {
    const consumo = consumoDoDia(dia);
    if (!cabe(consumo, { tokens, usd }, tetoValido(teto))) return { ok: false, id, consumo };
    acrescentar({ evento: 'reserva', id, dia, consumidor, execucao, tokens, usd: usd6(usd), pid: process.pid });
    return { ok: true, id, consumo };
  });
}
/** Fecha a chamada com o uso real (tokens/usd conhecidos) ou pelo máximo reservado (desconhecido). */
export function fechar(id, { tokens, usd }) {
  comTrava(() => acrescentar({ evento: 'fecha', id, tokens, usd: usd6(usd) }));
}
/**
 * Só leitura (nada é reservado nem gravado): o saldo de hoje comporta `tokens`? Usada ANTES de pedir a chave de uma
 * rodada paga (rodada 10): sem saldo para uma rodada inteira, a chave nem é pedida.
 */
export function conferirSaldo({ tokens, usd = 0, teto, dia = diaOperacao() }) {
  try { exigirLivro(); } catch (erro) { return { ok: false, motivo: erro.message.split(':')[0], consumo: null, restam: 0 }; }
  const consumo = consumoDoDia(dia);
  const t = tetoValido(teto);
  return { ok: cabe(consumo, { tokens, usd }, t), motivo: null, consumo, restam: Math.max(0, t.tokens - consumo.tokens) };
}
export function abrirCota({ consumidor, descricao = null, tokens, usd, teto, dia = diaOperacao() }) {
  try { exigirLivro(); } catch { return { ok: false, id: null, consumo: consumoDoDia(dia) }; }
  return comTrava(() => {
    const consumo = consumoDoDia(dia);
    const id = `cota-${consumidor}-${Date.now().toString(36)}`;
    if (!cabe(consumo, { tokens, usd }, tetoValido(teto))) return { ok: false, id: null, consumo };
    acrescentar({ evento: 'cota', id, dia, consumidor, descricao, tokens, usd: usd6(usd), pid: process.pid });
    return { ok: true, id, consumo };
  });
}
export function fecharCota(id, { tokens, usd, nota = null }) {
  return comTrava(() => {
    const linhas = ler();
    const cota = linhas.find((l) => l.evento === 'cota' && l.id === id);
    if (!cota) throw new Error('COTA_INEXISTENTE');
    if (linhas.some((l) => l.evento === 'fecha-cota' && l.id === id)) throw new Error('COTA_JA_FECHADA');
    // Uso acima da cota não deveria acontecer (o teto da demonstração é a própria cota); se acontecer, fica o real.
    acrescentar({ evento: 'fecha-cota', id, tokens, usd: usd6(usd), nota });
    return { cota, tokens, usd };
  });
}
/**
 * Migração (uma vez): o livro único nasce da UNIÃO dos livros antigos, linha a linha (repetidas entram uma vez), em ordem
 * de tempo, com uma linha de criação que registra as origens. Recusada se o livro único já existe.
 */
export function migrar(origens, nota = null) {
  const arquivo = caminhoLivro();
  if (existsSync(arquivo)) throw new Error('LIVRO_USO_JA_EXISTE');
  const vistas = new Set();
  const linhas = [];
  const resumo = [];
  for (const origem of origens) {
    const brutas = readFileSync(origem, 'utf8').split('\n').filter((l) => l.trim());
    let novas = 0;
    for (const l of brutas) { const j = JSON.parse(l); const chave = JSON.stringify(j); if (!vistas.has(chave)) { vistas.add(chave); linhas.push(j); novas++; } }
    resumo.push({ arquivo: origem, linhas: brutas.length, novas });
  }
  linhas.sort((a, b) => String(a.em).localeCompare(String(b.em)));
  mkdirSync(path.dirname(arquivo), { recursive: true });
  const criacao = { em: new Date().toISOString(), evento: 'criacao', nota, origens: resumo };
  writeFileSync(arquivo, [criacao, ...linhas].map((l) => JSON.stringify(l)).join('\n') + '\n', { flag: 'wx' });
  return { arquivo, linhas: linhas.length, origens: resumo };
}
/** Livro novo e vazio (máquina nova); recusado se já existe. */
export function criarLivro(nota = null) {
  const arquivo = caminhoLivro();
  mkdirSync(path.dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, JSON.stringify({ em: new Date().toISOString(), evento: 'criacao', nota, origens: [] }) + '\n', { flag: 'wx' });
  return arquivo;
}
/** Fecha pelo MÁXIMO reservado uma chamada que ficou aberta (rodada interrompida: o uso real é desconhecido). */
export function fecharPeloMaximo(id, nota = null) {
  return comTrava(() => {
    const linhas = ler();
    const r = linhas.find((l) => l.evento === 'reserva' && l.id === id);
    if (!r) throw new Error('RESERVA_INEXISTENTE');
    if (linhas.some((l) => l.evento === 'fecha' && l.id === id)) throw new Error('RESERVA_JA_FECHADA');
    acrescentar({ evento: 'fecha', id, tokens: r.tokens, usd: r.usd, nota: nota ?? 'fechada pelo máximo reservado (uso real desconhecido)' });
    return r;
  });
}

/** Saldo de antes do livro, uma vez por (dia, origem): repetir não soma de novo. */
export function semear({ dia, origem, tokens, usd, nota = null }) {
  return comTrava(() => {
    if (ler().some((l) => l.evento === 'saldo-inicial' && l.dia === dia && l.origem === origem)) return false;
    acrescentar({ evento: 'saldo-inicial', dia, origem, tokens, usd: usd6(usd), nota });
    return true;
  });
}
/** Consumo lido de uma demonstração que não usa o livro (só leitura); a última leitura do dia vale. */
export function observar({ origem, tokens, usd, nota = null, dia = diaOperacao() }) {
  comTrava(() => acrescentar({ evento: 'observado', dia, origem, tokens, usd: usd6(usd), nota }));
}

/**
 * Registro de uso do roteador (o mesmo do avaliador, em memória) que também reserva e fecha CADA chamada no livro:
 * o teto vale entre processos e worktrees, e uma rodada interrompida deixa no livro tudo o que gastou.
 */
export function registroComLivro(interno, { consumidor, execucao, teto }) {
  const reservas = new Map();
  const fecharNoLivro = (id, uso) => {
    const r = reservas.get(id);
    if (!r) return;
    reservas.delete(id);
    const conhecido = uso && uso.tokensEntrada !== null && uso.tokensSaida !== null;
    fechar(id, conhecido ? { tokens: uso.tokensEntrada + uso.tokensSaida, usd: (uso.custoEstimadoMicros ?? r.custoMicros ?? 0) / 1e6 } : { tokens: r.tokens, usd: (r.custoMicros ?? 0) / 1e6 });
  };
  return Object.assign(Object.create(interno), {
    async reservar(pedido) {
      const usd = (pedido.custoMicros ?? 0) / 1e6;
      const r = reservar({ id: pedido.id, consumidor, execucao, tokens: pedido.tokens, usd, teto });
      if (!r.ok) return { ok: false, motivo: 'ORCAMENTO', recusa: { motivo: 'TETO_TOKENS', escopo: 'EMPRESA', periodo: 'DIA' } };
      const interna = await interno.reservar(pedido);
      if (!interna.ok) fechar(pedido.id, { tokens: 0, usd: 0 });
      else reservas.set(pedido.id, { tokens: pedido.tokens, custoMicros: pedido.custoMicros });
      return interna;
    },
    async reconciliar(id, uso) { try { return await interno.reconciliar(id, uso); } finally { fecharNoLivro(id, uso); } },
    async liberar(id, uso) { try { return await interno.liberar(id, uso); } finally { fecharNoLivro(id, { ...uso, tokensEntrada: 0, tokensSaida: 0, custoEstimadoMicros: 0 }); } },
    async registrar(uso) {
      // Sem reserva (não acontece com orçamento configurado): entra como chamada já fechada, pelo real ou pelo máximo.
      const id = randomUUID();
      const conhecido = uso.tokensEntrada !== null && uso.tokensSaida !== null;
      comTrava(() => {
        acrescentar({ evento: 'reserva', id, dia: diaOperacao(), consumidor, execucao, tokens: conhecido ? 0 : 1500, usd: conhecido ? 0 : 0.0003, pid: process.pid });
        acrescentar({ evento: 'fecha', id, tokens: conhecido ? uso.tokensEntrada + uso.tokensSaida : 1500, usd: conhecido ? (uso.custoEstimadoMicros ?? 0) / 1e6 : 0.0003 });
      });
      return interno.registrar(uso);
    },
    get usos() { return interno.usos; },
  });
}

// ---------------------------------------------------------------- linha de comando
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...resto] = process.argv.slice(2);
  const op = (nome, padrao = null) => { const i = resto.indexOf(nome); return i >= 0 ? resto[i + 1] : padrao; };
  const num = (nome) => { const v = Number(op(nome)); if (!Number.isFinite(v) || v < 0) { console.error(`${nome} inválido`); process.exit(2); } return v; };
  if (cmd === 'estado') {
    const c = consumoDoDia(op('--dia', diaOperacao()));
    console.log(`Livro: ${caminhoLivro()}${existsSync(caminhoLivro()) ? '' : ' (AUSENTE: nenhum gasto é permitido até criar ou migrar)'}`);
    for (const f of livrosAntigos().filter((x) => existsSync(x))) console.log(`  ATENÇÃO: livro antigo em uso em ${f} — migre antes de qualquer gasto.`);
    console.log(`Dia ${c.dia}: ${c.tokens} tokens e US$ ${c.usd.toFixed(6)} de ${TETO.tokens} tokens e US$ ${TETO.usd.toFixed(2)} (restam ${Math.max(0, TETO.tokens - c.tokens)} tokens e US$ ${Math.max(0, TETO.usd - c.usd).toFixed(6)}).`);
    for (const o of c.observados) console.log(`  observado ${o.origem}: ${o.tokens} tokens, US$ ${o.usd} (${o.em})`);
    for (const a of c.emAberto) console.log(`  em aberto ${a.evento} ${a.id} (${a.consumidor}): ${a.tokens} tokens, US$ ${a.usd}, desde ${a.em}, pid ${a.pid}`);
  } else if (cmd === 'conferir') {
    // Só leitura: código 0 se o saldo de hoje comporta --tokens; 3 (recusado) se não comporta ou se o livro não vale.
    const r = conferirSaldo({ tokens: num('--tokens'), usd: Number(op('--usd', 0)) || 0 });
    if (!r.ok) { console.error(r.motivo ? `Recusado: ${r.motivo}.` : `Recusado: o saldo de hoje não comporta ${op('--tokens')} tokens (usado: ${r.consumo.tokens} tokens, US$ ${r.consumo.usd.toFixed(6)}; restam ${r.restam}).`); process.exit(3); }
    console.log(`cabe: ${op('--tokens')} tokens (usado: ${r.consumo.tokens}; restam ${r.restam}).`);
  } else if (cmd === 'semear') {
    console.log(semear({ dia: op('--dia'), origem: op('--origem'), tokens: num('--tokens'), usd: num('--usd'), nota: op('--nota') }) ? 'semeado' : 'já existia (nada somado)');
  } else if (cmd === 'abrir-cota') {
    try { exigirLivro(); } catch (erro) { console.error('Recusado: ' + erro.message); process.exit(3); }
    const r = abrirCota({ consumidor: op('--consumidor'), descricao: op('--descricao'), tokens: num('--tokens'), usd: num('--usd') });
    if (!r.ok) { console.error(`Recusado: a cota não cabe no teto de hoje (usado: ${r.consumo.tokens} tokens, US$ ${r.consumo.usd}).`); process.exit(3); }
    console.log(r.id);
  } else if (cmd === 'fechar-cota') {
    const r = fecharCota(op('--id'), { tokens: num('--tokens'), usd: num('--usd'), nota: op('--nota') });
    console.log(`cota ${r.cota.id} fechada: ${r.tokens} tokens, US$ ${r.usd} (cota ${r.cota.tokens} tokens, US$ ${r.cota.usd})`);
  } else if (cmd === 'observar') {
    observar({ origem: op('--origem'), tokens: num('--tokens'), usd: num('--usd'), nota: op('--nota') });
    console.log('observado');
  } else if (cmd === 'criar') {
    console.log('livro único criado em ' + criarLivro(op('--nota')));
  } else if (cmd === 'migrar') {
    const de = resto.flatMap((x, i) => (x === '--de' ? [resto[i + 1]] : []));
    if (!de.length) { console.error('--de obrigatório'); process.exit(2); }
    const r = migrar(de, op('--nota'));
    console.log(`livro único criado em ${r.arquivo} com ${r.linhas} linhas:`);
    for (const o of r.origens) console.log(`  ${o.arquivo}: ${o.linhas} linhas (${o.novas} novas)`);
  } else if (cmd === 'fechar-reserva') {
    const r = fecharPeloMaximo(op('--id'), op('--nota'));
    console.log(`reserva ${r.id} (${r.execucao}) fechada pelo máximo: ${r.tokens} tokens, US$ ${r.usd}`);
  } else { console.error('uso: livro-uso-ia.mjs estado|semear|abrir-cota|fechar-cota|observar|migrar|fechar-reserva ...'); process.exit(2); }
}
