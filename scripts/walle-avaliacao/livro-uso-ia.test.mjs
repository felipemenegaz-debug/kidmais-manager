// Livro único de uso de IA (livro-uso-ia.mjs): teto do dia somado entre processos, chamadas no ar e rodadas
// interrompidas contadas, cota de demonstração, saldo semeado uma vez. Arquivo temporário próprio; sem rede, sem banco.
//   node --test scripts/walle-avaliacao/livro-uso-ia.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const pasta = mkdtempSync(path.join(tmpdir(), 'walle-livro-'));
process.env.KIDMAIS_WALLE_LIVRO_TESTE = '1';
process.env.KIDMAIS_WALLE_LIVRO_USO = path.join(pasta, 'livro.jsonl');
// Livros antigos do AppData isolados nesta pasta (o teste não depende do que existe na máquina).
const antigo = path.join(pasta, 'appdata-antigo', 'livro.jsonl');
process.env.KIDMAIS_WALLE_LIVRO_LEGADO = antigo;
const livro = await import('./livro-uso-ia.mjs');
const linhas = () => readFileSync(process.env.KIDMAIS_WALLE_LIVRO_USO, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
test.after(() => rmSync(pasta, { recursive: true, force: true }));

test('sem livro criado ou migrado, nada é reservado nem gravado (o livro nunca nasce vazio por engano)', () => {
  assert.equal(livro.reservar({ consumidor: 'teste', tokens: 10, usd: 0.0001 }).ok, false);
  assert.equal(livro.abrirCota({ consumidor: 'demo-teste', tokens: 10, usd: 0.0001 }).ok, false);
  assert.throws(() => livro.observar({ origem: 'x', tokens: 0, usd: 0 }), /LIVRO_USO_AUSENTE/);
  assert.throws(() => livro.exigirLivro(), /LIVRO_USO_AUSENTE/);
});

test('migração: o livro único nasce da união dos livros antigos (sem repetir linha) e só uma vez', () => {
  const a = path.join(pasta, 'a.jsonl'), b = path.join(pasta, 'b.jsonl');
  const comum = { em: '2030-01-01T10:00:00.000Z', evento: 'saldo-inicial', dia: '2030-01-01', origem: 'x', tokens: 100, usd: 0.0001 };
  writeFileSync(a, [comum, { em: '2030-01-01T09:00:00.000Z', evento: 'observado', dia: '2030-01-01', origem: 'demo', tokens: 0, usd: 0 }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(b, [comum, { em: '2030-01-01T11:00:00.000Z', evento: 'reserva', id: 'r1', dia: '2030-01-01', consumidor: 'avaliador', tokens: 5000, usd: 0.0007 }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = livro.migrar([a, b], 'teste');
  assert.deepEqual(r.origens.map((o) => [o.linhas, o.novas]), [[2, 2], [2, 1]]);
  assert.deepEqual(linhas().map((l) => l.evento), ['criacao', 'observado', 'saldo-inicial', 'reserva']);
  assert.throws(() => livro.migrar([a], 'de novo'), /LIVRO_USO_JA_EXISTE/);
  assert.equal(livro.consumoDoDia('2030-01-01').tokens, 5100, 'reserva aberta conta pelo máximo');
  livro.fecharPeloMaximo('r1', 'rodada interrompida');
  assert.equal(livro.consumoDoDia('2030-01-01').tokens, 5100);
  assert.equal(livro.consumoDoDia('2030-01-01').emAberto.length, 0);
  assert.throws(() => livro.fecharPeloMaximo('r1'), /RESERVA_JA_FECHADA/);
});

test('livro antigo do AppData voltando a ser usado: nada é reservado até migrar', () => {
  mkdirSync(path.dirname(antigo), { recursive: true });
  writeFileSync(antigo, '{}\n');
  assert.throws(() => livro.exigirLivro(), /LIVRO_USO_ANTIGO_EM_USO/);
  assert.equal(livro.reservar({ consumidor: 'teste', tokens: 10, usd: 0.0001, dia: '2030-01-05' }).ok, false);
  rmSync(antigo);
  assert.doesNotThrow(() => livro.exigirLivro());
});

test('reserva fecha pelo real; recusa o que passaria do teto; chamada no ar conta pelo máximo; saldo semeado uma vez', () => {
  const dia = '2030-01-02';
  assert.equal(livro.semear({ dia, origem: 'antes-do-livro', tokens: 1000, usd: 0.001 }), true);
  assert.equal(livro.semear({ dia, origem: 'antes-do-livro', tokens: 1000, usd: 0.001 }), false, 'repetir não soma');
  const teto = { tokens: 5000, usd: 1 };
  const a = livro.reservar({ consumidor: 'teste', tokens: 1500, usd: 0.0003, teto, dia });
  assert.equal(a.ok, true);
  assert.equal(livro.consumoDoDia(dia).tokens, 2500, 'no ar: pelo máximo');
  livro.fechar(a.id, { tokens: 900, usd: 0.0001 });
  assert.equal(livro.consumoDoDia(dia).tokens, 1900, 'fechada: pelo real');
  const b = livro.reservar({ consumidor: 'teste', tokens: 1500, usd: 0.0003, teto, dia });
  assert.equal(b.ok, true, 'interrompida: fica aberta');
  assert.equal(livro.reservar({ consumidor: 'teste', tokens: 1700, usd: 0.0003, teto, dia }).ok, false, '1900 + 1500 (no ar) + 1700 > 5000');
  assert.equal(livro.consumoDoDia(dia).emAberto.length, 1);
  // O teto pedido nunca passa do autorizado.
  assert.equal(livro.reservar({ consumidor: 'teste', tokens: 400000, usd: 0.0003, teto: { tokens: 10_000_000, usd: 10 }, dia }).ok, false);
});

test('cota de demonstração conta inteira enquanto aberta e fica pelo real ao fechar', () => {
  const dia = livro.diaOperacao();
  const antes = livro.consumoDoDia(dia).tokens;
  const c = livro.abrirCota({ consumidor: 'demo-teste', tokens: 40000, usd: 0.03, dia });
  assert.equal(c.ok, true);
  assert.equal(livro.consumoDoDia(dia).tokens, antes + 40000);
  livro.fecharCota(c.id, { tokens: 1234, usd: 0.0002, nota: 'lido do banco da demonstração' });
  assert.equal(livro.consumoDoDia(dia).tokens, antes + 1234);
  assert.throws(() => livro.fecharCota(c.id, { tokens: 1, usd: 0 }), /COTA_JA_FECHADA/);
});

test('vários processos reservando ao mesmo tempo nunca passam do teto (trava entre processos)', async () => {
  const dia = '2030-01-03';
  const filho = (n) => new Promise((resolve, reject) => {
    const codigo = `const l = await import(${JSON.stringify(pathToFileURL(path.join(aqui, 'livro-uso-ia.mjs')).href)});
      let ok = 0; for (let i = 0; i < 12; i++) if (l.reservar({ consumidor: 'proc-${n}', tokens: 1000, usd: 0.0001, teto: { tokens: 10000, usd: 1 }, dia: '${dia}' }).ok) ok++;
      console.log(ok);`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', codigo], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] });
    let saida = '';
    p.stdout.on('data', (d) => { saida += d; });
    p.on('exit', (cod) => (cod === 0 ? resolve(Number(saida.trim())) : reject(new Error(`filho ${n} saiu com ${cod}`))));
  });
  const aceitas = (await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(filho))).reduce((s, x) => s + x, 0);
  assert.equal(aceitas, 10, '10 × 1000 = teto; o resto recusado');
  assert.equal(livro.consumoDoDia(dia).tokens, 10000);
  assert.equal(linhas().filter((l) => l.evento === 'reserva' && l.dia === dia).length, 10);
});

test('registro do avaliador com o livro: cada chamada reservada e fechada; recusa do livro vira recusa de orçamento', async () => {
  const usos = [];
  const interno = { usos, reservas: new Map(), async reservar() { return { ok: true }; }, async reconciliar(_id, uso) { usos.push(uso); }, async liberar(_id, uso) { usos.push(uso); }, async registrar(uso) { usos.push(uso); }, async recuperarOrfas() { return 0; } };
  const dia = livro.diaOperacao();
  const base = livro.consumoDoDia(dia).tokens;
  const r = livro.registroComLivro(interno, { consumidor: 'avaliador-teste', execucao: 'x', teto: { tokens: base + 3000, usd: 1 } });
  const pedido = (id) => ({ id, empresaId: 'e', capacidade: 'whatsapp_atendimento', correlationId: id, em: new Date().toISOString(), periodos: { dia, mes: dia.slice(0, 7) }, tokens: 1500, custoMicros: 300, moeda: 'USD', limites: [] });
  assert.deepEqual(await r.reservar(pedido('c1')), { ok: true });
  await r.reconciliar('c1', { tokensEntrada: 800, tokensSaida: 100, custoEstimadoMicros: 120 });
  assert.equal(livro.consumoDoDia(dia).tokens, base + 900);
  assert.deepEqual(await r.reservar(pedido('c2')), { ok: true });
  await r.reconciliar('c2', { tokensEntrada: null, tokensSaida: null, custoEstimadoMicros: null });
  assert.equal(livro.consumoDoDia(dia).tokens, base + 900 + 1500, 'uso desconhecido fica pelo máximo');
  const recusa = await livro.registroComLivro(interno, { consumidor: 'avaliador-teste', execucao: 'x', teto: { tokens: base + 2500, usd: 1 } }).reservar(pedido('c3'));
  assert.equal(recusa.ok, false);
  assert.equal(recusa.motivo, 'ORCAMENTO');
  assert.equal(r.usos, usos);
});

// ---------------------------------------------------------------- rodada 9: o teto agregado de verdade
/** Processo filho que usa o livro (o mesmo arquivo, por variável de ambiente); devolve o que imprimir. */
function processo(codigo, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `const l = await import(${JSON.stringify(pathToFileURL(path.join(aqui, 'livro-uso-ia.mjs')).href)});\n${codigo}`],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '', erro = '';
    p.stdout.on('data', (d) => { saida += d; });
    p.stderr.on('data', (d) => { erro += d; });
    p.on('exit', (cod) => resolve({ cod, saida: saida.trim(), erro }));
    p.on('error', reject);
  });
}

test('rodada 9 — desvio de caminho sem a marca de teste: nenhum gasto (o defeito do livro dividido não volta)', async () => {
  const r = await processo(`try { l.exigirLivro(); console.log('passou'); } catch (e) { console.log(e.message.split(':')[0]); }
    console.log(l.reservar({ consumidor: 'x', tokens: 1, usd: 0 }).ok);`, { KIDMAIS_WALLE_LIVRO_TESTE: '' });
  assert.deepEqual(r.saida.split(/\r?\n/), ['LIVRO_USO_DESVIADO', 'false']);
});

test('rodada 10 — conferir o saldo antes da chave: só lê (nada gravado); recusa sem saldo, com cota aberta pelo máximo e com desvio', async () => {
  const dia = '2030-03-01';
  const teto = { tokens: 100000, usd: 1 };
  const antes = linhas().length;
  assert.equal(livro.conferirSaldo({ tokens: 98000, teto, dia }).ok, true);
  const cota = livro.abrirCota({ consumidor: 'demo-r10', tokens: 5000, usd: 0.001, teto, dia });
  assert.equal(cota.ok, true);
  const r = livro.conferirSaldo({ tokens: 98000, teto, dia });
  assert.deepEqual([r.ok, r.restam], [false, 95000], 'a cota aberta conta inteira');
  assert.equal(linhas().length, antes + 1, 'conferir não grava nada (só a cota entrou)');
  livro.fecharCota(cota.id, { tokens: 0, usd: 0 });
  // Linha de comando: código 3 quando não cabe no teto do dia de hoje; desvio sem a marca de teste também recusa.
  const cli = (args, env = {}) => new Promise((resolve) => { const p = spawn(process.execPath, [path.join(aqui, 'livro-uso-ia.mjs'), ...args], { env: { ...process.env, ...env } }); p.on('exit', resolve); });
  assert.equal(await cli(['conferir', '--tokens', '300001']), 3);
  assert.equal(await cli(['conferir', '--tokens', '1']), 0);
  assert.equal(await cli(['conferir', '--tokens', '1'], { KIDMAIS_WALLE_LIVRO_TESTE: '' }), 3);
});

test('rodada 9 — demonstração (cota) e avaliadores em processos paralelos somam no MESMO teto; a cota fechada devolve a sobra', async () => {
  const dia = '2030-02-01';
  const teto = { tokens: 10000, usd: 1 };
  const cota = livro.abrirCota({ consumidor: 'demo-r9', tokens: 4000, usd: 0.03, teto, dia });
  assert.equal(cota.ok, true);
  const avaliador = (n) => processo(`let ok = 0; for (let i = 0; i < 4; i++) if (l.reservar({ consumidor: 'avaliador-${n}', tokens: 1000, usd: 0.0001, teto: ${JSON.stringify(teto)}, dia: '${dia}' }).ok) ok++; console.log(ok);`);
  const aceitas = (await Promise.all([1, 2, 3, 4].map(avaliador))).reduce((s, x) => s + Number(x.saida), 0);
  assert.equal(aceitas, 6, '4000 da cota + 6 × 1000 = teto; o resto recusado');
  assert.equal(livro.consumoDoDia(dia).tokens, 10000);
  // A demonstração usou 500 de verdade: a cota fecha pelo real e a sobra volta ao teto do dia.
  livro.fecharCota(cota.id, { tokens: 500, usd: 0.0001, nota: 'lido do banco da demonstração' });
  assert.equal(livro.consumoDoDia(dia).tokens, 6500);
  let mais = 0; for (let i = 0; i < 5; i++) if (livro.reservar({ consumidor: 'avaliador-x', tokens: 1000, usd: 0.0001, teto, dia }).ok) mais++;
  assert.equal(mais, 3);
});

test('rodada 9 — processo morto com a chamada no ar e demonstração derrubada sem parar: contam pelo máximo até fechar', async () => {
  const dia = '2030-02-02';
  const teto = { tokens: 6000, usd: 1 };
  // O filho reserva e morre sem fechar (Ctrl+C, queda): a reserva fica aberta no livro.
  const morto = await processo(`const r = l.reservar({ consumidor: 'avaliador-morto', tokens: 1500, usd: 0.0003, teto: ${JSON.stringify(teto)}, dia: '${dia}' }); console.log(r.id); process.exit(1);`);
  assert.equal(morto.cod, 1);
  const cota = livro.abrirCota({ consumidor: 'demo-derrubada', tokens: 4000, usd: 0.03, teto, dia });
  assert.equal(livro.consumoDoDia(dia).tokens, 5500);
  assert.deepEqual(livro.consumoDoDia(dia).emAberto.map((x) => x.evento).sort(), ['cota', 'reserva']);
  assert.equal(livro.reservar({ consumidor: 'outro', tokens: 1000, usd: 0.0001, teto, dia }).ok, false, 'o que ficou no ar ocupa o teto');
  livro.fecharPeloMaximo(morto.saida, 'processo morto: uso real desconhecido');
  assert.equal(livro.consumoDoDia(dia).tokens, 5500, 'fechada pelo máximo: o total não cai');
  assert.ok(cota.ok);
});

test('rodada 9 — virada do dia: a chamada reservada às 23h59 fecha depois e conta no dia da reserva, não no seguinte', () => {
  const [d1, d2] = ['2030-02-03', '2030-02-04'];
  const r = livro.reservar({ consumidor: 'avaliador', tokens: 1500, usd: 0.0003, dia: d1 });
  livro.fechar(r.id, { tokens: 1100, usd: 0.0001 });
  assert.equal(livro.consumoDoDia(d1).tokens, 1100);
  assert.equal(livro.consumoDoDia(d2).tokens, 0);
});

test('rodada 9 — trava abandonada (processo morto com a trava) é desfeita depois de 30 s; trava recente é respeitada', async () => {
  const { utimesSync } = await import('node:fs');
  const trava = `${process.env.KIDMAIS_WALLE_LIVRO_USO}.trava`;
  writeFileSync(trava, '99999 abandonada');
  const velha = new Date(Date.now() - 60_000);
  utimesSync(trava, velha, velha);
  assert.equal(livro.reservar({ consumidor: 'depois-da-queda', tokens: 1, usd: 0, dia: '2030-02-05' }).ok, true);
  writeFileSync(trava, '99999 agora');
  const r = await processo(`const t0 = Date.now(); try { l.reservar({ consumidor: 'espera', tokens: 1, usd: 0, dia: '2030-02-05' }); console.log('passou'); } catch (e) { console.log(e.message, Date.now() - t0 >= 14000); }`);
  rmSync(trava, { force: true });
  assert.equal(r.saida, 'LIVRO_USO_TRAVADO true');
});

test('rodada 31: detalhe de falha do provedor gravado SANEADO (status e identificadores; nunca mensagem nem chave)', async () => {
  const { detalheSaneado } = await import('./simulacao.mjs');
  assert.deepEqual(detalheSaneado({ status: 401, tipo: 'invalid_request_error', codigo: 'invalid_api_key', parametro: null }), { status: 401, tipo: 'invalid_request_error', codigo: 'invalid_api_key', parametro: null });
  assert.deepEqual(detalheSaneado({ status: 429, tipo: 'insufficient_quota', codigo: 'credit balance: sk-proj-abc', parametro: 'x y', mensagem: 'Incorrect API key provided: sk-xxxx' }), { status: 429, tipo: 'insufficient_quota', codigo: null, parametro: null });
  assert.equal(detalheSaneado(null), null);
  assert.equal(JSON.stringify(detalheSaneado({ status: 400, tipo: 'a', codigo: 'b', chave: 'sk-123' })).includes('sk-'), false);
});
