/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
// Testes PG da rodada 2 do registro de migrations (parecer Astra r1 do código): prazo no COMMIT (proxy 'reter'), exceção
// depois do COMMIT, evidência estruturada ({"corpo":null}), postcheck da 129 com coluna gerada, trava em outro banco e §4.1
// com os ADAPTADORES REAIS (alvo, SQL e regra de identidade de production e de staging) contra o cluster descartável.
// Mesmas travas de scripts/registro-migrations-banco.postgres.test.cjs: só KIDMAIS_REGISTRO_PG_PORTA (5432/5433 recusadas),
// sem DATABASE_URL/KIDMAIS_HOMOLOGACAO_DATABASE_URL/PG* no ambiente do processo.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const apoio = require('./registro-migrations-banco.pg-apoio.cjs');
const reg = require('./registro-migrations-banco.cjs');

const P = apoio.porta();
const pular = P ? false : 'KIDMAIS_REGISTRO_PG_PORTA ausente: testes de PG não rodaram';
const raiz = path.resolve(__dirname, '..');
const BACKUP = 'backup-teste-local:2026-11-21';
const ANT_OK = async () => ({codigo: 0, linhas: ['117 PASS (injetada no teste)'], pendentes: []});
let admin, seq = 0;
const bancos = [];

test.before(async () => {
  if (pular) return;
  admin = await apoio.conectar(P, 'postgres');
  await apoio.garantirBase(admin, P);
});
test.after(async () => {
  if (!admin) return;
  for (const b of bancos) await apoio.removerBanco(admin, b).catch(() => {});
  await admin.end();
});

async function banco() {
  const nome = `registro_r2_${process.pid}_${++seq}`;
  bancos.push(nome);
  return apoio.novoBanco(admin, nome);
}
async function rodar(nome, args, deps = {}) {
  const r = await reg.principal(['--ambiente', 'staging', ...args], {}, {
    ...apoio.ambienteLocal(P, nome, deps.portaAlvo), antecessoras: ANT_OK, prazoLiquidacao: 5000, ...deps, out: () => {},
  });
  return {...r, texto: r.linhas.join('\n')};
}
async function sql(nome, texto, params) {
  const c = await apoio.conectar(P, nome);
  try { return await c.query(texto, params); } finally { await c.end(); }
}
const uuidDe = (r, situacao) => (new RegExp(`tentativa=([0-9a-f-]{36}) situacao=${situacao}`).exec(r.texto) ?? [])[1];
const ok = (r, re, codigo = 0) => { assert.match(r.texto, re); assert.equal(r.codigo, codigo, r.texto); };
async function comRegistro() { const b = await banco(); ok(await rodar(b, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 129/); return b; }
const lerArq = rel => fs.readFileSync(path.join(raiz, rel), 'utf8');
const arqMig = id => 'database/migrations/' + fs.readdirSync(path.join(raiz, 'database/migrations')).find(a => a.split('_')[1] === id);
const linhaDe = async (b, u) => (await sql(b, "SELECT situacao, versao, detalhe FROM operacao_migration_tentativas WHERE tentativa = $1", [u])).rows[0];
const espera = ms => new Promise(s => setTimeout(s, ms));

// ------------------------------------------------------------------ P2: prazo local no COMMIT (resposta retida pelo proxy)

test('COMMIT da reserva segurado: prazo local = RESERVA_INDETERMINADA (2) com uuid; liberado = reserva existe; descartado = nada', {skip: pular}, async () => {
  for (const destino of ['liberar', 'descartar']) {
    const b = await comRegistro();
    const px = await apoio.proxy(P);
    try {
      let armado = false;
      px.regra = (cx, d) => (armado && apoio.ehComando(d, 'COMMIT') ? 'segurar' : 'passar');
      const t0 = Date.now();
      const r = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {portaAlvo: px.porta, prazoCommit: 1500, prazoDescarte: 1500,
        ganchos: {antesDoCommitReserva: () => { armado = true; }}});
      ok(r, /RESERVA_INDETERMINADA tentativa=[0-9a-f-]{36} .*commit_reserva_timeout/, 2);
      assert.ok(Date.now() - t0 < 15000, 'o prazo local tem de soltar o processo');
      const u = uuidDe(r, 'RESERVANDO');
      assert.ok(px.retida, 'o COMMIT ficou segurado no proxy');
      assert.ok(Date.now() - t0 >= 1400, 'saiu pelo prazo local, não por queda');
      // Backend vivo e com a transação aberta: a conferência não conclui pela ausência.
      const t = await rodar(b, ['--conferir-tentativa', '130', '--tentativa', u]);
      ok(t, /AUSENTE_NAO_CONCLUSIVO EXECUTOR_ATIVO/, 2);
      if (destino === 'liberar') {
        await px.liberar(px.retida);
        await espera(300);
        assert.equal((await linhaDe(b, u)).situacao, 'INICIADA');
      } else {
        px.descartar(px.retida);
        await espera(500);
        assert.equal(await linhaDe(b, u), undefined);
      }
    } finally { await px.fechar(); }
  }
});

