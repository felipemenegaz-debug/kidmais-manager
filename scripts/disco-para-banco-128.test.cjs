/* eslint-disable @typescript-eslint/no-require-imports */
// Cópia do disco para o banco depois da 128 (scripts/disco-para-banco-128.cjs), sem banco real: alvo só pelo ambiente
// declarado (staging ou production, com a validação rígida de cada um), argumentos fechados, plano sem conexão, leitura do
// disco sem exceção (AUSENTE/ILEGIVEL/DIVERGENTE), disco exigido antes de copiar, identidade recusada sem gravar e
// conferência só em READ ONLY. O caminho com PostgreSQL de verdade está em lib/disponibilidade/migration-128.postgres.test.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('./disco-para-banco-128.cjs');

const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'});
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'disco128-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };

test('ambiente: staging e production com a validação de cada um; outro ambiente, serviço trocado e URL de outro banco recusados', () => {
  const a = s.ambiente(ENV_STG);
  assert.equal(a.nome, 'staging');
  assert.equal(a.cfg.application_name, 'kidmais-disco-para-banco-128-staging');
  assert.ok(!JSON.stringify(a.cfg).includes('SENHA_FALSA'), 'senha fora da enumeração');
  const p = s.ambiente(ENV_PROD);
  assert.equal(p.nome, 'production');
  assert.equal(p.cfg.database, 'kidmais_production');
  assert.throws(() => s.ambiente({...ENV_STG, KIDMAIS_DEPLOY_ENV: 'local'}), /AMBIENTE_RECUSADO/);
  assert.throws(() => s.ambiente({...ENV_STG, RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}), /SERVICO_RECUSADO/);
  assert.throws(() => s.ambiente({...ENV_PROD, RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}), /SERVICO_RECUSADO/);
  assert.throws(() => s.ambiente({...ENV_STG, DATABASE_URL: ENV_PROD.DATABASE_URL}), /HOST_RECUSADO/);
  assert.throws(() => s.ambiente({...ENV_PROD, DATABASE_SSL: 'false'}), /TLS_OBRIGATORIO/);
  assert.throws(() => s.ambiente({...ENV_STG, PGOPTIONS: '-c x=1'}), /AMBIENTE_PG_RECUSADO/);
});

test('argumentos fechados com alvo igual ao ambiente; plano sem conexão e sem nunca apagar do disco', async () => {
  assert.deepEqual(s.modo([]), {modo: 'plano'});
  assert.deepEqual(s.modo(['--conferir-128', 'staging'], ENV_STG), {modo: 'conferir', alvo: 'staging'});
  assert.deepEqual(s.modo(['--copiar-128-autorizado', 'production'], ENV_PROD), {modo: 'copiar', alvo: 'production'});
  for (const a of [['--copiar'], ['--conferir-128'], ['--copiar-128-autorizado'], ['--conferir-128', '--copiar-128-autorizado'],
    ['--copiar-128-autorizado', 'x'], ['--conferir-128', 'staging', 'staging']]) assert.throws(() => s.modo(a, ENV_STG), /ARGUMENTOS_RECUSADOS/);
  assert.throws(() => s.modo(['--copiar-128-autorizado', 'production'], ENV_STG), /ALVO_DIFERENTE_DO_AMBIENTE/);
  assert.throws(() => s.modo(['--conferir-128', 'staging'], ENV_PROD), /ALVO_DIFERENTE_DO_AMBIENTE/);
  const r = await s.principal([], {}, {});
  assert.equal(r.codigo, 0);
  assert.equal(r.saida.conecta, false);
  assert.ok(r.saida.nuncaExecuta.includes('apagar arquivo do disco'));
});

