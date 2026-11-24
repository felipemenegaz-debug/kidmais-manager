/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
// Provas em PostgreSQL descartável do plano "Staging em dia antes da 129" (vault, 22/11/2026): §4, §7.5 e §8.
// Modelo igual ao staging real: cadeia até a 128 (sem a 098, como o modelo da receita) SEM 110, 111, 115, 120 e 121, com a
// 116 aplicada. Adaptadores reais (alvo, SQL e regra de identidade de staging/production) com o env falso do serviço; o
// Client só redireciona a rede para o cluster descartável (mesma técnica de registro-migrations-banco.postgres-r2.test.cjs).
// Travas: só KIDMAIS_REGISTRO_PG_PORTA (5432/5433 recusadas), sem DATABASE_URL/KIDMAIS_HOMOLOGACAO_DATABASE_URL/PG*.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const apoio = require('./registro-migrations-banco.pg-apoio.cjs');
const reg = require('./registro-migrations-banco.cjs');
const ca = require('./conferir-antecessoras.cjs');
const gs = require('./migration-generico-staging.cjs');

const P = apoio.porta();
const pular = P ? false : 'KIDMAIS_REGISTRO_PG_PORTA ausente: testes de PG não rodaram';
const raiz = path.resolve(__dirname, '..');
const MODELO = 'registro_staging_real_128';
const CINCO = ['120', '121', '110', '111', '115'];
const BACKUP = 'backup-teste-local:2026-11-22';
const DECL_STG = 'staging print-cron-staging:2026-11-22';
const DECL_PRD = 'production print-cron-production:2026-11-22';
const E = '00000000-0000-0000-0000-0000000000e1';
const C = '00000000-0000-0000-0000-0000000000c1';
let admin, seq = 0;
const bancos = [];

const SIMULADO = {
  production: {banco: 'kidmais_production', env: {RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production',
    DATABASE_SSL: 'true', DATABASE_URL: 'postgresql://usuario_teste:senha_teste_local@dpg-dak750gae00c73fudmg0-a/kidmais_production'}},
  staging: {banco: 'kidmais_staging_1z91', env: {RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging',
    DATABASE_SSL: 'true', DATABASE_URL: 'postgresql://usuario_teste:senha_teste_local@dpg-daidko3m8hqs73ce4jt0-a/kidmais_staging_1z91'}},
};

/**
 * Client que recebe a configuração do adaptador real e só troca a rede pelo cluster descartável (ou pelo proxy em `porta`);
 * a linha de identidade/TLS vem com o banco e o TLS do serviço `amb`. `log` guarda o texto de cada consulta; `instancias`
 * conta quantos clientes foram criados (recusa antes de conectar = 0).
 */
