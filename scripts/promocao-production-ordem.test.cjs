/* eslint-disable @typescript-eslint/no-require-imports */
// Ordem da promoção de production (scripts/promocao-production-ordem.cjs): a ordem bate com o inventário aprovado (mesma
// ordem relativa, sem a 098), todo passo aponta para um aplicador que existe e aceita as flags declaradas — ou está entre os
// quatro que o outro lote entrega —, qualquer código diferente de 0 para a cadeia e o roteiro em docs/ é o gerado. Sem rede,
// sem banco e sem env: os aplicadores só são chamados sem RENDER, para provar que as flags são reconhecidas (recusa
// FORA_DO_RENDER antes de qualquer conexão).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const o = require('./promocao-production-ordem.cjs');

const raiz = path.resolve(__dirname, '..');
/** Os ÚNICOS aplicadores cuja ausência este teste aceita: são entregues pelo outro agente (102–103, 104–106, 107–108 e 109). */
const AUSENCIA_ACEITA_SO_DO_OUTRO_LOTE = Object.freeze(['scripts/migration-102-103-production.cjs', 'scripts/migration-104-106-production.cjs',
  'scripts/migration-107-108-production.cjs', 'scripts/migration-109-production.cjs']);
const PRIMEIRA = '089';
const existe = a => fs.existsSync(path.join(raiz, a));
const arquivoDe = p => (p.aplicador === 'generico' ? o.GENERICO : p.aplicador);
const ok = (lista, ate) => lista.slice(0, ate).map(x => ({...x, codigo: 0}));
const SEQUENCIA = o.PASSOS.flatMap(p => o.FASES.map(fase => ({id: p.id, fase})));

test('a ordem bate com approvedFiles do inventário: mesma ordem relativa a partir da 089, sem a 098; 099 e 105 já aplicadas', async () => {
  const {approvedFiles} = await import('./production/check-migrations.mjs');
  const inventario = approvedFiles.map(f => f.split('_')[1]);
  const daPromocao = inventario.slice(inventario.indexOf(PRIMEIRA));
  assert.equal(daPromocao[0], PRIMEIRA); assert.ok(!inventario.slice(0, inventario.indexOf(PRIMEIRA)).some(id => Number.parseInt(id, 10) >= 89));
  // Toda migration do inventário a partir da 089 aparece exatamente uma vez na ORDEM (aplicar, excluída ou já aplicada).
  const todas = o.ORDEM.flatMap(p => p.migrations);
  assert.deepEqual([...todas].sort(), [...daPromocao].sort()); assert.equal(new Set(todas).size, todas.length);
  // Fora da cadeia: só a 098 (excluída) e a 099/105 (já aplicadas), marcadas explicitamente e sem aplicador.
  const fora = o.ORDEM.filter(p => p.situacao !== 'APLICAR');
  assert.deepEqual(fora.map(p => [p.id, p.situacao, p.aplicador]), [['098', 'EXCLUIDA', null], ['099', 'JA_APLICADA', null], ['105', 'JA_APLICADA', null]]);
  assert.match(fora[0].escopo, /nunca entra/); assert.match(fora[0].escopo, /a 102 e a 108 recusam/);
  // Os passos que rodam, achatados, são o inventário sem 098, 099 e 105, NA MESMA ORDEM.
  const executadas = o.PASSOS.flatMap(p => p.migrations);
  assert.deepEqual(executadas, daPromocao.filter(id => !['098', '099', '105'].includes(id)));
  assert.ok(!executadas.includes('098') && !o.PASSOS.some(p => /098/.test(p.id) || /098/.test(arquivoDe(p))));
  // A cadeia pedida, passo a passo.
  assert.deepEqual(o.PASSOS.map(p => p.id), ['089', '090', '091', '092-093', '094', '095', '096', '097', '100', '102-103', '104-106', '107-108', '109',
    '114', '112', '116', '117', '118', '120', '121', '110', '111', '115']);
  assert.deepEqual(o.PASSOS.filter(p => p.aplicador === 'generico').map(p => p.id), ['120', '121', '110', '111', '115']);
  assert.deepEqual(o.PASSOS.filter(p => p.aplicador === 'generico').map(p => p.id), [...require('./migration-generico-production.cjs').IDS]);
  for (const p of o.ORDEM) { assert.ok(Object.isFrozen(p) && Object.isFrozen(p.migrations), p.id); assert.ok(typeof p.escopo === 'string' && p.escopo.length > 10, p.id); }
});