test('leitura do disco: ausente, ilegível, forma normalizada como o web lê; PDF ausente, divergente, chave fora do padrão', t => {
  const d = tmp(t);
  assert.deepEqual(s.lerConfigDoDisco(d), {estado: 'AUSENTE'});
  fs.writeFileSync(path.join(d, 'disponibilidade.json'), '{quebrado');
  assert.equal(s.lerConfigDoDisco(d).estado, 'ILEGIVEL');
  fs.writeFileSync(path.join(d, 'disponibilidade.json'), '[1]');
  assert.equal(s.lerConfigDoDisco(d).estado, 'ILEGIVEL');
  const texto = JSON.stringify({pacoteOverrides: [{id: 'P'}], extra: true});
  fs.writeFileSync(path.join(d, 'disponibilidade.json'), texto);
  const c = s.lerConfigDoDisco(d);
  assert.deepEqual([c.estado, c.conteudo, c.sha256, c.pacoteOverrides, c.descontos], ['PRESENTE', {pacoteOverrides: [{id: 'P'}], descontos: []}, sha(texto), 1, 0]);

  const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
  const chave = '22222222-2222-4222-8222-222222222128.pdf';
  const doc = {chave_armazenamento: chave, tamanho_bytes: String(bytes.length), sha256: sha(bytes)};
  assert.equal(s.lerPdfDoDisco(d, doc).estado, 'AUSENTE');
  fs.mkdirSync(path.join(d, 'documentos-publicos'));
  fs.writeFileSync(path.join(d, 'documentos-publicos', chave), bytes);
  assert.ok(s.lerPdfDoDisco(d, doc).bytes.equals(bytes));
  fs.writeFileSync(path.join(d, 'documentos-publicos', chave), Buffer.concat([bytes, Buffer.from('x')]));
  assert.equal(s.lerPdfDoDisco(d, doc).estado, 'DIVERGENTE');
  assert.equal(s.lerPdfDoDisco(d, {...doc, chave_armazenamento: '../disponibilidade.json'}).estado, 'CHAVE_INVALIDA');
});

function clienteFalso({identidade, instalada = true, docs = [], linha = null, escrita = null, commit = null, releitura = null, semA128DepoisDoCommit = false} = {}) {
  const log = [];
  let commitou = false;
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      log.push(sql);
      if (sql === 'SQL_ID') return {rows: [identidade]};
      if (sql === 'COMMIT') { if (commit) throw commit; commitou = true; return {rows: []}; }
      if (commitou && releitura) throw releitura;
      if (sql.includes('to_regclass')) { const ok = instalada && !(commitou && semA128DepoisDoCommit); return {rows: [{tabela: ok, coluna: ok}]}; }
      if (sql.includes('FROM disponibilidade_config_legada')) return {rows: linha ? [linha] : []};
      if (sql.includes('FROM documentos_publicos')) return {rows: docs};
      if (/^(INSERT|UPDATE)/.test(sql)) { if (!escrita) throw new Error('escrita inesperada'); return escrita(sql); }
      return {rows: [], rowCount: 0};
    }
  };
  C.log = log;
  return C;
}
const amb = {nome: 'staging', cfg: {}, sqlIdentidade: 'SQL_ID', identidade: id => { assert.equal(id?.db, 'certo', 'IDENTIDADE_RECUSADA'); return {banco: id.db}; }};
const semDisco = () => undefined;
const CONFERIR = ['--conferir-128', 'staging'];
const COPIAR = ['--copiar-128-autorizado', 'staging'];

