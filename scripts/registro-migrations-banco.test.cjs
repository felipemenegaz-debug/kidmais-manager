/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
// Testes sem banco do registro de migrations (vault "Registro de migrations no banco 20261120", §4): ordem de eventos da
// sessão de leitura com cliente falso (pontos 1–7 da r15), argumentos e estáticos. Os casos com PG estão em
// registro-migrations-banco.postgres.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');
const r = require('./registro-migrations-banco.cjs');

const raiz = path.resolve(__dirname, '..');
const fonte = fs.readFileSync(path.join(__dirname, 'registro-migrations-banco.cjs'), 'utf8');
const erroPg = (code, severity = 'ERROR', message = 'erro ' + code) => Object.assign(new Error(message), {code, severity});

/** Cliente falso: `roteiro(texto, cliente)` devolve o resultado (ou uma promessa); o log guarda tudo o que foi enviado. */
function fabrica(roteiro, opcoes = {}) {
  const clientes = [];
  function Client(cfg) {
    const c = new EventEmitter();
    c.cfg = cfg; c.log = []; c.processID = 1000 + clientes.length; c.destruido = false;
    c.connect = async () => { c.log.push('CONNECT'); if (opcoes.connect) await opcoes.connect(c); };
    c.query = (texto, params) => { c.log.push(texto); return Promise.resolve().then(() => roteiro(texto, c, params)); };
    c.end = () => { c.log.push('END'); return (opcoes.end ? opcoes.end(c) : Promise.resolve()).then(v => { c.emit('end'); return v; }); };
    c.destruir = () => { c.destruido = true; c.log.push('DESTRUIR'); };
    clientes.push(c);
    return c;
  }
  return {Client, clientes};
}
const padrao = texto => {
  if (/^SELECT 'ident'/.test(texto)) return {rows: [{ok: true}]};
  if (texto === 'SHOW transaction_read_only') return {rows: [{transaction_read_only: 'on'}]};
  if (texto === 'SHOW transaction_isolation') return {rows: [{transaction_isolation: 'read committed'}]};
  return {rows: [], rowCount: 0};
};
const ctxDe = (Client, extra = {}) => ({
  raiz, Client, out: () => {}, prazoRollback: 200, prazoDescarte: 200, prazoLiquidacao: 100,
  ambiente: {nome: 'staging', alvo: app => ({application_name: app}), sqlIdentidade: "SELECT 'ident'", identidade: l => assert.ok(l?.ok)},
  ...extra,
});
const enviados = c => c.log.filter(x => typeof x === 'string');
const rollbacks = c => enviados(c).filter(x => x === 'ROLLBACK').length;

test('P0001 só vira FALHOU na instrução marcada; fora dela é erro de verificação', async () => {
  const {Client, clientes} = fabrica(t => { if (t === 'PC' || t === 'AUX') throw erroPg('P0001'); return padrao(t); });
  let v;
  const s1 = await r.abrirSessaoLeitura(ctxDe(Client), 'ESTADO 130', async s => { v = await s.instrucao('POSTCHECK', 'PC', undefined, {ehPostcheck: true}); });
  assert.equal(s1.falha, null); assert.match(v.falhou, /P0001|erro/); assert.equal(rollbacks(clientes[0]), 1);
  const s2 = await r.abrirSessaoLeitura(ctxDe(Client), 'ESTADO 130', async s => { await s.instrucao('AUXILIAR', 'AUX'); });
  assert.deepEqual(s2.falha, {rotulo: 'AUXILIAR', codigo: 'P0001'});
});

test('rejeição 57P01 antes do evento error: PERDIDA na rejeição, zero ROLLBACK, uma falha', async () => {
  const {Client, clientes} = fabrica((t, c) => {
    if (t === 'PC') { setTimeout(() => c.emit('error', erroPg('57P01', 'FATAL')), 5); throw erroPg('57P01', 'FATAL'); }
    return padrao(t);
  });
  const s = await r.abrirSessaoLeitura(ctxDe(Client), 'ESTADO 130', async x => { await x.instrucao('POSTCHECK', 'PC', undefined, {ehPostcheck: true}); });
  assert.deepEqual(s.falha, {rotulo: 'POSTCHECK', codigo: '57P01'});
  assert.equal(rollbacks(clientes[0]), 0);
  assert.equal(r.abrirSessaoLeitura.length >= 3, true);
});