test('todo passo aponta para um aplicador que EXISTE, ou está na lista nomeada dos quatro que o outro lote entrega', () => {
  assert.deepEqual([...o.PENDENTES_DO_OUTRO_LOTE], [...AUSENCIA_ACEITA_SO_DO_OUTRO_LOTE]);
  const ausentes = [];
  for (const p of o.PASSOS) {
    const a = arquivoDe(p);
    assert.match(a, /^scripts\/migration-[0-9a-z-]+-production\.cjs$/, p.id);
    if (!existe(a)) { ausentes.push(a); assert.ok(AUSENCIA_ACEITA_SO_DO_OUTRO_LOTE.includes(a), `aplicador ausente fora do outro lote: ${a}`); }
    assert.equal(Boolean(p.outroLote), AUSENCIA_ACEITA_SO_DO_OUTRO_LOTE.includes(a), p.id);
  }
  assert.ok(ausentes.every(a => AUSENCIA_ACEITA_SO_DO_OUTRO_LOTE.includes(a)));
  // Os passos deste lote e os já existentes NÃO podem faltar.
  for (const id of ['089', '090', '091', '092-093', '094', '095', '096', '097', '100', '114', '112', '116', '117', '118', '120', '121', '110', '111', '115'])
    assert.ok(existe(arquivoDe(o.PASSOS.find(p => p.id === id))), id);
  assert.ok(existe(o.GENERICO));
  // Geradores de bloco citados existem.
  for (const p of o.PASSOS.filter(x => x.bloco)) assert.ok(existe(/^node (scripts\/[^ ]+)/.exec(p.bloco)[1]), p.id + ': ' + p.bloco);
});

test('as flags declaradas são as que o aplicador de produção reconhece: sem RENDER, recusa FORA_DO_RENDER (e não ARGUMENTOS_RECUSADOS), sem conectar', async () => {
  const Proibido = class { constructor() { assert.fail('não pode conectar'); } };
  for (const p of o.PASSOS.filter(x => existe(arquivoDe(x)))) {
    const aplicador = require(path.join(raiz, arquivoDe(p)));
    await assert.rejects(aplicador.principal(p.conferir.split(' '), {}, {Client: Proibido}), /FORA_DO_RENDER/, `${p.id} conferir`);
    // 118: o registro do backup tem formato próprio (PITR com horário recente), conferido antes do alvo.
    const backup = p.id === '118' ? `PITR ${new Date(Date.now() - 60000).toISOString().slice(0, 16)}Z ensaio` : 'dump 2026-11-12T03:00Z PITR';
    const extra = p.aposBackup ? ['--drenagem', 'web em manutencao 2026-11-12T03:00Z cron suspenso'] : [];
    await assert.rejects(aplicador.principal([...p.aplicar.split(' '), '--backup', backup, ...extra], {}, {Client: Proibido}), /FORA_DO_RENDER/, `${p.id} aplicar`);
    assert.equal(o.comando(p, 'CONFERIR'), `node ${arquivoDe(p)} ${p.conferir}`); assert.equal(o.comando(p, 'CONFERIR_DEPOIS'), o.comando(p, 'CONFERIR'));
    assert.equal(o.comando(p, 'APLICAR'), `node ${arquivoDe(p)} ${p.aplicar} --backup "<registro-do-backup>"${p.aposBackup ? ' ' + p.aposBackup : ''}`);
  }
  assert.throws(() => o.comando(o.PASSOS[0], 'DOWN'), /FASE_DESCONHECIDA/);
});