test('as duas operações exigem o disco antes de conectar; identidade errada falha sem gravar; conferir só em READ ONLY', async t => {
  for (const argv of [CONFERIR, COPIAR]) {
    const C = clienteFalso({identidade: {db: 'certo'}});
    await assert.rejects(s.principal(argv, ENV_STG, {Client: C, amb, exigirDisco: () => { throw new Error('DISCO_PERSISTENTE_AUSENTE'); }}), /DISCO_PERSISTENTE_AUSENTE/);
    assert.equal(C.log.length, 0, 'nada conectou');
  }
  const outroAlvo = clienteFalso({identidade: {db: 'certo'}});
  await assert.rejects(s.principal(['--copiar-128-autorizado', 'production'], ENV_STG, {Client: outroAlvo, amb, exigirDisco: semDisco}), /ALVO_DIFERENTE_DO_AMBIENTE/);
  assert.equal(outroAlvo.log.length, 0);

  const errado = clienteFalso({identidade: {db: 'outro'}});
  const r = await s.principal(COPIAR, ENV_STG, {Client: errado, amb, disco: tmp(t), exigirDisco: semDisco});
  assert.equal(r.codigo, 2);
  assert.equal(r.saida.nadaGravado, true);
  assert.ok(!errado.log.some(q => /^(INSERT|UPDATE)/.test(q)) && errado.log.at(-1) === 'ROLLBACK');

  const semA128 = await s.principal(CONFERIR, ENV_STG, {Client: clienteFalso({identidade: {db: 'certo'}, instalada: false}), amb, disco: tmp(t), exigirDisco: semDisco});
  assert.deepEqual([semA128.codigo, semA128.saida.motivo], [3, '128_AUSENTE']);

  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'disponibilidade.json'), '{"pacoteOverrides":[],"descontos":[]}');
  const leitura = clienteFalso({identidade: {db: 'certo'}, docs: [{id: 'x', chave_armazenamento: '33333333-3333-4333-8333-333333333128.pdf', tamanho_bytes: '9', sha256: 'a'.repeat(64), no_banco: false}]});
  const c = await s.principal(CONFERIR, ENV_STG, {Client: leitura, amb, disco: d, exigirDisco: semDisco});
  assert.equal(c.codigo, 3, 'PDF ativo ausente no disco é problema');
  assert.deepEqual(c.saida.problemas, ['PDF_AUSENTE x']);
  assert.equal(leitura.log[0], 'BEGIN READ ONLY');
  assert.equal(leitura.log.at(-1), 'ROLLBACK');
});

test('resumo: sem arquivo e sem linha é PROBLEMA; linha DISCO diferente é pendente; PAINEL vence sempre', () => {
  const presente = {estado: 'PRESENTE', conteudo: {pacoteOverrides: [], descontos: []}};
  const r = (linha, config) => s.resumir({linha, docs: []}, config, []);
  assert.deepEqual(r(null, {estado: 'AUSENTE'}).problemas, ['CONFIG_AUSENTE_SEM_LINHA']);
  assert.deepEqual(r(null, {estado: 'ILEGIVEL'}).problemas, ['CONFIG_ILEGIVEL']);
  assert.deepEqual(r({origem: 'DISCO', igual_ao_disco: true}, {estado: 'ILEGIVEL'}).problemas, ['CONFIG_ILEGIVEL']);
  assert.deepEqual(r({origem: 'PAINEL', igual_ao_disco: false}, {estado: 'ILEGIVEL'}).problemas, []);
  assert.deepEqual(r({origem: 'PAINEL', igual_ao_disco: false}, {estado: 'AUSENTE'}).problemas, []);
  assert.equal(r(null, presente).pendentes.config, true);
  assert.equal(r({origem: 'DISCO', igual_ao_disco: false}, presente).pendentes.config, true, 'arquivo mudou depois da cópia');
  assert.equal(r({origem: 'DISCO', igual_ao_disco: true}, presente).pendentes.config, false);
  assert.equal(r({origem: 'PAINEL', igual_ao_disco: false}, presente).pendentes.config, false, 'painel nunca é sobrescrito');
});