test('COMMIT do corpo segurado: prazo local = COMMIT_INDETERMINADO (2); liberado, concluir-verificacao fecha', {skip: pular}, async () => {
  const b = await comRegistro();
  const px = await apoio.proxy(P);
  try {
    let armado = false;
    px.regra = (cx, d) => (armado && apoio.ehComando(d, 'COMMIT') ? 'segurar' : 'passar');
    const t0 = Date.now();
    const r = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {portaAlvo: px.porta, prazoCommit: 1500, prazoDescarte: 1500,
      ganchos: {antesDoCommitCorpo: () => { armado = true; }}});
    ok(r, /COMMIT_INDETERMINADO 130 tentativa=[0-9a-f-]{36}/, 2);
    assert.ok(Date.now() - t0 >= 1400 && Date.now() - t0 < 15000, 'o prazo local soltou o processo');
    const u = uuidDe(r, 'INICIADA');
    const enquanto = await rodar(b, ['--conferir-tentativa', '130', '--tentativa', u]);
    ok(enquanto, /TENTATIVA .* INICIADA/, 3); // a reserva já estava COMMITADA; o corpo está pendurado no backend
    await px.liberar(px.retida);
    await espera(300);
    assert.equal((await linhaDe(b, u)).situacao, 'EM_ANDAMENTO');
    ok(await rodar(b, ['--concluir-verificacao', '130', '--tentativa', u]), /CONCLUIDA 130/);
  } finally { await px.fechar(); }
});

test('COMMIT do bootstrap segurado: prazo local = BOOTSTRAP_129 commit=INDETERMINADO (2); liberado, concluir-verificacao 129 fecha', {skip: pular}, async () => {
  const b = await banco();
  const px = await apoio.proxy(P);
  try {
    let armado = false;
    px.regra = (cx, d) => (armado && apoio.ehComando(d, 'COMMIT') ? 'segurar' : 'passar');
    const t0 = Date.now();
    const r = await rodar(b, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP], {portaAlvo: px.porta, prazoCommit: 1500, prazoDescarte: 1500,
      ganchos: {antesDoCommit129: () => { armado = true; }}});
    ok(r, /BOOTSTRAP_129 commit=INDETERMINADO fase=commit tentativa=[0-9a-f-]{36} .*commit_timeout/, 2);
    assert.ok(Date.now() - t0 >= 1400 && Date.now() - t0 < 15000, 'o prazo local soltou o processo');
    const u = uuidDe(r, 'RESERVANDO');
    ok(await rodar(b, ['--conferir-tentativa', '129', '--tentativa', u]), /EXECUTOR_ATIVO/, 2);
    await px.liberar(px.retida);
    await espera(300);
    assert.equal((await linhaDe(b, u)).situacao, 'VERIFICACAO_PENDENTE');
    ok(await rodar(b, ['--concluir-verificacao', '129', '--tentativa', u]), /CONCLUIDA 129/);
  } finally { await px.fechar(); }
});

// ------------------------------------------------------------------ P2: exceção depois do COMMIT = código 2 com o uuid

test('exceção na verificação depois do COMMIT do corpo: código 2, FALHA com o corpo preservado, concluir-verificacao fecha', {skip: pular}, async () => {
  const b = await comRegistro();
  const r = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {ganchos: {naVerificacaoPosCommit: () => { throw new Error('falha simulada'); }}});
  ok(r, /VERIFICACAO_POS_COMMIT_FALHOU 130 tentativa=[0-9a-f-]{36}/, 2);
  assert.match(r.texto, /FALHA 130 tentativa=.*reconciliar com --concluir-verificacao 130/);
  const u = uuidDe(r, 'INICIADA');
  const l = await linhaDe(b, u);
  assert.equal(l.situacao, 'FALHA');
  assert.equal(l.detalhe.falha.fase, 'verificacao_pos_commit');
  assert.equal(l.detalhe.corpo.postcheck, 'PASS');
  ok(await rodar(b, ['--concluir-verificacao', '130', '--tentativa', u]), /CONCLUIDA 130/);
});

