/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
// Apoio dos testes PostgreSQL do registro de migrations (vault "Registro de migrations no banco 20261120", §4).
// Só o cluster descartável local: porta por KIDMAIS_REGISTRO_PG_PORTA (5432/5433 recusadas), host 127.0.0.1, usuário
// kidmais_descartavel, cluster_name kidmais_descartavel; bancos só com prefixo registro_. DATABASE_URL/PG* herdadas recusam.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {pathToFileURL} = require('node:url');

const HOST = '127.0.0.1', USUARIO = 'kidmais_descartavel', CLUSTER = 'kidmais_descartavel';
const BASE = 'registro_base_128';
const raiz = path.resolve(__dirname, '..');

function porta(env = process.env) {
  const t = env.KIDMAIS_REGISTRO_PG_PORTA;
  if (!t) return null;
  assert.match(t, /^[0-9]{4,5}$/, 'KIDMAIS_REGISTRO_PG_PORTA inválida');
  const p = Number(t);
  assert.ok(p !== 5432 && p !== 5433 && p > 1024 && p < 65536, 'porta recusada');
  const herdadas = Object.keys(env).filter(k => k === 'DATABASE_URL' || k === 'KIDMAIS_HOMOLOGACAO_DATABASE_URL' || /^PG[A-Z]+$/.test(k));
  assert.deepEqual(herdadas, [], 'configuração de conexão herdada: ' + herdadas.join(','));
  return p;
}
const nomeValido = n => { assert.match(n, /^registro_[a-z0-9_]{1,50}$/, 'banco recusado ' + n); return n; };

async function conectar(p, banco, app = 'kidmais-registro-teste') {
  const {Client} = require('pg');
  const c = new Client({host: HOST, port: p, user: USUARIO, database: banco, application_name: app,
    password: () => Promise.reject(new Error('o servidor pediu senha'))});
  c.on('error', () => undefined);
  await c.connect();
  const id = (await c.query("SELECT current_setting('cluster_name') AS cluster, current_user AS u, EXISTS (SELECT 1 FROM pg_database WHERE datname IN ('kidmais_manager')) AS real")).rows[0];
  if (id.cluster !== CLUSTER || id.u !== USUARIO || id.real) { await c.end(); throw new Error('cluster descartável não confirmado'); }
  return c;
}

const ler = rel => fs.readFileSync(path.join(raiz, rel), 'utf8');
async function aplicarArquivo(c, arquivo, checks) {
  if (arquivo.split('_')[1] === '046') {
    const email = (ler('database/migrations/' + arquivo).match(/email_alvo text := '([^']+)'/) ?? [])[1];
    const b64 = n => randomBytes(n).toString('base64').replace(/=+$/, '');
    await c.query("INSERT INTO usuarios_administrativos (email, nome, cargo, senha_hash, papel, ativo) VALUES (lower(btrim($1)), 'Fixture', 'Fixture', $2, 'REPRESENTANTE_AUTORIZADO', true)",
      [email, `scrypt$v=1$N=131072$r=8$p=1$${b64(16)}==$${b64(64)}==`]);
  }
  const ex = checks(arquivo);
  for (const k of ex.filter(x => x.includes('precheck'))) await c.query(ler('database/checks/' + k));
  await c.query(ler('database/migrations/' + arquivo));
  for (const k of ex.filter(x => !x.includes('precheck'))) await c.query(ler('database/checks/' + k));
}