test('copiar: trava da publicação, upsert que só toca linha DISCO, PDF exige 1 linha; COMMIT incerto é INDETERMINADO', async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'disponibilidade.json'), '{"pacoteOverrides":[{"id":"P"}],"descontos":[]}');
  const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
  const chave = '44444444-4444-4444-8444-444444444128.pdf';
  fs.mkdirSync(path.join(d, 'documentos-publicos'));
  fs.writeFileSync(path.join(d, 'documentos-publicos', chave), bytes);
  const doc = {id: 'y', chave_armazenamento: chave, tamanho_bytes: String(bytes.length), sha256: sha(bytes), no_banco: false};
  const deps = C => ({Client: C, amb, disco: d, exigirDisco: semDisco});

  const ok = clienteFalso({identidade: {db: 'certo'}, docs: [doc], linha: {origem: 'DISCO', igual_ao_disco: false}, escrita: () => ({rowCount: 1})});
  const r = await s.principal(COPIAR, ENV_STG, deps(ok));
  assert.equal(r.codigo, 0);
  assert.deepEqual([r.saida.configCopiada, r.saida.pdfsCopiados, r.saida.releitura], [true, 1, 'APOS_COMMIT']);
  const trava = ok.log.findIndex(q => q.includes('pg_advisory_xact_lock(hashtext($1))'));
  assert.ok(trava > 0 && trava < ok.log.findIndex(q => q.includes('FROM documentos_publicos')), 'trava antes de ler os documentos');
  assert.ok(ok.log.some(q => q.includes('FROM documentos_publicos') && q.includes('FOR UPDATE')));
  const upsert = ok.log.find(q => q.startsWith('INSERT'));
  assert.match(upsert, /DO UPDATE SET conteudo = EXCLUDED\.conteudo/);
  assert.match(upsert, /WHERE disponibilidade_config_legada\.origem = 'DISCO'/);

  const corrida = clienteFalso({identidade: {db: 'certo'}, docs: [doc], linha: {origem: 'PAINEL', igual_ao_disco: false}, escrita: () => ({rowCount: 0})});
  const rc = await s.principal(COPIAR, ENV_STG, deps(corrida));
  assert.deepEqual([rc.codigo, rc.saida.nadaGravado], [2, true]);
  assert.match(rc.saida.mensagem, /PDF_NAO_ATUALIZADO y/);
  assert.ok(!corrida.log.some(q => q.startsWith('INSERT')), 'linha PAINEL: nenhum upsert');
  assert.ok(!corrida.log.includes('COMMIT') && corrida.log.at(-1) === 'ROLLBACK');

  const incerto = clienteFalso({identidade: {db: 'certo'}, docs: [doc], escrita: () => ({rowCount: 1}), commit: new Error('conexão caiu')});
  const ri = await s.principal(COPIAR, ENV_STG, deps(incerto));
  assert.deepEqual([ri.codigo, ri.saida.resultado, ri.saida.nadaGravado], [4, 'INDETERMINADO', null]);
  assert.match(ri.saida.orientacao, /--conferir-128 staging/);

  const semA128Depois = clienteFalso({identidade: {db: 'certo'}, docs: [doc], escrita: () => ({rowCount: 1}), semA128DepoisDoCommit: true});
  const rs = await s.principal(COPIAR, ENV_STG, deps(semA128Depois));
  assert.deepEqual([rs.codigo, rs.saida.resultado, rs.saida.releitura], [0, 'COPIADO', 'INDISPONIVEL'], 'COMMIT confirmado nunca vira código 4');
  assert.match(rs.saida.mensagem, /128_AUSENTE_NA_RELEITURA/);

  const semReleitura = clienteFalso({identidade: {db: 'certo'}, docs: [doc], escrita: () => ({rowCount: 1}), releitura: new Error('caiu depois')});
  const rr = await s.principal(COPIAR, ENV_STG, deps(semReleitura));
  assert.deepEqual([rr.codigo, rr.saida.resultado, rr.saida.releitura], [0, 'COPIADO', 'INDISPONIVEL']);

  fs.rmSync(path.join(d, 'disponibilidade.json'));
  const semArquivo = clienteFalso({identidade: {db: 'certo'}, docs: [], escrita: () => ({rowCount: 1})});
  const ra = await s.principal(COPIAR, ENV_STG, deps(semArquivo));
  assert.equal(ra.codigo, 2);
  assert.match(ra.saida.mensagem, /CONFIG_AUSENTE_SEM_LINHA/);
});