test('evento end antes da rejeição 57P01: rótulo da 1ª observação e código preenchido pela rejeição (ponto 3)', async () => {
  const {Client, clientes} = fabrica((t, c) => {
    if (t === 'PC') return new Promise((_, rej) => { c.emit('end'); setTimeout(() => rej(erroPg('57P01', 'FATAL')), 20); });
    return padrao(t);
  });
  const s = await r.abrirSessaoLeitura(ctxDe(Client), 'ESTADO 130', async x => { await x.instrucao('POSTCHECK', 'PC', undefined, {ehPostcheck: true}); });
  assert.deepEqual(s.falha, {rotulo: 'POSTCHECK', codigo: '57P01'});
  assert.equal(rollbacks(clientes[0]), 0);
});

test('perda sem liquidação da instrução: depois do prazo segue com sqlstate=indisponivel, sem ROLLBACK', async () => {
  const {Client, clientes} = fabrica((t, c) => { if (t === 'PC') { c.emit('end'); return new Promise(() => {}); } return padrao(t); });
  const s = await r.abrirSessaoLeitura(ctxDe(Client), 'ESTADO 130', async x => { await x.instrucao('POSTCHECK', 'PC'); });
  assert.deepEqual(s.falha, {rotulo: 'POSTCHECK', codigo: null});
  assert.match(require('./registro-migrations-banco.cjs').conferirRegistro.toString(), /textoFalha/);
  assert.equal(rollbacks(clientes[0]), 0);
});

test('severidade FATAL com SQLSTATE comum (25P03) marca PERDIDA (ponto 4)', async () => {
  const {Client, clientes} = fabrica(t => { if (t === 'PC') throw erroPg('25P03', 'FATAL'); return padrao(t); });
  const s = await r.abrirSessaoLeitura(ctxDe(Client), 'ESTADO 130', async x => { await x.instrucao('POSTCHECK', 'PC'); });
  assert.deepEqual(s.falha, {rotulo: 'POSTCHECK', codigo: '25P03'});
  assert.equal(rollbacks(clientes[0]), 0);
  assert.equal(r.fatal(erroPg('25P03', 'PANIC')), true);
  assert.equal(r.fatal(Object.assign(new Error('x'), {code: 'EPIPE'})), true, 'erro de socket não é SQLSTATE');
  assert.equal(r.fatal(erroPg('57014')), false);
});

test('ROLLBACK passa do prazo: FIM local=rollback_timeout, socket destruído, nada reenviado (ponto 5)', async () => {
  const {Client, clientes} = fabrica(t => (t === 'ROLLBACK' ? new Promise(() => {}) : padrao(t)));
  const s = await r.abrirSessaoLeitura(ctxDe(Client), 'ESTADO 131', async x => { await x.instrucao('POSTCHECK', 'PC'); });
  assert.deepEqual(s.falha, {rotulo: 'FIM', codigo: 'local=rollback_timeout'});
  assert.equal(clientes[0].destruido, true);
  assert.equal(rollbacks(clientes[0]), 1);
  assert.ok(!clientes[0].log.includes('END'), 'sem end depois de destruir');
});

test('ROLLBACK rejeitado com código comum: FIM <código>, sem segundo ROLLBACK', async () => {
  const {Client, clientes} = fabrica(t => { if (t === 'ROLLBACK') throw erroPg('XX000'); return padrao(t); });
  const s = await r.abrirSessaoLeitura(ctxDe(Client), 'ESTADO 131', async x => { await x.instrucao('POSTCHECK', 'PC'); });
  assert.deepEqual(s.falha, {rotulo: 'FIM', codigo: 'XX000'});
  assert.equal(rollbacks(clientes[0]), 1);
});

test('fechamento normal não é perda; descarte rejeitado ou fora do prazo vira FIM', async () => {
  const ok = fabrica(padrao);
  const s0 = await r.abrirSessaoLeitura(ctxDe(ok.Client), 'ESTADO 131', async x => { await x.instrucao('POSTCHECK', 'PC'); });
  assert.equal(s0.falha, null); assert.equal(s0.conexao, 'ENCERRANDO');
  const rej = fabrica(padrao, {end: () => Promise.reject(new Error('end falhou'))});
  const s1 = await r.abrirSessaoLeitura(ctxDe(rej.Client), 'ESTADO 130', async x => { await x.instrucao('POSTCHECK', 'PC'); });
  assert.deepEqual(s1.falha, {rotulo: 'FIM', codigo: null}); assert.equal(rollbacks(rej.clientes[0]), 1);
  const lento = fabrica(padrao, {end: () => new Promise(() => {})});
  const s2 = await r.abrirSessaoLeitura(ctxDe(lento.Client), 'ESTADO 130', async x => { await x.instrucao('POSTCHECK', 'PC'); });
  assert.deepEqual(s2.falha, {rotulo: 'FIM', codigo: 'local=descarte_timeout'}); assert.equal(lento.clientes[0].destruido, true);
});