function clienteSimulado(nomeBanco, amb, {porta = P, log = [], instancias = {n: 0}} = {}) {
  const {Client} = require('pg');
  const esperado = SIMULADO[amb];
  return class ClienteSimulado extends Client {
    constructor(cfg) {
      instancias.n++;
      super({host: apoio.HOST, port: porta, user: apoio.USUARIO, database: nomeBanco, application_name: cfg.application_name,
        password: () => Promise.reject(new Error('o servidor pediu senha'))});
      this.on('error', () => undefined);
    }
    query(q, ...resto) {
      const texto = typeof q === 'string' ? q : q?.text;
      log.push(String(texto));
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

const ler = rel => fs.readFileSync(path.join(raiz, rel), 'utf8');

/** Modelo do staging real: até a 128, sem a 098 e sem as cinco nunca aplicadas em staging. */
async function garantirModelo() {
  const existe = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [MODELO])).rowCount === 1;
  if (existe && !process.env.KIDMAIS_REGISTRO_RECRIAR_MODELO) return;
  await admin.query(`DROP DATABASE IF EXISTS ${MODELO}`);
  await admin.query(`CREATE DATABASE ${MODELO} TEMPLATE template0`);
  const inv = await import(pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href);
  const arquivos = [...inv.approvedFiles];
  const fim = arquivos.findIndex(a => a.split('_')[1] === '128');
  const c = await apoio.conectar(P, MODELO);
  try {
    for (const a of arquivos.slice(0, fim + 1).filter(x => !['098', ...CINCO].includes(x.split('_')[1])))
      await aplicarArquivo(c, a, inv.requiredChecks);
  } catch (e) { await c.end(); await admin.query(`DROP DATABASE IF EXISTS ${MODELO}`); throw e; }
  await c.end();
}
async function aplicarArquivo(c, arquivo, checks) {
  if (arquivo.split('_')[1] === '046') {
    const email = (ler('database/migrations/' + arquivo).match(/email_alvo text := '([^']+)'/) ?? [])[1];
    const b64 = n => crypto.randomBytes(n).toString('base64').replace(/=+$/, '');
    await c.query("INSERT INTO usuarios_administrativos (email, nome, cargo, senha_hash, papel, ativo) VALUES (lower(btrim($1)), 'Fixture', 'Fixture', $2, 'REPRESENTANTE_AUTORIZADO', true)",
      [email, 'scrypt$v=1$N=131072$r=8$p=1$' + b64(16) + '==$' + b64(64) + '==']);
  }
  const ex = checks(arquivo);
  for (const k of ex.filter(x => x.includes('precheck'))) await c.query(ler('database/checks/' + k));
  await c.query(ler('database/migrations/' + arquivo));
  for (const k of ex.filter(x => !x.includes('precheck'))) await c.query(ler('database/checks/' + k));
}

test.before(async () => {
  if (pular) return;
  admin = await apoio.conectar(P, 'postgres');
  await garantirModelo();
});
test.after(async () => {
  if (!admin) return;
  for (const b of bancos) await apoio.removerBanco(admin, b).catch(() => {});
  await admin.end();
});
async function banco() {
  const nome = `registro_stg_${process.pid}_${++seq}`;
  bancos.push(nome);
  return apoio.novoBanco(admin, nome, MODELO);
}
async function sql(b, texto, params) {
  const c = await apoio.conectar(P, b, 'kidmais-registro-observador');
  try { return await c.query(texto, params); } finally { await c.end(); }
}
// Dados da 116 com a flag ligada: replica pula FK/gatilhos de usuário só nesta sessão de fixture (CHECKs continuam valendo).
const ciclo = b => sql(b, `SET session_replication_role = replica;
  INSERT INTO ia_credito_franquias_ciclo (empresa_id, recurso, ciclo, chave, lote_id, tipo, concedido)
  VALUES ('${E}', 'CONVITE', '2026-11-01', 'FRANQUIA:2026-11', gen_random_uuid(), 'ADOCAO', 10)`);
const contratacao = (b, estado) => sql(b, `SET session_replication_role = replica;
  INSERT INTO assinatura_contratacoes (id, empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos,
    valor_final_centavos, estado, criada_por, confirmada_em, pagamento_confirmacao_id, provedor_assinatura_id)
  VALUES ('${C}', '${E}', gen_random_uuid(), 'ESSENCIAL', 'MENSAL', 'teste', 19700, 19700, '${estado}', gen_random_uuid(), `
  + (estado === 'CONFIRMADA' ? "clock_timestamp() + interval '1 second', 'pg-teste', 'prov-teste')" : 'NULL, NULL, NULL)'));
const pendencia = (b, processada) => sql(b, `SET session_replication_role = replica;
  INSERT INTO ia_credito_franquia_pendencias (empresa_id, contratacao_id, processada_em, tentativas)
  VALUES ('${E}', '${C}', ${processada ? 'clock_timestamp()' : 'NULL'}, ${processada ? 1 : 0})`);

const envDe = amb => SIMULADO[amb].env;
const aplicar = (b, id, opts = {}) => gs.principal([gs.FLAG_APLICAR, id, gs.FLAG_BACKUP, BACKUP], envDe('staging'),
  {Client: clienteSimulado(b, 'staging', opts)});
const conferirId = (b, id, opts = {}) => gs.principal([gs.FLAG_CONFERIR, id], envDe('staging'), {Client: clienteSimulado(b, 'staging', opts)});
const antecessoras = (b, amb, decl, opts = {}) => ca.conferir({ambiente: amb, env: envDe(amb), flagFranquia: decl,
  deps: {Client: clienteSimulado(b, amb, opts)}});
const linha116 = r => r.linhas.find(l => l.startsWith('116 '));
const existe = async (b, cond) => (await sql(b, `SELECT (${cond}) AS ok`)).rows[0].ok;
const linhas129 = async b => (await sql(b, "SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'operacao_migration_tentativas'")).rows[0].n === 0
  ? 0 : (await sql(b, "SELECT count(*)::int AS n FROM operacao_migration_tentativas WHERE migration = '129'")).rows[0].n;

test('§4.1/§4.2 staging real: pendentes as 5 e a 116 sem declaração; aplica 120→121→110→111→115; ANTECESSORAS_OK; bootstrap da 129 com a declaração; conferir-registro', {skip: pular}, async () => {
  const b = await banco();
  await ciclo(b); // staging real: ciclo com linhas (flag ligada)
  const sem = await antecessoras(b, 'staging');
  assert.equal(sem.codigo, 3);
  assert.deepEqual(sem.pendentes, ['116', ...CINCO], sem.linhas.join('\n'));
  assert.equal(linha116(sem), '116 PENDENTE FLAG_NAO_DECLARADA ' + ca.MOTIVOS_DADOS_116[0]);
  const com = await antecessoras(b, 'staging', DECL_STG);
  assert.deepEqual(com.pendentes, CINCO, com.linhas.join('\n'));
  assert.equal(com.final, 'ANTECESSORAS_PENDENTES ' + CINCO.join(','));
  assert.equal(linha116(com), `116 PRESENTE_OPERACAO_PASS flag=declarada "${DECL_STG}"`);

  // Bootstrap sem a declaração: recusa pelas antecessoras, nenhuma linha da 129.
  const env = envDe('staging');
  const boot = args => reg.principal(['--ambiente', 'staging', ...args], env, {Client: clienteSimulado(b, 'staging'), prazoLiquidacao: 5000, out: () => {}});
  const r0 = await boot(['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP]);
  assert.notEqual(r0.codigo, 0, r0.linhas.join('\n'));
  assert.equal(await linhas129(b), 0);

  // 111 antes da 110: ANTECESSORA_PENDENTE (3), nada escrito.
  const cedo = await aplicar(b, '111');
  assert.equal(cedo.saida.resultado, 'ANTECESSORA_PENDENTE');
  assert.equal(cedo.codigo, 3);
  assert.equal(cedo.saida.commit, 'NAO_COMMITADA');
  assert.equal(await existe(b, "to_regclass('public.satisfacao_links_avaliacao') IS NOT NULL"), false);

  for (const id of CINCO) {
    const antes = (await conferirId(b, id)).saida;
    assert.equal(antes.resultado, 'PRONTA_PARA_APLICAR', id + ' ' + JSON.stringify(antes));
    const linhasSaida = [];
    const s = await gs.principal([gs.FLAG_APLICAR, id, gs.FLAG_BACKUP, BACKUP], env, {Client: clienteSimulado(b, 'staging'), out: l => linhasSaida.push(l)});
    assert.equal(s.codigo, 0, id + ' ' + JSON.stringify(s.saida));
    assert.equal(s.saida.resultado, 'APLICADA_POSTCHECK_PASS');
    assert.equal(s.saida.commit, 'CONFIRMADO');
    assert.equal(s.saida.backup, BACKUP);
    assert.equal(s.saida.limpeza, undefined);
    assert.ok(linhasSaida.length >= 1 && linhasSaida.every(l => JSON.parse(l).id === id), linhasSaida.join('\n'));
    assert.equal((await conferirId(b, id)).saida.resultado, 'JA_APLICADA_POSTCHECK_PASS');
  }
  // Segunda execução: JA_APLICADA sem escrita (nenhuma migration nem DDL enviada).
  const log = [];
  const de_novo = await aplicar(b, '120', {log});
  assert.equal(de_novo.codigo, 0);
  assert.equal(de_novo.saida.resultado, 'JA_APLICADA_POSTCHECK_PASS');
  assert.equal(de_novo.saida.commit, 'NAO_APLICAVEL');
  assert.ok(!log.includes(ler('database/migrations/20261109_120_financeiro_movimentos.sql')), 'a migration não foi reenviada');
  assert.ok(!log.some(q => /^\s*COMMIT\s*;?\s*$/i.test(q)), 'nenhum COMMIT de escrita');

  const ok = await antecessoras(b, 'staging', DECL_STG);
  assert.equal(ok.final, 'ANTECESSORAS_OK', ok.linhas.join('\n'));
  const r1 = await boot(['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP, '--franquia-flag-ligada', DECL_STG]);
  assert.equal(r1.codigo, 0, r1.linhas.join('\n'));
  assert.match(r1.linhas.join('\n'), /APLICADA_POSTCHECK_PASS 129/);
  assert.match(r1.linhas.join('\n'), /PRESENTE_OPERACAO_PASS flag=declarada/);
  const sit = (await sql(b, "SELECT ambiente, situacao FROM operacao_migration_tentativas WHERE migration = '129'")).rows;
  assert.deepEqual(sit, [{ambiente: 'staging', situacao: 'CONCLUIDA'}]);
  const r2 = await boot(['--conferir-registro']);
  assert.equal(r2.codigo, 0, r2.linhas.join('\n'));
});

test('§4.3 recusas antes de conectar: id fora da lista, backup inválido ou ausente, env de production, KIDMAIS_DEPLOY_ENV=production', {skip: pular}, async () => {
  const b = await banco();
  const inst = {n: 0};
  const Client = clienteSimulado(b, 'staging', {instancias: inst});
  const stg = envDe('staging');
  await assert.rejects(gs.principal([gs.FLAG_APLICAR, '122', gs.FLAG_BACKUP, BACKUP], stg, {Client}), /ID_FORA_DA_LISTA/);
  await assert.rejects(gs.principal([gs.FLAG_CONFERIR, '116'], stg, {Client}), /ID_FORA_DA_LISTA/);
  await assert.rejects(gs.principal([gs.FLAG_APLICAR, '120', gs.FLAG_BACKUP, 'x'], stg, {Client}), /BACKUP_INVALIDO/);
  await assert.rejects(gs.principal([gs.FLAG_APLICAR, '120'], stg, {Client}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(gs.principal([gs.FLAG_APLICAR, '120', gs.FLAG_BACKUP, BACKUP], envDe('production'), {Client}));
  await assert.rejects(gs.principal([gs.FLAG_APLICAR, '120', gs.FLAG_BACKUP, BACKUP], {...stg, KIDMAIS_DEPLOY_ENV: 'production'}, {Client}));
  await assert.rejects(gs.principal([gs.FLAG_CONFERIR, '120'], {...stg, KIDMAIS_DEPLOY_ENV: 'production'}, {Client}));
  assert.equal(inst.n, 0, 'nenhum cliente criado');
  assert.equal(await existe(b, "to_regclass('public.financeiro_entradas_liquidacoes') IS NOT NULL"), false);
});

test('§4.3 identidade de production no alvo de staging: recusa sem escrita', {skip: pular}, async () => {
  const b = await banco();
  const s = await gs.principal([gs.FLAG_APLICAR, '120', gs.FLAG_BACKUP, BACKUP], envDe('staging'), {Client: clienteSimulado(b, 'production')});
  assert.notEqual(s.codigo, 0, JSON.stringify(s.saida));
  assert.equal(s.saida.commit, 'NAO_COMMITADA');
  assert.match(JSON.stringify(s.saida), /IDENTIDADE/);
  assert.equal(await existe(b, "to_regclass('public.financeiro_entradas_liquidacoes') IS NOT NULL"), false);
});

test('§4.3 precheck falho ⇒ NAO_COMMITADA sem objetos; §7.5 PARCIAL da 110 (uma sentinela) ⇒ recusa sem escrita', {skip: pular}, async () => {
  const b = await banco();
  await sql(b, 'ALTER TABLE financeiro_saidas RENAME TO financeiro_saidas_fora');
  const s = await aplicar(b, '120');
  assert.notEqual(s.codigo, 0, JSON.stringify(s.saida));
  assert.equal(s.saida.commit, 'NAO_COMMITADA');
  assert.equal(s.saida.resultado, 'RECUSARIA');
  assert.equal(await existe(b, "to_regclass('public.financeiro_entradas_liquidacoes') IS NULL AND to_regclass('public.financeiro_saidas_reversoes') IS NULL"), true);
  // Precheck da 115 reprovado (índice da 115 com definição divergente): recusa, nada commitado, o índice da 054 continua.
  await sql(b, 'CREATE INDEX fechamentos_115_empresa_data_idx ON public.fechamentos (empresa_id)');
  const pc = await aplicar(b, '115');
  assert.notEqual(pc.codigo, 0, JSON.stringify(pc.saida));
  assert.equal(pc.saida.commit, 'NAO_COMMITADA');
  assert.match(JSON.stringify(pc.saida), /115/);
  assert.equal(await existe(b, "to_regclass('public.fechamentos_054_empresa_idx') IS NOT NULL"), true);

  // 110 com uma só sentinela (não idempotente) ⇒ PARCIAL ⇒ RECUSARIA (3) sem escrita.
  await sql(b, 'CREATE TABLE satisfacao_envios (id int)');
  const log = [];
  const p = await aplicar(b, '110', {log});
  assert.equal(p.codigo, 3, JSON.stringify(p.saida));
  assert.equal(p.saida.resultado, 'RECUSARIA');
  assert.equal(p.saida.commit, 'NAO_COMMITADA');
  assert.match(JSON.stringify(p.saida.estadoAntes ?? p.saida), /parcial/i);
  assert.ok(!log.includes(ler('database/migrations/20261030_110_satisfacao_pesquisa.sql')), 'a 110 não foi enviada');
  assert.equal(await existe(b, "to_regclass('public.satisfacao_respostas') IS NULL"), true);
});

test('§7.5 115 no estado intermediário (054 e 115 coexistindo) ⇒ PRONTA; aplicar deixa só o da 115; de novo ⇒ JA_APLICADA sem DDL', {skip: pular}, async () => {
  const b = await banco();
  await sql(b, 'CREATE INDEX fechamentos_115_empresa_data_idx ON public.fechamentos (empresa_id, data_evento)');
  assert.equal(await existe(b, "to_regclass('public.fechamentos_054_empresa_idx') IS NOT NULL"), true);
  assert.equal((await conferirId(b, '115')).saida.resultado, 'PRONTA_PARA_APLICAR');
  const s = await aplicar(b, '115');
  assert.equal(s.codigo, 0, JSON.stringify(s.saida));
  assert.equal(s.saida.resultado, 'APLICADA_POSTCHECK_PASS');
  assert.equal(await existe(b, "to_regclass('public.fechamentos_054_empresa_idx') IS NULL AND to_regclass('public.fechamentos_115_empresa_data_idx') IS NOT NULL"), true);
  const oid = async () => (await sql(b, "SELECT to_regclass('public.fechamentos_115_empresa_data_idx')::oid::text AS o")).rows[0].o;
  const antes = await oid();
  const log = [];
  const d = await aplicar(b, '115', {log});
  assert.equal(d.codigo, 0);
  assert.equal(d.saida.resultado, 'JA_APLICADA_POSTCHECK_PASS');
  assert.equal(d.saida.commit, 'NAO_APLICAVEL');
  assert.ok(!log.some(q => /\b(CREATE|DROP)\s+INDEX\b/i.test(q.replace(/--.*$/gm, '')) && !/READ ONLY/i.test(q)), 'nenhum DDL enviado');
  assert.ok(!log.includes(ler('database/migrations/20261103_115_fechamentos_empresa_data.sql')));
  assert.equal(await oid(), antes, 'o índice da 115 é o mesmo (sem recriação)');
});

test('§7.1 trava real: staging:120 segura em outra sessão ⇒ conferir NAO_CONCLUSIVO e aplicar EXECUTOR_ATIVO, sem leitura de catálogo', {skip: pular}, async () => {
  const b = await banco();
  const outra = await apoio.conectar(P, b, 'kidmais-registro-outro-executor');
  try {
    assert.equal((await outra.query(reg.SQL.travaSessao, [gs.chave('120')])).rows[0].ok, true);
    const log = [];
    const c = await conferirId(b, '120', {log});
    assert.equal(c.saida.resultado, 'NAO_CONCLUSIVO');
    assert.equal(c.saida.motivo, 'EXECUTOR_ATIVO 120');
    assert.equal(c.codigo, 2);
    const a = await aplicar(b, '120', {log});
    assert.equal(a.saida.resultado, 'EXECUTOR_ATIVO');
    assert.equal(a.codigo, 3);
    assert.ok(log.every(q => q === reg.SQL.travaSessao), 'só a tentativa da trava: ' + log.join(' | '));
    // Outra migration da lista não é bloqueada pela trava da 120.
    assert.equal((await conferirId(b, '121')).saida.resultado, 'PRONTA_PARA_APLICAR');
  } finally { await outra.end(); }
});

/**
 * P2-5 (Astra r1 do código): COMMIT retido no proxy com o backend da 1ª sessão VIVO (transação aberta e a trava de sessão
 * presa). O aplicador perde a conexão: FALHA 2 commit=INDETERMINADO. Enquanto a 1ª sessão vive, a conferência numa 2ª sessão
 * dá NAO_CONCLUSIVO (EXECUTOR_ATIVO) sem ler nada; só depois de liberar o COMMIT retido ao servidor a conferência reconcilia.
 */
async function commitRetido(b, id, {antes} = {}) {
  const px = await apoio.proxy(P);
  try {
    px.regra = (cx, d) => apoio.ehComando(d, 'COMMIT') ? 'reter' : 'passar';
    const s = await aplicar(b, id, {porta: px.porta});
    assert.equal(s.codigo, 2, JSON.stringify(s.saida));
    assert.equal(s.saida.resultado, 'FALHA');
    assert.equal(s.saida.commit, 'INDETERMINADO');
    assert.ok(s.saida.ultimo?.etapas?.length > 0, 'último registro guardado: ' + JSON.stringify(s.saida));
    assert.match(s.saida.reconciliar, new RegExp('não repetir; rodar --conferir ' + id));
    assert.match(s.saida.limpeza ?? '', /UNLOCK/, 'a falha do unlock (conexão morta) vira o campo limpeza');
    assert.ok(px.retida, 'o COMMIT ficou retido com o backend vivo');
    // 1ª sessão viva: a trava staging:<id> continua presa no servidor.
    const log = [];
    const c = await conferirId(b, id, {log});
    assert.equal(c.saida.resultado, 'NAO_CONCLUSIVO', JSON.stringify(c.saida));
    assert.equal(c.saida.motivo, 'EXECUTOR_ATIVO ' + id);
    assert.equal(c.codigo, 2);
    assert.ok(log.every(q => q === reg.SQL.travaSessao), 'só a tentativa da trava: ' + log.join(' | '));
    if (antes) await antes();
    await px.liberar(px.retida); // o servidor recebe o COMMIT e a sessão termina (a trava cai com ela)
  } finally { await px.fechar(); }
  let c;
  for (let i = 0; i < 20; i++) {
    c = (await conferirId(b, id)).saida;
    if (c.resultado !== 'NAO_CONCLUSIVO') break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(c.resultado, 'JA_APLICADA_POSTCHECK_PASS', JSON.stringify(c));
}

test('§7.4/§8.3 P2-5: COMMIT da 120 retido com a 1ª sessão viva ⇒ FALHA 2 INDETERMINADO; 2ª sessão NAO_CONCLUSIVO; liberado ⇒ reconcilia', {skip: pular}, async () => {
  const b = await banco();
  await commitRetido(b, '120', {antes: async () => {
    // Antes de liberar, nada da 120 é visível fora da transação retida.
    assert.equal(await existe(b, "to_regclass('public.financeiro_entradas_liquidacoes') IS NULL"), true);
  }});
});

test('§7.4/§7.5 P2-5: 115 com os índices da 054 e da 115 coexistindo e COMMIT retido ⇒ NAO_CONCLUSIVO com a sessão viva; liberado ⇒ só o da 115', {skip: pular}, async () => {
  const b = await banco();
  await sql(b, 'CREATE INDEX fechamentos_115_empresa_data_idx ON public.fechamentos (empresa_id, data_evento)');
  const dois = "to_regclass('public.fechamentos_054_empresa_idx') IS NOT NULL AND to_regclass('public.fechamentos_115_empresa_data_idx') IS NOT NULL";
  assert.equal(await existe(b, dois), true);
  assert.equal((await conferirId(b, '115')).saida.resultado, 'PRONTA_PARA_APLICAR');
  await commitRetido(b, '115', {antes: async () => assert.equal(await existe(b, dois), true, 'os dois índices seguem visíveis até o COMMIT')});
  assert.equal(await existe(b, "to_regclass('public.fechamentos_054_empresa_idx') IS NULL AND to_regclass('public.fechamentos_115_empresa_data_idx') IS NOT NULL"), true);
});

test('P2-1 trava real: staging:110 presa em outra sessão ⇒ 111 conferir NAO_CONCLUSIVO e aplicar EXECUTOR_ATIVO, sem leitura', {skip: pular}, async () => {
  const b = await banco();
  const outra = await apoio.conectar(P, b, 'kidmais-registro-outro-executor-110');
  try {
    assert.equal((await outra.query(reg.SQL.travaSessao, [gs.chave('110')])).rows[0].ok, true);
    const log = [];
    const c = await conferirId(b, '111', {log});
    assert.equal(c.saida.resultado, 'NAO_CONCLUSIVO', JSON.stringify(c.saida));
    assert.equal(c.saida.motivo, 'EXECUTOR_ATIVO 110');
    assert.equal(c.codigo, 2);
    const a = await aplicar(b, '111', {log});
    assert.equal(a.saida.resultado, 'EXECUTOR_ATIVO');
    assert.equal(a.codigo, 3);
    assert.ok(log.every(q => q === reg.SQL.travaSessao || q === gs.SQL.destrava), 'só travas e o unlock da 111: ' + log.join(' | '));
  } finally { await outra.end(); }
  // Sem a trava presa, a 111 conferida sem a 110 aplicada: a mesma regra da antecessora do aplicar (código 3).
  const sem = await conferirId(b, '111');
  assert.equal(sem.saida.resultado, 'ANTECESSORA_PENDENTE');
  assert.equal(sem.codigo, 3);
});

test('§4.4/§8.2 116: íntegra (vazia ou pendência legítima) = OK com ou sem declaração nos dois ambientes; dados ⇒ declaração; anomalias pendentes', {skip: pular}, async () => {
  const b = await banco();
  const so116 = async (amb, decl) => {
    return (await ca.conferir116({ambiente: amb, env: envDe(amb), declaracao: decl, deps: {Client: clienteSimulado(b, amb)}})).linha;
  };
  const nucleo = async () => {
    const comum = require('./migration-116-comum.cjs');
    const m = require('./migration-116-staging.cjs');
    const Client = clienteSimulado(b, 'staging');
    const db = new Client(m.alvo(envDe('staging'))); await db.connect();
    try { return await comum.conferirNoCliente(db, {raiz, sqlIdentidade: m.SQL_IDENTIDADE, identidade: l => m.identidade(l, envDe('staging'))}); }
    finally { await db.end(); }
  };
  const OK = '116 JA_APLICADA_POSTCHECK_PASS';
  for (const amb of ['staging', 'production']) {
    assert.equal(await so116(amb), OK, amb);
    assert.equal(await so116(amb, amb === 'staging' ? DECL_STG : DECL_PRD), OK, amb + ' com declaração');
  }
  await contratacao(b, 'CONFIRMADA');
  await pendencia(b, false); // pendência legítima
  for (const amb of ['staging', 'production']) {
    assert.equal(await so116(amb), OK);
    assert.equal(await so116(amb, amb === 'staging' ? DECL_STG : DECL_PRD), OK);
  }
  // Pendência processada: motivo de dados (igualdade com o texto real do PG); só passa com a declaração.
  await sql(b, `UPDATE ia_credito_franquia_pendencias SET processada_em = clock_timestamp(), tentativas = 1`);
  const r = await nucleo();
  assert.equal(r.resultado, 'RECUSARIA');
  assert.equal(r.motivo, ca.MOTIVOS_DADOS_116[1], 'MOTIVOS_DADOS_116[1] = texto real do PG');
  assert.equal(await so116('staging'), '116 PENDENTE FLAG_NAO_DECLARADA ' + ca.MOTIVOS_DADOS_116[1]);
  assert.equal(await so116('staging', DECL_STG), `116 PRESENTE_OPERACAO_PASS flag=declarada "${DECL_STG}"`);
  // Ciclo com linhas: o outro motivo de dados.
  await sql(b, 'DELETE FROM ia_credito_franquia_pendencias');
  await ciclo(b);
  assert.equal((await nucleo()).motivo, ca.MOTIVOS_DADOS_116[0], 'MOTIVOS_DADOS_116[0] = texto real do PG');
  assert.equal(await so116('staging', DECL_STG), `116 PRESENTE_OPERACAO_PASS flag=declarada "${DECL_STG}"`);
  // Pendência de contratação não CONFIRMADA: anomalia que não depende da flag ⇒ pendente mesmo com a declaração.
  await sql(b, `SET session_replication_role = replica; UPDATE assinatura_contratacoes SET estado = 'EM_ABERTO', confirmada_em = NULL,
    pagamento_confirmacao_id = NULL, provedor_assinatura_id = NULL`);
  await pendencia(b, false);
  assert.match(await so116('staging', DECL_STG), /^116 PENDENTE .*116 operacao: pendência de contratação não confirmada/);
  // Coluna alterada com linhas: pendente com o motivo ORIGINAL do núcleo (não passa pela operação), com ou sem declaração.
  await sql(b, 'DELETE FROM ia_credito_franquia_pendencias; ALTER TABLE ia_credito_franquias_ciclo ALTER COLUMN versao_tabela TYPE varchar(40)');
  const original = (await nucleo()).motivo;
  assert.ok(!ca.MOTIVOS_DADOS_116.includes(original), original);
  assert.equal(await so116('staging', DECL_STG), '116 PENDENTE RECUSARIA ' + original);
  assert.equal(await so116('staging'), '116 PENDENTE RECUSARIA ' + original);
});

test('§8.1 declaração de staging em production (conferidor e bootstrap) e de production em staging: recusa antes de conectar, sem linha da 129', {skip: pular}, async () => {
  const b = await banco();
  await ciclo(b);
  const inst = {n: 0};
  const ant = await antecessoras(b, 'production', DECL_STG, {instancias: inst});
  assert.equal(ant.codigo, 1);
  assert.match(ant.linhas[0], /^RECUSADO FLAG_DECLARADA_OUTRO_AMBIENTE/);
  const ant2 = await antecessoras(b, 'staging', DECL_PRD, {instancias: inst});
  assert.equal(ant2.codigo, 1);
  assert.match(ant2.linhas[0], /^RECUSADO FLAG_DECLARADA_OUTRO_AMBIENTE/);
  for (const [amb, decl] of [['production', DECL_STG], ['staging', DECL_PRD]]) {
    const r = await reg.principal(['--ambiente', amb, '--aplicar-129-bootstrap-autorizado', '--backup', BACKUP, '--franquia-flag-ligada', decl],
      envDe(amb), {Client: clienteSimulado(b, amb, {instancias: inst}), prazoLiquidacao: 5000, out: () => {}});
    assert.equal(r.codigo, 1, r.linhas.join('\n'));
    assert.match(r.linhas.join('\n'), /FLAG_DECLARADA_OUTRO_AMBIENTE/);
  }
  assert.equal(inst.n, 0, 'nenhum cliente criado');
  assert.equal(await linhas129(b), 0);
  // Sem a declaração em production a 116 com dados continua pendente (nada aceito por engano).
  const semDecl = await antecessoras(b, 'production');
  assert.equal(linha116(semDecl), '116 PENDENTE FLAG_NAO_DECLARADA ' + ca.MOTIVOS_DADOS_116[0]);
});

test('§8.4 chaves da trava sem colisão de hashtext (constantes dos módulos)', {skip: pular}, async () => {
  const chaves = [...gs.CHAVES_TRAVA, ...reg.CHAVES_TRAVA];
  for (const k of ['staging:120', 'staging:121', 'staging:110', 'staging:111', 'staging:115', 'staging:129', 'production:129',
    'staging:130', 'production:131']) assert.ok(chaves.includes(k), k);
  const r = await admin.query('SELECT hashtext(k) AS h, array_agg(DISTINCT k) AS ks FROM unnest($1::text[]) AS k GROUP BY 1 HAVING count(DISTINCT k) > 1', [chaves]);
  assert.deepEqual(r.rows, []);
  const familia = await admin.query("SELECT hashtext('kidmais-migration') AS h");
  assert.equal(typeof familia.rows[0].h, 'number');
});