test('proximoPasso: começa no CONFERIR da 089, segue CONFERIR → APLICAR → CONFERIR_DEPOIS de cada passo e conclui só com tudo 0', () => {
  assert.deepEqual(o.FASES, ['CONFERIR', 'APLICAR', 'CONFERIR_DEPOIS']);
  const primeiro = o.proximoPasso([]);
  assert.equal(primeiro.acao, 'EXECUTAR'); assert.equal(primeiro.id, '089'); assert.equal(primeiro.fase, 'CONFERIR');
  assert.equal(primeiro.comando, 'node scripts/migration-089-production.cjs --conferir-089'); assert.deepEqual(o.proximoPasso(), primeiro);
  for (let n = 0; n < SEQUENCIA.length; n++) {
    const r = o.proximoPasso(ok(SEQUENCIA, n));
    assert.equal(r.acao, 'EXECUTAR'); assert.deepEqual({id: r.id, fase: r.fase}, SEQUENCIA[n]);
    assert.equal(r.exige !== undefined, r.fase === 'APLICAR', 'autorização e backup lembrados só no APLICAR');
  }
  assert.deepEqual(o.proximoPasso(ok(SEQUENCIA, SEQUENCIA.length)), {acao: 'CONCLUIDA', passos: 23});
  // O 094 lembra o deploy do código novo antes do CONFERIR dele.
  const i094 = SEQUENCIA.findIndex(x => x.id === '094');
  assert.match(o.proximoPasso(ok(SEQUENCIA, i094)).exigeAntes, /deploy do código NOVO/);
  assert.equal(o.proximoPasso(ok(SEQUENCIA, i094 - 1)).exigeAntes, undefined);
  // O genérico recebe o id como argumento.
  const i120 = SEQUENCIA.findIndex(x => x.id === '120');
  assert.equal(o.proximoPasso(ok(SEQUENCIA, i120 + 1)).comando, 'node scripts/migration-generico-production.cjs --aplicar-autorizado 120 --backup "<registro-do-backup>"');
});

test('QUALQUER código diferente de 0 para a cadeia, em qualquer passo e fase; nunca devolve o passo seguinte', () => {
  for (let n = 0; n < SEQUENCIA.length; n++) {
    for (const codigo of [1, 2, 3, 4, 127, 143, -1, null, undefined, '0', '', true, false, 0.5, NaN]) {
      const r = o.proximoPasso([...ok(SEQUENCIA, n), {...SEQUENCIA[n], codigo}]);
      assert.equal(r.acao, 'PARAR', `${SEQUENCIA[n].id} ${SEQUENCIA[n].fase} ${String(codigo)}`); assert.equal(r.motivo, 'CODIGO_DIFERENTE_DE_ZERO');
      assert.deepEqual({id: r.id, fase: r.fase}, SEQUENCIA[n]); assert.ok(typeof r.significado === 'string' && r.significado.length > 0);
      // Mesmo que venham resultados 0 depois, a cadeia continua parada no primeiro diferente de 0.
      const depois = o.proximoPasso([...ok(SEQUENCIA, n), {...SEQUENCIA[n], codigo}, ...SEQUENCIA.slice(n + 1, n + 3).map(x => ({...x, codigo: 0}))]);
      assert.equal(depois.acao, 'PARAR'); assert.deepEqual({id: depois.id, fase: depois.fase}, SEQUENCIA[n]);
    }
  }
  const falha = o.proximoPasso([...ok(SEQUENCIA, 1), {...SEQUENCIA[1], codigo: 2}]);
  assert.match(falha.significado, /FALHA registrada/); assert.equal(falha.reconciliar, 'node scripts/migration-089-production.cjs --conferir-089');
  assert.match(o.proximoPasso([{...SEQUENCIA[0], codigo: 3}]).significado, /RECUSARIA/); assert.equal(o.proximoPasso([{...SEQUENCIA[0], codigo: 3}]).reconciliar, null);
  assert.match(o.proximoPasso([{...SEQUENCIA[0], codigo: 4}]).significado, /bloco de Shell/); assert.match(o.proximoPasso([{...SEQUENCIA[0], codigo: 9}]).significado, /desconhecido/);
});