test('disco: campo presente que não é lista ou item que não é objeto é ILEGIVEL (a cópia não descarta conteúdo)', t => {
  const d = tmp(t);
  const arq = path.join(d, 'disponibilidade.json');
  for (const ruim of [{descontos: {a: 1}}, {pacoteOverrides: [null]}, {pacoteOverrides: [{id: 'P'}, 'x']}, {descontos: [[1]]}]) {
    fs.writeFileSync(arq, JSON.stringify(ruim));
    assert.equal(s.lerConfigDoDisco(d).estado, 'ILEGIVEL', JSON.stringify(ruim));
  }
  fs.writeFileSync(arq, JSON.stringify({pacoteOverrides: [{id: 'P'}]}));
  const ok = s.lerConfigDoDisco(d);
  assert.deepEqual([ok.estado, ok.conteudo], ['PRESENTE', {pacoteOverrides: [{id: 'P'}], descontos: []}], 'campo ausente = []');
});

test('copiar: o resumo pós-COMMIT relê o arquivo (mudou durante a cópia = PRONTO_PARA_COPIAR, não NADA_A_COPIAR)', async t => {
  const d = tmp(t);
  const arq = path.join(d, 'disponibilidade.json');
  fs.writeFileSync(arq, '{"pacoteOverrides":[{"id":"A"}],"descontos":[]}');
  const comparados = [];
  const C = clienteFalso({identidade: {db: 'certo'}, escrita: () => {
    fs.writeFileSync(arq, '{"pacoteOverrides":[{"id":"B"}],"descontos":[]}');
    return {rowCount: 1};
  }});
  const query = C.prototype.query;
  C.prototype.query = async function (sql, params) {
    if (sql.includes('FROM disponibilidade_config_legada')) { comparados.push(params?.[0]); return {rows: [{origem: 'DISCO', igual_ao_disco: comparados.length === 1 ? false : params[0].includes('"A"')}]}; }
    return query.call(this, sql, params);
  };
  const r = await s.principal(COPIAR, ENV_STG, {Client: C, amb, disco: d, exigirDisco: semDisco});
  assert.equal(r.codigo, 0);
  assert.match(comparados.at(-1), /"B"/, 'releitura compara com o arquivo atual');
  assert.equal(r.saida.situacao, 'PRONTO_PARA_COPIAR');
});

test('copiar: falha de leitura do arquivo depois do COMMIT é releitura INDISPONIVEL (código 0), não arquivo ilegível', async t => {
  const d = tmp(t);
  const arq = path.join(d, 'disponibilidade.json');
  fs.writeFileSync(arq, '{"pacoteOverrides":[{"id":"A"}],"descontos":[]}');
  const C = clienteFalso({identidade: {db: 'certo'}, escrita: () => {
    // O arquivo vira pasta: a leitura falha por I/O (EISDIR), não por conteúdo.
    fs.rmSync(arq); fs.mkdirSync(arq);
    return {rowCount: 1};
  }});
  const r = await s.principal(COPIAR, ENV_STG, {Client: C, amb, disco: d, exigirDisco: semDisco});
  assert.deepEqual([r.codigo, r.saida.resultado, r.saida.releitura], [0, 'COPIADO', 'INDISPONIVEL']);
  assert.match(r.saida.mensagem, /RELEITURA_DO_ARQUIVO_FALHOU/);
  assert.equal(r.saida.situacao, undefined, 'sem resumo (nem NADA_A_COPIAR) quando o arquivo não pôde ser relido');
  const lido = s.lerConfigDoDisco(d);
  assert.deepEqual([lido.estado, typeof lido.falhaLeitura], ['ILEGIVEL', 'string'], 'antes do COMMIT continua problema');
});
