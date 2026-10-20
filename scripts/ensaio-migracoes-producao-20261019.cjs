/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Ensaio LOCAL do pacote de migrations de produção de 19/10/2026 num cluster PostgreSQL 18 NOVO e DESCARTÁVEL.
 * Nunca usa DATABASE_URL/PG*, a porta 5432/5433, o banco kidmais_manager nem qualquer host fora de 127.0.0.1.
 *
 *   node scripts/ensaio-migracoes-producao-20261019.cjs preparar   cria o cluster (pasta inexistente, porta livre) e prova a identidade
 *   node scripts/ensaio-migracoes-producao-20261019.cjs ensaiar    monta produção (…074 sem 060/065, + 079 + 084), dados sintéticos,
 *                                                                  aplica o pacote, injeta falhas, compara com a referência de staging
 *   node scripts/ensaio-migracoes-producao-20261019.cjs suites     suítes PostgreSQL 083/085/086 contra o schema resultante (ordem de produção)
 *   node scripts/ensaio-migracoes-producao-20261019.cjs encerrar   para o cluster DESTE diretório e confirma
 *   node scripts/ensaio-migracoes-producao-20261019.cjs limpar     remove o diretório do cluster (parado, sem links); relatórios ficam
 *
 * Exige KIDMAIS_ENSAIO_20261019_AUTORIZACAO="<diretório>|127.0.0.1:<porta>|kidmais_descartavel" (literal).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {variavelDeConexaoHerdada, ambienteDaSuite, estadoDaSuite} = require('./regressao-v1-selecao.cjs');

const PAI = 'D:\\glass\\KidMais Manager\\ambientes-locais';
const DIR = PAI + '\\pg-descartavel-migracoes-producao-20261019';
const RELATORIOS = DIR + '-relatorios';
const BIN = 'C:\\Program Files\\PostgreSQL\\18\\bin';
const HOST = '127.0.0.1';
const PORTA = 55611;
const PAPEL = 'kidmais_descartavel';
const AUTORIZACAO = `${DIR}|${HOST}:${PORTA}|${PAPEL}`;
const raiz = path.resolve(__dirname, '..');
const BASE = 'kidmais_ensaio_producao_base';
const DADOS = 'kidmais_ensaio_producao_dados';
const FALHAS = 'kidmais_ensaio_producao_falhas';
const RESULTADO = 'kidmais_ensaio_producao_resultado';
const REFERENCIA = 'kidmais_ensaio_referencia_staging';
const TRAVA_DB = 'kidmais_ensaio_producao_trava';
const CATEGORIA_DB = 'kidmais_ensaio_producao_categoria';
const PROPRIOS = [BASE, DADOS, FALHAS, RESULTADO, REFERENCIA, TRAVA_DB, CATEGORIA_DB];
/** Modelos da receita substituídos pelo schema na ORDEM DE PRODUÇÃO (para as suítes). */
const MODELOS_SUITES = {'084': 'kidmais_v1_modelo_084', '083': 'kidmais_v1_modelo_083', '086': 'kidmais_v1_modelo_086'};
const SUITES = ['lib/marketing/migration-085-086.postgres.test.ts', 'lib/marketing/aplicador-085-086.postgres.test.ts',
  'lib/marketing/marketing-a.postgres.test.ts', 'lib/marketing/automacoes/automacoes-b.postgres.test.ts', 'lib/marketing/correcoes-r1-r4.postgres.test.ts',
  'lib/marketing/correcoes-o1-o2.postgres.test.ts', 'lib/marketing/correcao-f1.postgres.test.ts', 'lib/marketing/composicao-convites-085-086.postgres.test.ts',
  'lib/whatsapp/conexao-empresa.postgres.test.ts'];