/** Modelo com o inventário até a 128 (sem a 129): recriado só se ausente ou se `recriar`. */
async function garantirBase(admin, p, {recriar = false, log = () => {}} = {}) {
  const existe = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [BASE])).rowCount === 1;
  if (existe && !recriar) return BASE;
  await admin.query(`DROP DATABASE IF EXISTS ${nomeValido(BASE)}`);
  await admin.query(`CREATE DATABASE ${BASE} TEMPLATE template0`);
  const inv = await import(pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href);
  const arquivos = [...inv.approvedFiles];
  const fim = arquivos.findIndex(a => a.split('_')[1] === '128');
  const c = await conectar(p, BASE);
  try {
    for (const a of arquivos.slice(0, fim + 1).filter(x => x.split('_')[1] !== '098')) { // como o modelo '128' da receita (sem a 098)
      await aplicarArquivo(c, a, inv.requiredChecks); log(a); }
  } catch (e) { await c.end(); await admin.query(`DROP DATABASE IF EXISTS ${BASE}`); throw e; }
  await c.end();
  return BASE;
}
async function novoBanco(admin, nome, modelo = BASE) {
  nomeValido(nome);
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [nome]);
  await admin.query(`DROP DATABASE IF EXISTS ${nome}`);
  await admin.query(`CREATE DATABASE ${nome} TEMPLATE ${nomeValido(modelo)}`);
  return nome;
}
async function removerBanco(admin, nome) {
  nomeValido(nome);
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [nome]);
  await admin.query(`DROP DATABASE IF EXISTS ${nome}`);
}

/** Ambiente injetado: alvo local e identidade = cluster descartável + banco esperado. */
function ambienteLocal(p, banco, portaAlvo = p) {
  return {
    alvo: app => ({host: HOST, port: portaAlvo, user: USUARIO, database: banco, application_name: app,
      password: () => Promise.reject(new Error('o servidor pediu senha'))}),
    sqlIdentidade: "SELECT current_setting('cluster_name') AS cluster, current_database() AS banco",
    identidade: l => { assert.ok(l?.cluster === CLUSTER && l?.banco === banco, 'identidade divergente'); return l; },
  };
}

/**
 * Proxy TCP entre o módulo e o PG. `regra(cx, dados)` decide cada pacote do cliente: 'passar', 'cortar' (fecha os dois lados
 * sem repassar), 'reter' (guarda o pacote, fecha só o lado do cliente; o backend fica vivo), 'segurar' (guarda o pacote e não
 * responde nem fecha: o cliente espera até o prazo local dele), 'cortarResposta' (repassa e fecha
 * os dois lados quando a resposta chegar). A regra é de uso único quando devolve algo diferente de 'passar'.
 */
async function proxy(portaPg) {
  const ctl = {regra: null, conexoes: []};
  const srv = net.createServer(c => {
    const s = net.connect(portaPg, HOST);
    const cx = {c, s, retido: null, cortarResposta: false};
    ctl.conexoes.push(cx);
    c.on('error', () => undefined); s.on('error', () => undefined);
    c.on('close', () => { if (!cx.retido) s.destroy(); });
    s.on('close', () => c.destroy());
    c.on('data', d => {
      const acao = ctl.regra ? ctl.regra(cx, d) : 'passar';
      if (acao !== 'passar') ctl.regra = null;
      if (acao === 'passar') s.write(d);
      else if (acao === 'cortar') { c.destroy(); s.destroy(); }
      else if (acao === 'reter') { cx.retido = d; ctl.retida = cx; c.destroy(); }
      else if (acao === 'segurar') { cx.retido = d; ctl.retida = cx; } // cliente fica pendurado sem resposta (prazo local)
      else if (acao === 'cortarResposta') { cx.cortarResposta = true; s.write(d); }
    });
    s.on('data', d => { if (cx.cortarResposta) { c.destroy(); s.destroy(); } else c.write(d); });
  });
  await new Promise(r => srv.listen(0, HOST, r));
  ctl.porta = srv.address().port;
  ctl.liberar = async cx => { cx.s.write(cx.retido); await new Promise(r => setTimeout(r, 300)); cx.s.end(); };
  ctl.descartar = cx => cx.s.destroy();
  ctl.fechar = () => new Promise(r => { for (const cx of ctl.conexoes) { cx.c.destroy(); cx.s.destroy(); } srv.close(() => r()); });
  return ctl;
}
const ehComando = (d, cmd) => d[0] === 0x51 && d.includes(Buffer.from(cmd + '\0'));
const contem = (d, texto) => d.includes(Buffer.from(texto));

module.exports = {porta, conectar, garantirBase, novoBanco, removerBanco, ambienteLocal, proxy, ehComando, contem, BASE, HOST, USUARIO, CLUSTER};