test('conexão C terminada depois do COMMIT do corpo: código 2, REGISTRO_NAO_ATUALIZADO, linha EM_ANDAMENTO reconciliável', {skip: pular}, async () => {
  const b = await comRegistro();
  const r = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {ganchos: {naVerificacaoPosCommit: async ({db}) => {
    await admin.query('SELECT pg_terminate_backend($1)', [db.processID]);
    await espera(200);
  }}});
  ok(r, /VERIFICACAO_POS_COMMIT_FALHOU 130/, 2);
  assert.match(r.texto, /REGISTRO_NAO_ATUALIZADO tentativa=[0-9a-f-]{36} .*reconciliar com --concluir-verificacao 130/);
  assert.doesNotMatch(r.texto, /RECUSADO/);
  const u = uuidDe(r, 'INICIADA');
  assert.equal((await linhaDe(b, u)).situacao, 'EM_ANDAMENTO');
  ok(await rodar(b, ['--concluir-verificacao', '130', '--tentativa', u]), /CONCLUIDA 130/);
});

test('exceção na verificação depois do COMMIT da 129: código 2 com o uuid; concluir-verificacao 129 fecha', {skip: pular}, async () => {
  const b = await banco();
  const r = await rodar(b, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP], {ganchos: {naVerificacaoPosCommit: () => { throw new Error('falha simulada'); }}});
  ok(r, /VERIFICACAO_POS_COMMIT_FALHOU 129 tentativa=[0-9a-f-]{36}/, 2);
  const u = uuidDe(r, 'RESERVANDO');
  assert.equal((await linhaDe(b, u)).situacao, 'FALHA');
  ok(await rodar(b, ['--concluir-verificacao', '129', '--tentativa', u]), /CONCLUIDA 129/);
});

// ------------------------------------------------------------------ P2: evidência estruturada

test('{"corpo":null}: 130 EM_ANDAMENTO e 129 VERIFICACAO_PENDENTE recusados no concluir; arquivar também recusa', {skip: pular}, async () => {
  const b = await comRegistro();
  ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 130/);
  await sql(b, lerArq(arqMig('131')));
  const u = crypto.randomUUID();
  await sql(b, "INSERT INTO operacao_migration_tentativas (ambiente, migration, tentativa, backup, situacao, versao, detalhe) VALUES ('staging', '131', $1, 'backup-x', 'EM_ANDAMENTO', 2, '{\"corpo\":null}')", [u]);
  ok(await rodar(b, ['--concluir-verificacao', '131', '--tentativa', u]), /CONCLUSAO_RECUSADA .* EM_ANDAMENTO corpo=nao/, 1);
  const a = await rodar(b, ['--arquivar-tentativa', '131', '--tentativa', u, '--motivo', 'corpo nulo no teste']);
  assert.equal(a.codigo, 1, a.texto);
  assert.doesNotMatch(a.texto, /^ARQUIVADA/m);

  const c = await banco();
  await sql(c, lerArq(arqMig('129')));
  const u2 = crypto.randomUUID();
  await sql(c, "INSERT INTO operacao_migration_tentativas (ambiente, migration, tentativa, backup, situacao, versao, detalhe) VALUES ('staging', '129', $1, 'backup-x', 'VERIFICACAO_PENDENTE', 1, '{\"corpo\":null}')", [u2]);
  ok(await rodar(c, ['--concluir-verificacao', '129', '--tentativa', u2]), /CONCLUSAO_RECUSADA .* VERIFICACAO_PENDENTE corpo=nao/, 1);
});

// ------------------------------------------------------------------ P2: postcheck da 129 com coluna gerada

test('postcheck da 129 reprova versao GENERATED ALWAYS AS (1) STORED (coluna divergente versao)', {skip: pular}, async () => {
  const b = await banco();
  const mig = lerArq(arqMig('129'));
  const trocada = mig.replace('versao integer NOT NULL DEFAULT 1,', 'versao integer NOT NULL GENERATED ALWAYS AS (1) STORED,');
  assert.notEqual(trocada, mig);
  await sql(b, trocada);
  const r = [].concat(await sql(b, lerArq('database/checks/20261121_129_postcheck.sql')));
  const linha = r.flatMap(x => x.rows ?? []).find(x => Object.hasOwn(x, 'aprovado'));
  assert.equal(linha.aprovado, false);
  assert.ok(linha.divergencias.some(d => /coluna divergente versao/.test(d)), linha.divergencias.join('; '));
  // Controle: a 129 original passa no mesmo postcheck.
  const c = await banco();
  await sql(c, mig);
  const r2 = [].concat(await sql(c, lerArq('database/checks/20261121_129_postcheck.sql')));
  assert.equal(r2.flatMap(x => x.rows ?? []).find(x => Object.hasOwn(x, 'aprovado')).aprovado, true);
});