test('erro do descarte nunca preenche o código de uma falha anterior (Astra r1 código, P2)', async () => {
  // Perda sem liquidação (código vazio) e depois o end rejeita com 08006: a falha continua POSTCHECK sem código.
  const a = fabrica((t, c) => { if (t === 'PC') { c.emit('end'); return new Promise(() => {}); } return padrao(t); }, {end: () => Promise.reject(erroPg('08006', 'FATAL'))});
  const s1 = await r.abrirSessaoLeitura(ctxDe(a.Client), 'ESTADO 130', async x => { await x.instrucao('POSTCHECK', 'PC'); });
  assert.deepEqual(s1.falha, {rotulo: 'POSTCHECK', codigo: null});
  // Mesmo com o evento error emitido durante o fechamento.
  const b = fabrica((t, c) => { if (t === 'PC') { c.emit('end'); return new Promise(() => {}); } return padrao(t); },
    {end: c => { c.emit('error', erroPg('57P01', 'FATAL')); return Promise.resolve(); }});
  const s2 = await r.abrirSessaoLeitura(ctxDe(b.Client), 'ESTADO 130', async x => { await x.instrucao('POSTCHECK', 'PC'); });
  assert.deepEqual(s2.falha, {rotulo: 'POSTCHECK', codigo: null});
  // ROLLBACK rejeitado depois de uma falha comum também não sobrescreve nem preenche.
  const d = fabrica(t => { if (t === 'AUX') throw erroPg('42P01'); if (t === 'ROLLBACK') throw erroPg('XX000'); return padrao(t); });
  const s3 = await r.abrirSessaoLeitura(ctxDe(d.Client), 'ESTADO 130', async x => { await x.instrucao('AUXILIAR', 'AUX'); });
  assert.deepEqual(s3.falha, {rotulo: 'AUXILIAR', codigo: '42P01'});
});

test('rótulo fixado antes da pausa e FIM depois do último resultado (P2-1 da r14)', async () => {
  const vistos = [];
  const {Client} = fabrica(padrao);
  await r.abrirSessaoLeitura(ctxDe(Client, {ganchos: {antesDe: i => vistos.push(i.rotulo)}}), 'ESTADO 130', async x => {
    await x.instrucao('SENTINELAS', 'S'); await x.instrucao('POSTCHECK', 'PC');
  });
  assert.deepEqual(vistos, ['CONEXAO', 'IDENTIDADE', 'BEGIN', 'SHOW', 'SHOW', 'SET', 'SET', 'SET', 'SENTINELAS', 'POSTCHECK', 'FIM']);
});

test('erro no BEGIN: sem ROLLBACK, cliente fechado', async () => {
  const {Client, clientes} = fabrica(t => { if (t.startsWith('BEGIN')) throw erroPg('42601'); return padrao(t); });
  const s = await r.abrirSessaoLeitura(ctxDe(Client), 'ESTADO 130', async () => {});
  assert.deepEqual(s.falha, {rotulo: 'BEGIN', codigo: '42601'});
  assert.equal(rollbacks(clientes[0]), 0); assert.ok(clientes[0].log.includes('END'));
});

test('READ ONLY e isolamento conferidos antes de qualquer leitura', async () => {
  const rw = fabrica(t => (t === 'SHOW transaction_read_only' ? {rows: [{transaction_read_only: 'off'}]} : padrao(t)));
  const s1 = await r.abrirSessaoLeitura(ctxDe(rw.Client), 'REGISTRO', async x => { await x.instrucao('SONDAGEM', 'X'); });
  assert.equal(s1.recusa, 'LEITURA_NAO_READ_ONLY'); assert.ok(!rw.clientes[0].log.includes('X'));
  const rr = fabrica(t => (t === 'SHOW transaction_isolation' ? {rows: [{transaction_isolation: 'repeatable read'}]} : padrao(t)));
  const s2 = await r.abrirSessaoLeitura(ctxDe(rr.Client), 'REGISTRO', async x => { await x.instrucao('SONDAGEM', 'X'); });
  assert.equal(s2.recusa, 'LEITURA_ISOLAMENTO_INVALIDO'); assert.ok(!rr.clientes[0].log.includes('X'));
});