const falhar = m => { throw new Error('ensaio recusado: ' + m); };
const carimbo = () => new Date().toISOString().replace(/[:.]/g, '-');
function registrar(nome, conteudo) {
  fs.mkdirSync(RELATORIOS, {recursive: true});
  const arquivo = path.join(RELATORIOS, `${carimbo()}-${nome}`);
  fs.writeFileSync(arquivo, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo, null, 2));
  return arquivo;
}
function ambienteLimpo(extra = {}) {
  const env = {...process.env};
  for (const k of Object.keys(env)) if (variavelDeConexaoHerdada(k) || /DATABASE_URL$/i.test(k)) delete env[k];
  return {...env, ...extra};
}
function exigirAutorizacao() {
  if (process.env.KIDMAIS_ENSAIO_20261019_AUTORIZACAO !== AUTORIZACAO) falhar(`defina KIDMAIS_ENSAIO_20261019_AUTORIZACAO=${AUTORIZACAO}`);
  for (const k of Object.keys(process.env)) if (variavelDeConexaoHerdada(k) || /DATABASE_URL$/i.test(k)) delete process.env[k];
  Object.assign(process.env, {KIDMAIS_POSTGRES_DESCARTAVEL: 'kidmais_pacotes_v1_descartavel', KIDMAIS_DESCARTAVEL_PORTA: String(PORTA),
    KIDMAIS_DESCARTAVEL_AUTORIZACAO: `${HOST}:${PORTA}/kidmais_pacotes_v1_descartavel`});
}
function exigirCaminhoReal(deveExistir) {
  if (fs.realpathSync.native(PAI).toLowerCase() !== PAI.toLowerCase() || fs.lstatSync(PAI).isSymbolicLink()) falhar('pai redirecionado');
  if (!deveExistir) return;
  const st = fs.lstatSync(DIR);
  if (st.isSymbolicLink() || !st.isDirectory() || fs.realpathSync.native(DIR).toLowerCase() !== DIR.toLowerCase()) falhar('diretório redirecionado');
}
const escuta = () => new Promise(resolve => {
  const s = net.connect({host: HOST, port: PORTA});
  s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); s.setTimeout(2000, () => { s.destroy(); resolve(false); });
});
const ocupada = host => new Promise(resolve => {
  const s = net.createServer(); s.once('error', e => resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES'));
  s.once('listening', () => s.close(() => resolve(false))); s.listen({host, port: PORTA, exclusive: true});
});
function bin(nome, args, opcoes = {}) {
  const r = spawnSync(path.join(BIN, nome), args, {env: ambienteLimpo(), encoding: 'utf8', windowsHide: true, ...opcoes});
  if (r.error) throw r.error;
  return r;
}
async function conectar(banco) {
  const pg = require('pg');
  const c = new pg.Client({host: HOST, port: PORTA, user: PAPEL, database: banco, application_name: 'kidmais-ensaio-20261019',
    password: () => Promise.reject(new Error('o servidor pediu senha; nenhuma credencial é carregada'))});
  await c.connect();
  const id = (await c.query(`SELECT current_setting('cluster_name') AS cluster, host(inet_server_addr()) AS addr, inet_server_port() AS port,
    current_user AS usuario, current_database() AS banco, current_setting('data_directory') AS dir, current_setting('server_version_num')::int AS versao,
    EXISTS (SELECT 1 FROM pg_database WHERE lower(datname) = 'kidmais_manager') AS tem_real`)).rows[0];
  if (id.cluster !== PAPEL || id.addr !== HOST || Number(id.port) !== PORTA || id.usuario !== PAPEL || id.banco !== banco || id.tem_real
    || String(id.dir).replace(/\//g, '\\').toLowerCase() !== (DIR + '\\dados').toLowerCase() || Math.floor(id.versao / 10000) !== 18) {
    await c.end(); falhar('identidade do cluster divergente');
  }
  return c;
}

async function preparar() {
  exigirAutorizacao(); exigirCaminhoReal(false);
  if (fs.existsSync(DIR)) falhar(`${DIR} já existe`);
  if (await escuta() || await ocupada(HOST) || await ocupada('0.0.0.0')) falhar(`porta ${PORTA} ocupada`);
  fs.mkdirSync(DIR); exigirCaminhoReal(true);
  const dados = DIR + '\\dados';
  const init = bin('initdb.exe', ['-D', dados, '-U', PAPEL, '--auth=trust', '--encoding=UTF8', '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--locale=C']);
  registrar('initdb.log', `${init.stdout}\n${init.stderr}`);
  if (init.status !== 0) falhar('initdb falhou');
  fs.appendFileSync(path.join(dados, 'postgresql.conf'), `\n# cluster sintético do ensaio de produção 20261019\nlisten_addresses = '${HOST}'\nport = ${PORTA}\ncluster_name = '${PAPEL}'\nlc_messages = 'C'\nmax_connections = 60\n`);
  fs.mkdirSync(RELATORIOS, {recursive: true});
  const s = bin('pg_ctl.exe', ['-D', dados, '-l', path.join(RELATORIOS, 'server.log'), '-w', '-t', '120', 'start'], {stdio: 'ignore'});
  if (s.status !== 0) falhar('pg_ctl start falhou');
  const c = await conectar('postgres'); await c.end();
  console.log(JSON.stringify({resultado: 'CLUSTER_PRONTO', porta: PORTA, dir: DIR}));
}

// ---------- montagem dos bancos ----------
const ler = rel => fs.readFileSync(path.join(raiz, rel), 'utf8');
async function inventario() {
  const inv = await import(pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href);
  return {arquivos: [...inv.approvedFiles], checks: inv.requiredChecks};
}
async function fixture046(c, arquivo046) {
  const email = (ler('database/migrations/' + arquivo046).match(/email_alvo text := '([^']+)'/) ?? [])[1];
  assert.ok(email, '046 sem e-mail');
  const {randomBytes} = require('node:crypto');
  const b64 = n => randomBytes(n).toString('base64').replace(/=+$/, '');
  await c.query(`INSERT INTO usuarios_administrativos (email, nome, cargo, senha_hash, papel, ativo)
    VALUES (lower(btrim($1)), 'Representante Fixture Sintética', 'Fixture de teste', $2, 'REPRESENTANTE_AUTORIZADO', true)`,
  [email, `scrypt$v=1$N=131072$r=8$p=1$${b64(16)}==$${b64(64)}==`]);
}
async function aplicarInventario(c, arquivo, checks) {
  const exigidos = checks(arquivo);
  if (arquivo.split('_')[1] === '046') await fixture046(c, arquivo);
  for (const x of exigidos.filter(n => n.includes('precheck'))) await c.query(ler('database/checks/' + x));
  await c.query(ler('database/migrations/' + arquivo));
  for (const x of exigidos.filter(n => !n.includes('precheck'))) await c.query(ler('database/checks/' + x));
}
async function recriar(admin, banco, template = 'template0') {
  assert.ok(PROPRIOS.includes(banco) || Object.values(MODELOS_SUITES).includes(banco), 'BANCO_FORA_DA_LISTA ' + banco);
  assert.ok(PROPRIOS.includes(template) || template === 'template0' || Object.values(MODELOS_SUITES).includes(template));
  await admin.query(`DROP DATABASE IF EXISTS ${banco}`);
  await admin.query(`CREATE DATABASE ${banco} TEMPLATE ${template}`);
}
/** Produção: inventário até a 074 sem 060/065 (ordem do inventário), depois 079 (17/10) e 084 (18/10). */
async function montarProducao(admin) {
  const {arquivos, checks} = await inventario();
  const fim = arquivos.findIndex(a => a.split('_')[1] === '074');
  const ordem = [...arquivos.slice(0, fim + 1).filter(a => !['060', '065'].includes(a.split('_')[1])),
    arquivos.find(a => a.split('_')[1] === '079'), arquivos.find(a => a.split('_')[1] === '084')];
  await recriar(admin, BASE);
  const c = await conectar(BASE);
  try { for (const a of ordem) await aplicarInventario(c, a, checks); } finally { await c.end(); }
  return ordem;
}
/** Referência de staging: inventário inteiro na ordem oficial (como os modelos da receita). */
async function montarReferencia(admin) {
  const {arquivos, checks} = await inventario();
  await recriar(admin, REFERENCIA);
  const c = await conectar(REFERENCIA);
  try { for (const a of arquivos) await aplicarInventario(c, a, checks); } finally { await c.end(); }
  return arquivos.length;
}

/** Impressão digital do schema public: a mesma consulta do aplicador (SQL_SCHEMA), também usada no CONFERIR de produção. */
const {SQL_SCHEMA} = require('./migrations-producao-20261019.cjs');
async function impressao(banco) {
  const c = await conectar(banco);
  try { return (await c.query(SQL_SCHEMA)).rows.map(r => r.x); } finally { await c.end(); }
}
/** Ordem física das colunas (informativa): difere quando uma coluna entra por migration em outra ordem. */
async function ordemColunas(banco) {
  const c = await conectar(banco);
  try {
    return Object.fromEntries((await c.query(`SELECT c.relname, string_agg(a.attname, ',' ORDER BY a.attnum) AS cols FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public' JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind = 'r' GROUP BY c.relname`)).rows.map(r => [r.relname, r.cols]));
  } finally { await c.end(); }
}
function diferenca(a, b) {
  const A = new Set(a), B = new Set(b);
  return {soNoPrimeiro: a.filter(x => !B.has(x)), soNoSegundo: b.filter(x => !A.has(x))};
}
module.exports = {SQL_SCHEMA, diferenca, AUTORIZACAO, PORTA, DIR, RELATORIOS};

// ---------- dados sintéticos de produção ----------
const BLOQ = require('./migrations-producao-20261019.cjs').BLOQUEIOS_REPARO;
const DATAS_BLOQ = ['2026-10-15', '2026-11-01', '2026-11-07', '2026-11-13', '2027-05-27'];
async function semear(c) {
  const kidmais = (await c.query("SELECT id FROM empresas WHERE codigo='kidmais'")).rows;
  assert.equal(kidmais.length, 1, 'kidmais sintética ausente');
  const k = kidmais[0].id;
  assert.equal((await c.query('SELECT count(*)::int AS n FROM empresas')).rows[0].n, 1, 'uma empresa só');
  // Cinco bloqueios globais ativos (os do reparo do lançamento), mesmos ids, datas e horários.
  for (let i = 0; i < 5; i++) await c.query("INSERT INTO bloqueios_agenda(id,data,horario_inicio,horario_fim,motivo) VALUES($1,$2,'17:00','21:00','Bloqueio sintetico do ensaio')", [BLOQ[i], DATAS_BLOQ[i]]);
  // Clientes da empresa com CPF (076) e um legado sem empresa.
  const cols = (await c.query("SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='clientes'")).rows;
  const obrig = cols.filter(x => x.is_nullable === 'NO' && x.column_default === null).map(x => x.column_name);
  return {kidmais: k, colunasObrigatoriasClientes: obrig};
}

// ---------- ensaio ----------
/**
 * Processo filho do lançamento em conexão separada, com o MESMO tratamento de marcador do main do aplicador do lançamento
 * (scripts/migrations-lancamento-production.cjs:71-77): `migration-<id>.json` com 'wx' antes de conectar, registrar = etapa.
 */
function viaLancamentoComMarcador(lanc, lancPlano, cliente, banco, dirL) {
  return async id => {
    fs.mkdirSync(dirL, {recursive: true});
    const arq = path.join(dirL, `migration-${id}.json`);
    try { fs.writeFileSync(arq, JSON.stringify({inicio: new Date().toISOString(), id, situacao: 'INICIADA'}), {flag: 'wx', mode: 0o600}); }
    catch (e) { return {ok: false, erro: e.code}; }
    const salvar = r => fs.writeFileSync(arq, JSON.stringify(r), {mode: 0o600});
    try {
      const r = await lanc.etapa(cliente, lancPlano, id, {registrar: salvar, validarIdentidade: x => { assert.equal(x.db, banco, 'BANCO_DIVERGENTE'); assert.equal(x.tls, false); }});
      return {ok: r.resultado === 'APLICADA_POSTCHECK_PASS', saida: r};
    } catch (e) { return {ok: false, erro: String(e.message).slice(0, 160)}; }
  };
}
/** Exclusão da categoria original BOMBONS como o painel antigo permitia (sem uso): o caso D do revisor. */
async function excluirBombons(c) {
  await c.query('BEGIN');
  const cat = (await c.query("SELECT id FROM buffet_categorias WHERE codigo='BOMBONS'")).rows[0].id;
  await c.query('UPDATE adicionais SET origem_buffet_item_id = NULL WHERE origem_buffet_item_id IN (SELECT id FROM buffet_itens WHERE categoria_id=$1)', [cat]);
  await c.query('UPDATE adicionais SET origem_buffet_categoria_id = NULL WHERE origem_buffet_categoria_id = $1', [cat]);
  await c.query('DELETE FROM pacote_buffet_itens WHERE categoria_id=$1', [cat]);
  await c.query('DELETE FROM pacote_itens_especificos WHERE item_id IN (SELECT id FROM buffet_itens WHERE categoria_id=$1)', [cat]);
  await c.query('DELETE FROM pacote_buffet_categorias WHERE categoria_id=$1', [cat]);
  await c.query('DELETE FROM buffet_itens WHERE categoria_id=$1', [cat]);
  await c.query('DELETE FROM buffet_categorias WHERE id=$1', [cat]);
  await c.query('COMMIT');
}

async function ensaiar() {
  exigirAutorizacao(); exigirCaminhoReal(true);
  const pacote = require('./migrations-producao-20261019.cjs');
  const lanc = require('./migrations-lancamento-production.cjs');
  const {sequencia} = pacote.carregar(raiz);
  const lancPlano = lanc.carregar(raiz);
  const relatorio = {inicio: new Date().toISOString(), porta: PORTA, casos: []};
  const caso = (nome, x = {}) => { const r = {caso: nome, resultado: 'PASS', ...x}; relatorio.casos.push(r); console.log(JSON.stringify(r)); return r; };
  const admin = await conectar('postgres');
  const marcadores = path.join(RELATORIOS, 'marcadores-' + carimbo());
  const pastas = nome => ({dir: path.join(marcadores, nome, 'pacote'), dirLancamento: path.join(marcadores, nome, 'lancamento-venda-20261011')});
  const identidadeLocal = banco => id => { assert.equal(id.db, banco, 'BANCO_DIVERGENTE'); assert.equal(Number(id.pg_major), 18); pacote.exigirSearchPath(id); return {banco: id.db, local: true, searchPath: id.search_path}; };
  try {
    const ordem = await montarProducao(admin);
    caso('montagem_producao', {migrations: ordem.length, ultimas: ordem.slice(-4)});
    caso('montagem_referencia_staging', {migrations: await montarReferencia(admin)});
    // Estado inicial reconhecido como o de produção lido em 19/10 + md5 da impressão (para comparar com o CONFERIR real).
    {
      const c = await conectar(BASE);
      try {
        const est = (await pacote.lerTudo(c)).estado;
        const esperado = Object.fromEntries(Object.keys(pacote.OBJETOS).map(id => [id, ['079', '084'].includes(id) ? 'COMPLETA' : 'AUSENTE']));
        assert.deepEqual(est, esperado);
        const imp = (await c.query(pacote.SQL_IMPRESSAO)).rows[0];
        relatorio.impressaoBase = imp;
        caso('estado_inicial_igual_ao_lido_em_producao', {estado: est, impressaoBase: imp});
      } finally { await c.end(); }
    }
    for (const b of [DADOS, FALHAS, RESULTADO, TRAVA_DB, CATEGORIA_DB]) await recriar(admin, b, BASE);

    // ---- DADOS: conferência, aplicação completa, repetição, invariantes, reparo ----
    const c = await conectar(DADOS), c2 = await conectar(DADOS);
    try {
      const semente = await semear(c);
      await semearDados(c, semente.kidmais);
      const antes = await retrato(c);
      caso('dados_sinteticos', {resumo: antes.resumo});
      const p = pastas('dados');
      const conf = await pacote.conferirNoCliente(c, {sequencia, env: {}, identidade: identidadeLocal(DADOS), ...p});
      assert.equal(conf.resultado, 'CONFERIDO', JSON.stringify(conf.verificacoes).slice(0, 600));
      assert.deepEqual(conf.verificacoes.filter(v => v.precheck === 'PASS').map(v => v.id), ['074a', '076', '077', '078', '083', '085']);
      assert.equal(conf.impressaoSchema.md5, relatorio.impressaoBase.md5, 'mesma impressão da base');
      caso('conferir_antes', {plano: conf.plano.map(x => `${x.id}:${x.acao}`), verificacoes: conf.verificacoes, situacao: conf.situacao, impressao: conf.impressaoSchema});
      const via = viaLancamentoComMarcador(lanc, lancPlano, c2, DADOS, p.dirLancamento);
      const ap = await pacote.aplicarNoCliente(c, {sequencia, backup: 'ensaio', identidade: identidadeLocal(DADOS), ...p, lancamento: via});
      assert.equal(ap.resultado, 'PASS', JSON.stringify(ap).slice(0, 600));
      caso('aplicar_sequencia_completa', {etapas: ap.etapas.map(e => ({id: e.id, acao: e.acao, resultado: e.resultado}))});
      const rep = await pacote.aplicarNoCliente(c, {sequencia, backup: 'ensaio', identidade: identidadeLocal(DADOS), ...p, lancamento: via});
      assert.equal(rep.resultado, 'PASS'); assert.ok(rep.etapas.every(e => e.resultado === 'JA_APLICADA_POSTCHECK_PASS'));
      caso('repeticao_so_postchecks_somente_leitura', {etapas: rep.etapas.length});
      const depois = await retrato(c);
      verificarInvariantes(antes, depois, semente.kidmais);
      caso('invariantes_de_dados', {resumo: depois.resumo});
      const conf2 = await pacote.conferirNoCliente(c, {sequencia, env: {}, identidade: identidadeLocal(DADOS), ...p});
      assert.equal(conf2.resultado, 'CONFERIDO');
      assert.ok(conf2.verificacoes.length === sequencia.length && conf2.verificacoes.every(v => v.postcheck === 'PASS'));
      caso('conferir_depois_todos_postchecks', {verificacoes: conf2.verificacoes.length, impressao: conf2.impressaoSchema});
      caso('reparo_bloqueios_pos_migrations', await ensaiarReparo(c, semente.kidmais));
    } finally { await c.end(); await c2.end(); }

    // ---- FALHAS: postcheck que falha desfaz a migration; parada no meio; marcador; retomada ----
    {
      const f = await conectar(FALHAS), f2 = await conectar(FALHAS);
      try {
        const p = pastas('falhas');
        const via = viaLancamentoComMarcador(lanc, lancPlano, f2, FALHAS, p.dirLancamento);
        const quebrada = sequencia.map(e => e.id !== '081' ? e : {...e, arquivos: e.arquivos.map(a => a.tipo === 'postcheck' ? {...a, sql: "DO $$ BEGIN RAISE EXCEPTION 'FALHA_INJETADA_081'; END $$;"} : a)});
        const r1 = await pacote.aplicarNoCliente(f, {sequencia: quebrada, backup: 'ensaio', identidade: identidadeLocal(FALHAS), ...p, lancamento: via});
        assert.equal(r1.resultado, 'FALHA'); assert.equal(r1.falha.etapa, '081'); assert.match(r1.falha.mensagem, /FALHA_INJETADA_081/);
        assert.equal(r1.estadoDepois['080'], 'COMPLETA'); assert.equal(r1.estadoDepois['081'], 'AUSENTE'); assert.equal(r1.estadoDepois['082'], 'AUSENTE');
        const m081 = JSON.parse(fs.readFileSync(path.join(p.dir, 'migration-081.json'), 'utf8'));
        assert.equal(m081.situacao, 'FALHA');
        caso('falha_no_postcheck_081_rollback_integral_e_parada', {confirmadas: r1.confirmadasNestaExecucao, marcador: m081.situacao});
        const r2 = await pacote.aplicarNoCliente(f, {sequencia, backup: 'ensaio', identidade: identidadeLocal(FALHAS), ...p, lancamento: via});
        assert.equal(r2.resultado, 'FALHA'); assert.match(r2.falha.mensagem, /MARCADOR_ANTERIOR migration-081\.json/); assert.equal(r2.estadoDepois['081'], 'AUSENTE');
        assert.equal(r2.nenhumaEscrita, true);
        caso('repeticao_sem_retomada_recusada', {mensagem: r2.falha.mensagem});
        const r3 = await pacote.aplicarNoCliente(f, {sequencia, backup: 'ensaio', retomar: '081', identidade: identidadeLocal(FALHAS), ...p, lancamento: via});
        assert.equal(r3.resultado, 'PASS', JSON.stringify(r3).slice(0, 400));
        assert.ok(fs.existsSync(path.join(p.dir, 'migration-081.tentativa-2.json')));
        caso('retomada_081_explicita_conclui', {etapas: r3.etapas.map(e => `${e.id}:${e.resultado}`)});
        await f.query('ALTER TABLE marketing_tarefas RENAME TO marketing_tarefas_x');
        const r4 = await pacote.aplicarNoCliente(f, {sequencia, backup: 'ensaio', identidade: identidadeLocal(FALHAS), ...p, lancamento: via});
        assert.equal(r4.resultado, 'FALHA'); assert.match(r4.falha.mensagem, /APLICACAO_PARCIAL 086/);
        await f.query('ALTER TABLE marketing_tarefas_x RENAME TO marketing_tarefas');
        caso('parcial_recusada_antes_de_escrever');
        await f.query('DROP ROLE IF EXISTS kidmais_ensaio_sem_posse'); await f.query('CREATE ROLE kidmais_ensaio_sem_posse NOLOGIN');
        const s = await conectar(BASE);
        try {
          await s.query('SET ROLE kidmais_ensaio_sem_posse');
          const t = await pacote.lerTudo(s);
          assert.ok(t.faltas.includes('074a:dono_empresa_assinaturas') && t.faltas.includes('083:dono_whatsapp_conexoes'), t.faltas.join(','));
          assert.throws(() => pacote.planoEtapas(sequencia, t.estado, t.faltas), /SEM_PRIVILEGIO/);
          caso('sem_privilegio_recusado', {faltas: t.faltas.length});
        } finally { await s.query('RESET ROLE').catch(() => {}); await s.end(); }
        await f.query('DROP ROLE kidmais_ensaio_sem_posse');
      } finally { await f.end(); await f2.end(); }
    }

    // ---- C do revisor: transação aberta em clientes derruba a 076 (lock_timeout); retomada explícita da 076 conclui ----
    {
      const c3 = await conectar(TRAVA_DB), c4 = await conectar(TRAVA_DB), trava = await conectar(TRAVA_DB);
      try {
        const p = pastas('trava');
        const via = viaLancamentoComMarcador(lanc, lancPlano, c4, TRAVA_DB, p.dirLancamento);
        const k = (await c3.query("SELECT id FROM empresas WHERE codigo='kidmais'")).rows[0].id;
        await semearDados(c3, k);
        await trava.query('BEGIN');
        await trava.query("UPDATE clientes SET nome_completo = nome_completo WHERE cpf = '00000000191'");
        const t0 = Date.now();
        const r1 = await pacote.aplicarNoCliente(c3, {sequencia, backup: 'ensaio', identidade: identidadeLocal(TRAVA_DB), ...p, lancamento: via});
        const segundos = Math.round((Date.now() - t0) / 100) / 10;
        await trava.query('ROLLBACK');
        assert.equal(r1.resultado, 'FALHA'); assert.equal(r1.falha.etapa, '076'); assert.match(r1.falha.mensagem, /lock timeout/);
        assert.deepEqual(r1.confirmadasNestaExecucao, ['074a', '075']); assert.equal(r1.estadoDepois['076'], 'AUSENTE');
        const meu = JSON.parse(fs.readFileSync(path.join(p.dir, 'lancamento-076.json'), 'utf8'));
        const doFilho = JSON.parse(fs.readFileSync(path.join(p.dirLancamento, 'migration-076.json'), 'utf8'));
        assert.equal(meu.situacao, 'FALHA_SCHEMA_AUSENTE'); assert.equal(doFilho.situacao, 'ANTES_DA_TRANSACAO');
        caso('C_lock_timeout_na_076', {segundos, confirmadas: r1.confirmadasNestaExecucao, marcadorDestePacote: meu.situacao, marcadorDoFilho: doFilho.situacao});
        const conf = await pacote.conferirNoCliente(c3, {sequencia, env: {}, identidade: identidadeLocal(TRAVA_DB), ...p});
        assert.equal(conf.resultado, 'RECUSARIA'); assert.ok(conf.verificacoes.some(v => /MARCADOR_ANTERIOR lancamento-076\.json,lancamento\/migration-076\.json/.test(v.falha ?? '')));
        const r2 = await pacote.aplicarNoCliente(c3, {sequencia, backup: 'ensaio', identidade: identidadeLocal(TRAVA_DB), ...p, lancamento: via});
        assert.equal(r2.resultado, 'FALHA'); assert.match(r2.falha.mensagem, /MARCADOR_ANTERIOR/); assert.equal(r2.nenhumaEscrita, true);
        caso('C_conferir_e_aplicar_sem_retomada_recusam', {conferir: conf.resultado, aplicar: r2.falha.mensagem});
        const r3 = await pacote.aplicarNoCliente(c3, {sequencia, backup: 'ensaio', retomar: '076', identidade: identidadeLocal(TRAVA_DB), ...p, lancamento: via});
        assert.equal(r3.resultado, 'PASS', JSON.stringify(r3.falha));
        assert.ok(fs.existsSync(path.join(p.dirLancamento, 'migration-076.tentativa-2.json')));
        assert.equal(JSON.parse(fs.readFileSync(path.join(p.dirLancamento, 'migration-076.json'), 'utf8')).situacao, 'COMMIT_CONFIRMADO');
        const t2 = JSON.parse(fs.readFileSync(path.join(p.dir, 'lancamento-076.tentativa-2.json'), 'utf8'));
        assert.equal(t2.situacao, 'COMMIT_CONFIRMADO');
        const conf2 = await pacote.conferirNoCliente(c3, {sequencia, env: {}, identidade: identidadeLocal(TRAVA_DB), ...p});
        assert.equal(conf2.resultado, 'CONFERIDO');
        caso('C_retomada_076_conclui', {etapas: r3.etapas.map(e => `${e.id}:${e.resultado}`), marcadorRenomeado: 'migration-076.tentativa-2.json',
          marcadorDestePacote: t2.marcadorDoLancamentoAnterior, conferirDepois: conf2.resultado});
      } finally { await c3.end(); await c4.end(); await trava.end(); }
    }

    // ---- D do revisor: categoria original BOMBONS excluída → CONFERIR acusa e APLICAR recusa ANTES de escrever ----
    {
      const c5 = await conectar(CATEGORIA_DB), c6 = await conectar(CATEGORIA_DB);
      try {
        const p = pastas('categoria');
        await excluirBombons(c5);
        const conf = await pacote.conferirNoCliente(c5, {sequencia, env: {}, identidade: identidadeLocal(CATEGORIA_DB), ...p});
        assert.equal(conf.resultado, 'RECUSARIA');
        const acusa = conf.verificacoes.find(v => /ANTECIPACAO_078 categorias originais 6\/7/.test(v.falha ?? ''));
        assert.ok(acusa, JSON.stringify(conf.verificacoes));
        assert.deepEqual(conf.situacao.categorias_originais_ausentes, ['BOMBONS']);
        const via = viaLancamentoComMarcador(lanc, lancPlano, c6, CATEGORIA_DB, p.dirLancamento);
        const r = await pacote.aplicarNoCliente(c5, {sequencia, backup: 'ensaio', identidade: identidadeLocal(CATEGORIA_DB), ...p, lancamento: via});
        assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /VERIFICACAO_PREVIA 078: ANTECIPACAO_078/); assert.equal(r.nenhumaEscrita, true);
        assert.equal(r.estadoDepois['074a'], 'AUSENTE');
        caso('D_bombons_excluida_detectada_antes_de_escrever', {conferir: conf.resultado, acusacao: acusa.falha, aplicar: r.falha.mensagem, estado074a: r.estadoDepois['074a']});
      } finally { await c5.end(); await c6.end(); }
    }

    // ---- RESULTADO (sem dados): modelos para as suítes e comparação com a referência ----
    {
      const r = await conectar(RESULTADO), r2 = await conectar(RESULTADO);
      const p = pastas('resultado');
      const via = viaLancamentoComMarcador(lanc, lancPlano, r2, RESULTADO, p.dirLancamento);
      try {
        const ate083 = sequencia.filter(e => !['085', '086'].includes(e.id));
        const a = await pacote.aplicarNoCliente(r, {sequencia: ate083, backup: 'ensaio', identidade: identidadeLocal(RESULTADO), ...p, lancamento: via});
        assert.equal(a.resultado, 'PASS', JSON.stringify(a.falha));
      } finally { await r.end(); await r2.end(); }
      await recriar(admin, MODELOS_SUITES['084'], RESULTADO);
      await recriar(admin, MODELOS_SUITES['083'], RESULTADO);
      const r3 = await conectar(RESULTADO);
      try {
        const b = await pacote.aplicarNoCliente(r3, {sequencia, backup: 'ensaio', identidade: identidadeLocal(RESULTADO), ...p, lancamento: async () => falhar('nada do lançamento deveria faltar')});
        assert.equal(b.resultado, 'PASS');
        relatorio.impressaoResultado = (await r3.query(pacote.SQL_IMPRESSAO)).rows[0];
        caso('resultado_sem_dados_por_partes', {etapas: b.etapas.map(e => `${e.id}:${e.resultado}`), impressao: relatorio.impressaoResultado});
      } finally { await r3.end(); }
      await recriar(admin, MODELOS_SUITES['086'], RESULTADO);
    }
    const [ip, ir] = [await impressao(RESULTADO), await impressao(REFERENCIA)];
    const dif = diferenca(ip, ir);
    const [op, or] = [await ordemColunas(RESULTADO), await ordemColunas(REFERENCIA)];
    const ordemDiferente = Object.keys(or).filter(t => op[t] !== or[t]).map(t => ({tabela: t, producao: op[t], referencia: or[t]}));
    {
      const cr = await conectar(REFERENCIA);
      try { relatorio.impressaoReferencia = (await cr.query(pacote.SQL_IMPRESSAO)).rows[0]; } finally { await cr.end(); }
    }
    relatorio.comparacao = {objetosProducao: ip.length, objetosReferencia: ir.length, ...dif, ordemFisicaDeColunasDiferente: ordemDiferente};
    assert.equal(dif.soNoPrimeiro.length + dif.soNoSegundo.length, 0, 'schema diverge da referência');
    assert.equal(relatorio.impressaoResultado.md5, relatorio.impressaoReferencia.md5);
    caso('comparacao_schema_vs_referencia_staging', {objetos: ip.length, soNaProducao: dif.soNoPrimeiro.length, soNaReferencia: dif.soNoSegundo.length,
      tabelasComOrdemDeColunasDiferente: ordemDiferente.map(x => x.tabela), md5Resultado: relatorio.impressaoResultado.md5, md5Referencia: relatorio.impressaoReferencia.md5});
    relatorio.resultado = relatorio.casos.every(x => x.resultado === 'PASS') ? 'PASS' : 'FALHA';
  } catch (erro) {
    relatorio.resultado = 'FALHA'; relatorio.erro = String(erro?.stack ?? erro).slice(0, 2000);
    console.error(relatorio.erro);
  } finally {
    await admin.end();
    console.log('relatório: ' + registrar('ensaio.json', relatorio));
  }
  if (relatorio.resultado !== 'PASS') process.exitCode = 1;
}

/** Dados mínimos plausíveis: clientes com CPF, adicional ligado a item do buffet, pacote com categoria do buffet. */
async function semearDados(c, kidmais) {
  await c.query(require('fs').readFileSync(path.join(__dirname, 'ensaio-migracoes-producao-20261019.dados.sql'), 'utf8').replaceAll(':kidmais', `'${kidmais}'::uuid`));
}
async function retrato(c) {
  const q = async s => (await c.query(s)).rows;
  return {
    resumo: (await q(`SELECT (SELECT count(*) FROM empresas)::int AS empresas, (SELECT count(*) FROM clientes)::int AS clientes,
      (SELECT count(*) FROM clientes WHERE cpf IS NOT NULL)::int AS clientes_cpf, (SELECT count(*) FROM bloqueios_agenda)::int AS bloqueios,
      (SELECT count(*) FROM buffet_categorias)::int AS categorias, (SELECT count(*) FROM buffet_itens)::int AS itens,
      (SELECT count(*) FROM adicionais)::int AS adicionais, (SELECT count(*) FROM pacotes)::int AS pacotes,
      (SELECT count(*) FROM pacote_buffet_categorias)::int AS pacote_categorias, (SELECT count(*) FROM empresa_assinaturas)::int AS assinaturas`))[0],
    catalogo: await q('SELECT id, codigo, nome, ativo FROM buffet_itens ORDER BY id'),
    categorias: await q('SELECT id, codigo, nome, ativo FROM buffet_categorias ORDER BY id'),
    clientes: await q("SELECT md5(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id)) AS h FROM clientes x"),
    bloqueios: await q("SELECT id, data, horario_inicio, horario_fim, ativo, empresa_id FROM bloqueios_agenda ORDER BY id"),
    vinculos: await q('SELECT pacote_id, categoria_id FROM pacote_buffet_categorias ORDER BY 1, 2'),
    adicionais: await q('SELECT id, origem_buffet_item_id, origem_buffet_categoria_id FROM adicionais ORDER BY id'),
  };
}
function verificarInvariantes(antes, depois, kidmais) {
  assert.deepEqual(depois.catalogo, antes.catalogo, 'catálogo do buffet (ids, códigos, nomes) preservado');
  assert.deepEqual(depois.categorias, antes.categorias, 'categorias preservadas');
  assert.deepEqual(depois.clientes, antes.clientes, 'clientes preservados');
  assert.deepEqual(depois.bloqueios, antes.bloqueios, 'bloqueios intactos (o pacote não faz o reparo)');
  assert.deepEqual(depois.vinculos, antes.vinculos, 'vínculos de pacote preservados (sem cópias: uma empresa só)');
  assert.deepEqual(depois.adicionais, antes.adicionais, 'adicionais preservados');
  assert.deepEqual({...depois.resumo}, {...antes.resumo}, 'contagens preservadas');
  void kidmais;
}
async function ensaiarReparo(c, kidmais) {
  const original = ler('database/repairs/20261011_lancamento_bloqueios_kidmais.sql');
  // Só os dois identificadores de destino são trocados; o arquivo de produção permanece intacto.
  const sql = original.replaceAll('kidmais_production', DADOS).replaceAll('7e990a2b-e64b-4630-9aae-4646fe936ede', kidmais);
  try { await assert.rejects(c.query(sql), /REPARO_NAO_AUTORIZADO/); } finally { await c.query('ROLLBACK'); }
  await c.query("SET kidmais.reparo_lancamento='cinco-bloqueios-kidmais-20261011'");
  try { await c.query(sql); } finally { await c.query('RESET kidmais.reparo_lancamento'); }
  const n = (await c.query('SELECT count(*)::int AS n FROM bloqueios_agenda WHERE empresa_id=$1 AND ativo', [kidmais])).rows[0].n;
  const g = (await c.query('SELECT count(*)::int AS n FROM bloqueios_agenda WHERE empresa_id IS NULL AND ativo AND data>=current_date')).rows[0].n;
  assert.equal(n, 5); assert.equal(g, 0);
  return {bloqueiosDaKidmais: n, globaisFuturos: g, observacao: 'reparo continua aplicável depois das migrations; NÃO faz parte do pacote'};
}

// ---------- suítes ----------
async function suites() {
  exigirAutorizacao(); exigirCaminhoReal(true);
  const receita = require('./regressao-v1-postgres-receita.cjs');
  const admin = await conectar('postgres');
  const resultados = [];
  try {
    for (const m of Object.values(MODELOS_SUITES)) assert.ok((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [m])).rowCount === 1, 'MODELO_AUSENTE ' + m);
    const somente = process.env.KIDMAIS_ENSAIO_SUITES ? process.env.KIDMAIS_ENSAIO_SUITES.split(',') : SUITES;
    for (const rel of somente) {
      const estado = estadoDaSuite(raiz, path.join(raiz, rel));
      for (const modelo of [estado.descartavel, ...(estado.tambem ?? [])]) {
        assert.ok(Object.hasOwn(MODELOS_SUITES, modelo), `modelo ${modelo} sem equivalente na ordem de produção (${rel})`);
        for (const banco of receita.TRABALHO) await receita.removerBanco(admin, banco);
        await receita.restaurar(admin, 'kidmais_pacotes_v1_descartavel', modelo);
        const inicio = Date.now();
        const log = path.join(RELATORIOS, `${carimbo()}-suite-${rel.replace(/[/.]/g, '_')}-${modelo}.log`);
        const saida = fs.createWriteStream(log);
        const filho = spawn(process.execPath, ['--experimental-strip-types', '--test', rel], {cwd: raiz,
          env: ambienteDaSuite(ambienteLimpo(), estado, PORTA, 'kidmais_pacotes_v1_descartavel'), windowsHide: true});
        filho.stdout.pipe(saida, {end: false}); filho.stderr.pipe(saida, {end: false});
        const codigo = await new Promise(resolve => filho.on('close', resolve));
        await new Promise(fim => saida.end(fim)); // o log precisa estar gravado antes da contagem
        const texto = fs.readFileSync(log, 'utf8');
        const pass = Number((/^(?:#|ℹ) pass (\d+)/m.exec(texto) || [])[1]), fail = Number((/^(?:#|ℹ) fail (\d+)/m.exec(texto) || [])[1]);
        const r = {suite: rel, modelo, codigo, pass, fail, segundos: Math.round((Date.now() - inicio) / 1000), log: path.basename(log)};
        resultados.push(r); console.log(JSON.stringify(r));
      }
    }
  } finally { await admin.end(); }
  const total = {resultado: resultados.every(r => r.codigo === 0) ? 'PASS' : 'FALHA', suites: resultados.length,
    testes: resultados.reduce((s, r) => s + (r.pass || 0), 0), falhas: resultados.reduce((s, r) => s + (r.fail || 0), 0), resultados};
  console.log('relatório: ' + registrar('suites.json', total));
  if (total.resultado !== 'PASS') process.exitCode = 1;
}

async function encerrar() {
  exigirAutorizacao(); exigirCaminhoReal(true);
  const dados = DIR + '\\dados';
  if (fs.existsSync(path.join(dados, 'postmaster.pid'))) {
    const c = await conectar('postgres'); await c.end();
    const r = bin('pg_ctl.exe', ['-D', dados, 'stop', '-m', 'fast', '-w']);
    if (r.status !== 0) falhar('pg_ctl stop falhou');
  }
  const st = bin('pg_ctl.exe', ['-D', dados, 'status']);
  if (st.status !== 3 || await escuta()) falhar('cluster não confirmou parada');
  const ev = {parado: true, pgCtlStatus: st.status, postmasterPid: fs.existsSync(path.join(dados, 'postmaster.pid'))};
  registrar('encerramento.json', ev); console.log(JSON.stringify(ev));
}
function semLinks(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), s = fs.lstatSync(p); if (s.isSymbolicLink()) falhar('link em ' + p); if (s.isDirectory()) semLinks(p); } }
async function limpar() {
  exigirAutorizacao(); exigirCaminhoReal(true);
  const dados = DIR + '\\dados';
  const conf = fs.readFileSync(path.join(dados, 'postgresql.conf'), 'utf8');
  if (!conf.includes(`cluster_name = '${PAPEL}'`) || !conf.includes(`port = ${PORTA}`)) falhar('postgresql.conf não é o do ensaio');
  if (fs.existsSync(path.join(dados, 'postmaster.pid')) || bin('pg_ctl.exe', ['-D', dados, 'status']).status !== 3 || await escuta()) falhar('cluster não está parado');
  semLinks(DIR);
  fs.rmSync(DIR, {recursive: true, force: false});
  const ev = {removido: DIR, existeDepois: fs.existsSync(DIR), relatorios: RELATORIOS, arquivos: fs.readdirSync(RELATORIOS).length};
  registrar('limpeza.json', ev); console.log(JSON.stringify(ev));
}

if (require.main === module) {
  const acoes = {preparar, ensaiar, suites, encerrar, limpar};
  const acao = acoes[process.argv[2]];
  if (!acao) { console.error('uso: preparar|ensaiar|suites|encerrar|limpar'); process.exitCode = 2; }
  else acao().catch(e => { console.error(String(e?.stack ?? e).slice(0, 1500)); process.exitCode = 1; });
}