// ------------------------------------------------------------------ P3: trava só conta no banco atual e concedida

test('travaOcupada: a mesma chave segura em OUTRO banco do cluster não ocupa a trava deste', {skip: pular}, async () => {
  const b = await comRegistro();
  const outroBanco = await banco();
  const outro = await apoio.conectar(P, outroBanco);
  try {
    await outro.query("SELECT pg_advisory_lock(hashtext('kidmais-migration'), hashtext('staging:130'))");
    ok(await rodar(b, ['--conferir-130']), /TRAVA staging:130 livre/);
  } finally { await outro.end(); }
  const mesmo = await apoio.conectar(P, b);
  try {
    await mesmo.query("SELECT pg_advisory_lock(hashtext('kidmais-migration'), hashtext('staging:130'))");
    ok(await rodar(b, ['--conferir-130']), /TRAVA staging:130 OCUPADA/);
  } finally { await mesmo.end(); }
});

// ------------------------------------------------------------------ §4.1 com os adaptadores reais

/**
 * Ambiente simulado com os adaptadores REAIS: env falso do serviço (host interno do Render, sem credencial real), alvo e
 * regra de identidade dos módulos de verdade. Só a REDE é trocada: o Client conecta no cluster descartável e, na consulta de
 * identidade, roda a consulta real e troca só o que o cluster local não tem como provar (banco, TLS, rede privada, superusuário,
 * md5 da credencial do env). `vistos` guarda a configuração que cada adaptador entregou ao Client.
 */
const SIMULADO = {
  production: {banco: 'kidmais_production', env: {RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production',
    DATABASE_SSL: 'true', DATABASE_URL: 'postgresql://usuario_teste:senha_teste_local@dpg-dak750gae00c73fudmg0-a/kidmais_production'}},
  staging: {banco: 'kidmais_staging_1z91', env: {RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging',
    DATABASE_SSL: 'true', DATABASE_URL: 'postgresql://usuario_teste:senha_teste_local@dpg-daidko3m8hqs73ce4jt0-a/kidmais_staging_1z91'}},
};
function clienteSimulado(nomeBanco, amb, vistos) {
  const {Client} = require('pg');
  const esperado = SIMULADO[amb];
  return class ClienteSimulado extends Client {
    constructor(cfg) {
      const viaUrl = cfg.connectionString ? new URL(cfg.connectionString) : null;
      vistos.push({host: viaUrl ? viaUrl.hostname : cfg.host, database: viaUrl ? viaUrl.pathname.slice(1) : cfg.database, ssl: Boolean(cfg.ssl), app: cfg.application_name});
      super({host: apoio.HOST, port: P, user: apoio.USUARIO, database: nomeBanco, application_name: cfg.application_name,
        password: () => Promise.reject(new Error('o servidor pediu senha'))});
      this.on('error', () => undefined);
    }
    query(q, ...resto) {
      const texto = typeof q === 'string' ? q : q?.text;
      if (typeof texto !== 'string' || !/pg_stat_ssl/.test(texto) || !/inet_server_addr/.test(texto)) return super.query(q, ...resto);
      return super.query(q, ...resto).then(r => {
        const l = {...r.rows[0], db: esperado.banco, tls: true, servidor_privado: true};
        if ('tls_versao' in l) l.tls_versao = 'TLSv1.3';
        if ('papel_superusuario' in l) { l.papel_superusuario = false; l.sessao_superusuario = false; }
        if ('sessao_md5' in l) l.sessao_md5 = crypto.createHash('md5').update('usuario_teste', 'utf8').digest('hex');
        return {...r, rows: [l]};
      });
    }
  };
}