test('diagnóstico publica cada sessão só depois do descarte dela', async () => {
  const eventos = [];
  const {Client} = fabrica((t, c) => {
    if (/pg_try_advisory_xact_lock/.test(t)) return {rows: [{ok: true}]};
    if (/to_regclass\('public.operacao_migration_tentativas'\)::text/.test(t)) return {rows: [{tabela: null}]};
    if (/estado-13[01]/.test(t)) return {rows: [{c0: false, c1: false, c2: false, c3: false, c4: false, c5: false, c6: false, c7: false}]};
    void c; return padrao(t);
  }, {end: async c => { eventos.push('END ' + c.processID); }});
  const res = await r.conferirRegistro(ctxDe(Client, {out: t => eventos.push('OUT ' + t)}), {tentativas: ['00000000-0000-4000-8000-000000000001'], ids: ['130', '131']});
  assert.equal(res.codigo, 3);
  const iEnd0 = eventos.indexOf('END 1000'), iOut0 = eventos.findIndex(e => e.startsWith('OUT REGISTRO_AUSENTE'));
  assert.ok(iEnd0 >= 0 && iEnd0 < iOut0, eventos.join('\n'));
  const iEnd1 = eventos.indexOf('END 1001'), iOut1 = eventos.findIndex(e => e.startsWith('OUT ESTADO 130'));
  assert.ok(iEnd1 < iOut1);
  assert.ok(res.linhas.includes('REGISTRO_AUSENTE tentativa=00000000-0000-4000-8000-000000000001'));
});

test('argumentos: escopo de ids, 129 só nos três modos, --aplicar-129 recusado', () => {
  const u = '00000000-0000-4000-8000-000000000000';
  const recusa = a => { try { r.modo(a); return null; } catch (e) { return e.saida ?? e.message; } };
  assert.equal(recusa(['--ambiente', 'staging', '--aplicar-129']), 'ID_FORA_DO_REGISTRO 129');
  assert.equal(recusa(['--ambiente', 'staging', '--aplicar-129-autorizado', '--backup', 'abcdef']), 'ID_FORA_DO_REGISTRO 129');
  for (const id of ['060', '124', '128', '199']) {
    assert.equal(recusa(['--ambiente', 'staging', `--conferir-${id}`]), 'ID_FORA_DO_REGISTRO ' + id);
    assert.equal(recusa(['--ambiente', 'staging', '--conferir-tentativa', id, '--tentativa', u]), 'ID_FORA_DO_REGISTRO ' + id);
  }
  assert.equal(recusa(['--ambiente', 'staging', '--conferir-129']), 'ID_FORA_DO_REGISTRO 129');
  assert.equal(r.modo(['--ambiente', 'staging', '--conferir-tentativa', '129', '--tentativa', u]).id, '129');
  assert.equal(r.modo(['--ambiente', 'staging', '--concluir-verificacao', '129', '--tentativa', u]).id, '129');
  assert.equal(r.modo(['--ambiente', 'production', '--aplicar-129-bootstrap-autorizado', '--backup', 'snapshot 21/11']).modo, 'bootstrap');
  assert.match(recusa(['--ambiente', 'staging', '--aplicar-130-autorizado']), /BACKUP_OBRIGATORIO/);
  assert.match(recusa(['--ambiente', 'staging', '--aplicar-130-autorizado', '--backup', 'x']), /BACKUP_INVALIDO/);
  assert.match(recusa(['--conferir-130']), /AMBIENTE_OBRIGATORIO/);
  assert.match(recusa(['--ambiente', 'staging', '--arquivar-tentativa', '130', '--tentativa', u, '--motivo', 'curto']), /MOTIVO_INVALIDO/);
  assert.match(recusa(['--ambiente', 'staging', '--conferir-tentativa', '130', '--tentativa', 'nao-uuid']), /TENTATIVA_INVALIDA/);
});

test('códigos: precedência 1 > 2 > 3 > 0', async () => {
  const out = [];
  const res = await r.principal(['--ambiente', 'staging', '--conferir-129'], {}, {out: t => out.push(t)});
  assert.equal(res.codigo, 1);
});