test('entrada fora da sequência ou ilegível também para: passo ou fase pulados, repetidos, desconhecidos, a 098, resultados a mais', () => {
  const p = (lista, motivo) => { const r = o.proximoPasso(lista); assert.equal(r.acao, 'PARAR', JSON.stringify(lista).slice(0, 120)); assert.equal(r.motivo, motivo); return r; };
  p([{id: '090', fase: 'CONFERIR', codigo: 0}], 'FORA_DA_ORDEM');
  p([{id: '089', fase: 'APLICAR', codigo: 0}], 'FORA_DA_ORDEM');
  p([{...SEQUENCIA[0], codigo: 0}, {...SEQUENCIA[0], codigo: 0}], 'FORA_DA_ORDEM');
  p([...ok(SEQUENCIA, 3), {id: '091', fase: 'CONFERIR', codigo: 0}], 'FORA_DA_ORDEM');
  p([{id: '098', fase: 'CONFERIR', codigo: 0}], 'FORA_DA_ORDEM');
  p([{id: '099', fase: 'CONFERIR', codigo: 0}], 'FORA_DA_ORDEM');
  assert.deepEqual(p([{id: 'x', fase: 'CONFERIR', codigo: 0}], 'FORA_DA_ORDEM').esperado, {id: '089', fase: 'CONFERIR'});
  p([null], 'RESULTADOS_ILEGIVEIS'); p([0], 'RESULTADOS_ILEGIVEIS'); p('tudo certo', 'RESULTADOS_ILEGIVEIS'); p({}, 'RESULTADOS_ILEGIVEIS'); p(null, 'RESULTADOS_ILEGIVEIS');
  p([...ok(SEQUENCIA, SEQUENCIA.length), {id: '115', fase: 'CONFERIR', codigo: 0}], 'RESULTADO_ALEM_DA_CADEIA');
});

test('regra de volta: antes da 094 o deploy anterior basta; da 094 em diante, restaurar o backup ou corrigir para a frente', () => {
  assert.equal(o.PONTO_SEM_VOLTA_POR_DEPLOY, '094');
  assert.deepEqual(o.PASSOS.filter(p => o.volta(p.id) === 'DEPLOY_ANTERIOR').map(p => p.id), ['089', '090', '091', '092-093']);
  for (const p of o.PASSOS.slice(4)) assert.equal(o.volta(p.id), 'RESTAURAR_BACKUP_OU_CORRIGIR_PARA_A_FRENTE', p.id);
  assert.throws(() => o.volta('098'), /PASSO_DESCONHECIDO/);
  assert.equal(o.proximoPasso([]).volta, 'DEPLOY_ANTERIOR');
  assert.equal(o.proximoPasso([...ok(SEQUENCIA, 12), {...SEQUENCIA[12], codigo: 2}]).volta, 'RESTAURAR_BACKUP_OU_CORRIGIR_PARA_A_FRENTE');
});

test('módulo puro: não conecta, não lê env, não grava; o roteiro em docs/ é exatamente o texto gerado, sem promessa de execução', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'promocao-production-ordem.cjs'), 'utf8');
  assert.deepEqual([...fonte.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]), ['node:assert/strict'], 'só o assert: nem pg, nem fs, nem rede');
  assert.doesNotMatch(fonte, /process\.env|DATABASE_URL|writeFile|child_process|fetch\(/);
  const doc = fs.readFileSync(path.join(raiz, 'docs/PROMOCAO_UNICA_PRODUCTION_20261112.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(doc, o.roteiro());
  assert.match(doc, /Isto é um roteiro, não uma autorização/); assert.match(doc, /Nada aqui foi executado em production nem em staging/);
  assert.match(doc, /Qualquer código de saída diferente de 0 para a cadeia/);
  for (const p of o.PASSOS) for (const fase of o.FASES) assert.ok(doc.includes('`' + o.comando(p, fase) + '`'), `${p.id} ${fase}`);
  assert.ok(doc.indexOf('### 1. 089') < doc.indexOf('### 5. 094') && doc.indexOf('### 5. 094') < doc.indexOf('### 23. 115'));
  assert.match(doc, /\| 098 \| EXCLUIDA \|/); assert.match(doc, /\| 099 \| JA_APLICADA \|/); assert.match(doc, /\| 105 \| JA_APLICADA \|/);
  assert.doesNotMatch(doc, /SENHA|postgres(ql)?:\/\/|dpg-/);
});