for (const amb of ['production', 'staging']) {
  test(`§4.1 ${amb}: adaptadores reais, ANTECESSORAS_OK sem disco, bootstrap e 130; C segura a trava e executa DDL e escritas (PID)`, {skip: pular}, async () => {
    const b = await banco();
    const vistos = [];
    const Client = clienteSimulado(b, amb, vistos);
    const env = SIMULADO[amb].env;
    const ant = await require('./conferir-antecessoras.cjs').conferir({ambiente: amb, env, deps: {Client}});
    assert.equal(ant.final, 'ANTECESSORAS_OK', ant.linhas.join('\n'));
    assert.ok(!ant.linhas.some(l => /DISCO/.test(l)), ant.linhas.join('\n'));
    assert.ok(vistos.length >= ant.linhas.length && vistos.every(v => v.host.startsWith('dpg-') && v.database === SIMULADO[amb].banco && v.ssl), JSON.stringify(vistos));

    const real = async (args, ganchos) => {
      const r = await reg.principal(['--ambiente', amb, ...args], env, {Client, ganchos, prazoLiquidacao: 5000, out: () => {}});
      return {...r, texto: r.linhas.join('\n')};
    };
    // Bootstrap sem antecessoras injetadas: o caminho real chama conferir-antecessoras com o mesmo Client.
    const boot = await real(['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP]);
    ok(boot, /ANTECESSORA 128 JA_APLICADA_POSTCHECK_PASS[\s\S]*APLICADA_POSTCHECK_PASS 129/);
    assert.equal((boot.texto.match(/^ANTECESSORA \d+ JA_APLICADA_POSTCHECK_PASS/gm) ?? []).length, 17, boot.texto);
    assert.doesNotMatch(boot.texto, /ANTECESSORAS?_PENDENTES?|ANTECESSORA \d+ PENDENTE|DISCO/);

    const prova = {};
    const r = await real(['--aplicar-130-autorizado', '--backup', BACKUP], {antesDoCommitCorpo: async ({db}) => {
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // Observador de FORA de C, no mesmo banco (pg_class é por banco): o que o PID de C segura antes do COMMIT do corpo.
      const obs = await apoio.conectar(P, b, 'kidmais-registro-observador');
      let locks, chave;
      try {
        locks = (await obs.query(
          `SELECT l.locktype, l.mode, l.granted, l.classid, l.objid, l.relation::bigint AS relacao, c.relname
             FROM pg_locks l LEFT JOIN pg_class c ON l.locktype = 'relation' AND c.oid = l.relation
            WHERE l.pid = $1 AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`, [pid])).rows;
        chave = (await obs.query(`SELECT hashtext('kidmais-migration') AS k1, hashtext($1) AS k2`, [`${amb}:130`])).rows[0];
      } finally { await obs.end(); }
      prova.pid = pid;
      prova.trava = locks.some(l => l.locktype === 'advisory' && l.granted && l.mode === 'ExclusiveLock' &&
        (l.classid | 0) === chave.k1 && (l.objid | 0) === chave.k2);
      prova.escritaRegistro = locks.some(l => l.relname === 'operacao_migration_tentativas' && l.mode === 'RowExclusiveLock' && l.granted);
      // Relações criadas pela 130 ainda não commitadas são invisíveis ao observador (relname nulo): guarda o oid e resolve depois.
      prova.ddl = locks.filter(l => l.locktype === 'relation' && l.mode === 'AccessExclusiveLock' && l.granted).map(l => String(l.relacao));
      const vista = (await admin.query('SELECT pid, application_name FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0];
      prova.app = vista?.application_name;
    }});
    ok(r, /APLICADA_POSTCHECK_PASS 130/);
    assert.ok(prova.trava, 'o backend de C segura a trava advisory ' + amb + ':130');
    assert.ok(prova.escritaRegistro, 'o backend de C escreveu no registro na transação do corpo');
    const criadas = (await sql(b, 'SELECT relname FROM pg_class WHERE oid = ANY($1::oid[])', [prova.ddl])).rows.map(x => x.relname);
    for (const tabela of ['pre_reserva_configuracoes', 'pre_reserva_aceites', 'pre_reserva_recebimentos'])
      assert.ok(criadas.includes(tabela), `o PID de C criou ${tabela} (AccessExclusiveLock antes do COMMIT): ${criadas.join(',')}`);
    assert.match(prova.app ?? '', /registro|migration/);
    const lin = (await sql(b, "SELECT ambiente, situacao FROM operacao_migration_tentativas WHERE migration IN ('129','130') ORDER BY migration")).rows;
    assert.deepEqual(lin, [{ambiente: amb, situacao: 'CONCLUIDA'}, {ambiente: amb, situacao: 'CONCLUIDA'}]);
  });
}