test('estáticos do módulo (§4 n e estáticos gerais)', () => {
  assert.ok(!/SAVEPOINT/i.test(fonte), 'sem SAVEPOINT');
  assert.ok(!/exigirDisco/.test(fonte), 'sem exigirDisco');
  assert.ok(!/somenteLeitura\(/.test(fonte), 'diagnóstico não usa somenteLeitura');
  assert.equal((fonte.match(/new ctx\.Client\(/g) ?? []).length, 2, 'só abrirSessaoLeitura e a conexão C criam cliente');
  assert.ok(!/pool\.connect|new Pool/.test(fonte));
  const sessao = r.abrirSessaoLeitura.toString();
  assert.equal((sessao.match(/'ROLLBACK'/g) ?? []).length, 1, 'um único ponto que envia ROLLBACK na sessão de leitura');
  assert.ok(sessao.indexOf("s.rotulo = rotulo") < sessao.indexOf('await g.antesDe?.(info(), s);\n    if (s.conexao'), 'rótulo antes da pausa');
  assert.ok(sessao.indexOf("s.rotulo = 'FIM'") < sessao.indexOf('} finally {'), 'FIM antes do finally');
  assert.ok(sessao.indexOf("s.conexao = 'ENCERRANDO'") < sessao.indexOf('db.end()'), 'ENCERRANDO antes do descarte');
  assert.equal((sessao.match(/ehPostcheck && codigo === 'P0001'/g) ?? []).length, 1, 'só a instrução marcada dá FALHOU por P0001');
  assert.equal((sessao.match(/if \(!s\.falha\) s\.falha = /g) ?? []).length, 1, 'registro único de falha');
  for (const f of [r.abrirSessaoLeitura, r.conferirRegistro, r.conferirTentativa, r.conferirId]) assert.ok(!/exigirAprovado/.test(f.toString()), 'leitura sem exigirAprovado');
  for (const [nome, sql] of Object.entries(r.SQL)) {
    if (/^\s*UPDATE/i.test(sql)) for (const col of ['ambiente', 'migration', 'tentativa', 'versao', 'situacao']) assert.match(sql.split(/WHERE/i)[1], new RegExp(`\\b${col} = \\$`), `${nome}: ${col} no WHERE`);
    if (/^\s*INSERT/i.test(sql)) assert.match(sql, /\(ambiente, migration, tentativa,/, nome + ': colunas fixas');
  }
  for (const [, arquivo, hash] of r.ARQUIVOS_129) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  assert.equal(r.SQL.beginLeitura, 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
});

test('inventário: 129 aprovada com checks e autorização explícita', async () => {
  const inv = await import(require('node:url').pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href);
  const i = inv.approvedFiles.indexOf('20261121_129_registro_migrations.sql');
  assert.ok(i > inv.approvedFiles.indexOf('20261120_128_dados_fora_do_disco.sql') && i < inv.approvedFiles.indexOf('20261120_130_pre_reserva_manual.sql'));
  assert.deepEqual(inv.requiredChecks('20261121_129_registro_migrations.sql'), ['20261121_129_precheck.sql', '20261121_129_postcheck.sql']);
});

test('lerEmC: postcheck com P0001 e ROLLBACK sem resposta = estouro propagado (C destruída, P0001 como causa), nunca reprovação normal', async () => {
  const enviados = [];
  let destruida = 0;
  const db = {
    prazoRollbackC: 50,
    destruir: () => { destruida++; },
    query: texto => {
      enviados.push(texto);
      if (texto === 'POSTCHECK_FALSO') return Promise.reject(erroPg('P0001', 'ERROR', 'postcheck reprovado'));
      if (texto === 'ROLLBACK') return new Promise(() => {});
      return Promise.resolve({rows: []});
    },
  };
  await assert.rejects(r._teste.postcheckEmC(db, {postcheck: 'POSTCHECK_FALSO'}), e => {
    assert.equal(e.prazo, true);
    assert.equal(e.local, 'rollback_timeout');
    assert.equal(r.sqlstateDe(e), null, 'sem SQLSTATE: o chamador trata como conexão perdida');
    assert.equal(r.sqlstateDe(e.cause), 'P0001', 'a falha da leitura vai como causa');
    return true;
  });
  assert.equal(db.destruido, true);
  assert.equal(destruida, 1);
  assert.equal(enviados.filter(t => t === 'ROLLBACK').length, 1, 'um ROLLBACK só, nada depois do estouro');
  assert.equal(enviados.at(-1), 'ROLLBACK');
});

test('lerEmC: postcheck com P0001 e ROLLBACK respondido = reprovação normal (aprovado false)', async () => {
  const db = {query: texto => (texto === 'POSTCHECK_FALSO' ? Promise.reject(erroPg('P0001', 'ERROR', 'postcheck reprovado')) : Promise.resolve({rows: []}))};
  const res = await r._teste.postcheckEmC(db, {postcheck: 'POSTCHECK_FALSO'});
  assert.equal(res.aprovado, false);
  assert.match(res.motivo, /postcheck reprovado/);
  assert.notEqual(db.destruido, true);
});
