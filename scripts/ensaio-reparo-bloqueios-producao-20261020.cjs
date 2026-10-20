/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Ensaio LOCAL do reparo dos cinco bloqueios globais (executor de 20/10/2026) num cluster PostgreSQL 18 NOVO e DESCARTÁVEL,
 * com o schema de PRODUÇÃO DEPOIS das migrations de 20/10 (…074 sem 060/065, 079, 084 e o pacote 074a–086 aplicado pelo
 * próprio aplicador de 19/10). Nunca usa DATABASE_URL/PG*, as portas 5432/5433, o banco kidmais_manager nem host fora de
 * 127.0.0.1.
 *
 * O SQL do reparo roda BYTE A BYTE como será em produção: o banco de trabalho local se chama kidmais_production (só dentro
 * deste cluster, cluster_name kidmais_descartavel) e a empresa kidmais sintética nasce com o mesmo id de produção (o DEFAULT
 * de empresas.id é trocado só durante a 046 e restaurado em seguida; a impressão do schema é comparada com a do ensaio
 * aprovado de 19/10). O executor roda com o cliente local e a identidade local injetada (sem TLS/rede privada).
 *
 *   node scripts/ensaio-reparo-bloqueios-producao-20261020.cjs preparar   cria o cluster (pasta inexistente, porta livre)
 *   node scripts/ensaio-reparo-bloqueios-producao-20261020.cjs ensaiar    base pós-migrations + bloqueios sintéticos + cenários
 *   node scripts/ensaio-reparo-bloqueios-producao-20261020.cjs encerrar   para o cluster DESTE diretório e confirma
 *   node scripts/ensaio-reparo-bloqueios-producao-20261020.cjs limpar     remove o diretório do cluster (parado, sem links); relatórios ficam
 *
 * Exige KIDMAIS_ENSAIO_20261020_AUTORIZACAO="<diretório>|127.0.0.1:<porta>|kidmais_descartavel" (literal).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {randomBytes, randomUUID} = require('node:crypto');
const {variavelDeConexaoHerdada} = require('./regressao-v1-selecao.cjs');

const PAI = 'D:\\glass\\KidMais Manager\\ambientes-locais';
const DIR = PAI + '\\pg-descartavel-abertura-venda-20261020';
const RELATORIOS = DIR + '-relatorios';
const BIN = 'C:\\Program Files\\PostgreSQL\\18\\bin';
const HOST = '127.0.0.1';
const PORTA = 55811;
const PAPEL = 'kidmais_descartavel';
const AUTORIZACAO = `${DIR}|${HOST}:${PORTA}|${PAPEL}`;
const raiz = path.resolve(__dirname, '..');
const BASE = 'kidmais_ensaio_reparo_base';
/** Nome do banco de trabalho = o que o SQL revisado exige. Só existe dentro deste cluster descartável. */
const TRABALHO = 'kidmais_production';
const PROPRIOS = [BASE, TRABALHO];
/** Impressão do schema do ensaio APROVADO de 19/10 (resultado = referência de staging), para comparar a base. */
const IMPRESSAO_19_10 = {md5: 'c24d84c76365c73334a22d8ef96ef2a1', objetos: 6790};

const falhar = m => { throw new Error('ensaio recusado: ' + m); };
const carimbo = () => new Date().toISOString().replace(/[:.]/g, '-');
function registrar(nome, conteudo) {
  fs.mkdirSync(RELATORIOS, {recursive: true});
  const arquivo = path.join(RELATORIOS, `${carimbo()}-${nome}`);
  fs.writeFileSync(arquivo, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo, null, 2));
  return arquivo;
}
function ambienteLimpo() {
  const env = {...process.env};
  for (const k of Object.keys(env)) if (variavelDeConexaoHerdada(k) || /DATABASE_URL$/i.test(k)) delete env[k];
  return env;
}
function exigirAutorizacao() {
  if (process.env.KIDMAIS_ENSAIO_20261020_AUTORIZACAO !== AUTORIZACAO) falhar(`defina KIDMAIS_ENSAIO_20261020_AUTORIZACAO=${AUTORIZACAO}`);
  for (const k of Object.keys(process.env)) if (variavelDeConexaoHerdada(k) || /DATABASE_URL$/i.test(k)) delete process.env[k];
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
  const c = new pg.Client({host: HOST, port: PORTA, user: PAPEL, database: banco, application_name: 'kidmais-ensaio-reparo-20261020',
    password: () => Promise.reject(new Error('o servidor pediu senha; nenhuma credencial é carregada'))});
  await c.connect();
  const id = (await c.query(`SELECT current_setting('cluster_name') AS cluster, host(inet_server_addr()) AS addr, inet_server_port() AS port,
    current_user AS usuario, current_database() AS banco, current_setting('data_directory') AS dir, current_setting('server_version_num')::int AS versao,
    EXISTS (SELECT 1 FROM pg_database WHERE lower(datname) = 'kidmais_manager') AS tem_real`)).rows[0];
  if (id.cluster !== PAPEL || id.addr !== HOST || Number(id.port) !== PORTA || id.usuario !== PAPEL || id.banco !== banco || id.tem_real
    || String(id.dir).replace(/\//g, '\\').toLowerCase() !== (DIR + '\\dados').toLowerCase() || Math.floor(id.versao / 10000) !== 18) {
    await c.end(); falhar('identidade do cluster divergente');
  }
  c.on('error', () => undefined);
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
  fs.appendFileSync(path.join(dados, 'postgresql.conf'), `\n# cluster sintético do ensaio do reparo 20261020\nlisten_addresses = '${HOST}'\nport = ${PORTA}\ncluster_name = '${PAPEL}'\nlc_messages = 'C'\nmax_connections = 40\n`);
  fs.mkdirSync(RELATORIOS, {recursive: true});
  const s = bin('pg_ctl.exe', ['-D', dados, '-l', path.join(RELATORIOS, 'server.log'), '-w', '-t', '120', 'start'], {stdio: 'ignore'});
  if (s.status !== 0) falhar('pg_ctl start falhou');
  const c = await conectar('postgres'); await c.end();
  console.log(JSON.stringify({resultado: 'CLUSTER_PRONTO', porta: PORTA, dir: DIR}));
}

// ---------- montagem: produção pós-migrations ----------
const ler = rel => fs.readFileSync(path.join(raiz, rel), 'utf8');
async function inventario() {
  const inv = await import(pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href);
  return {arquivos: [...inv.approvedFiles], checks: inv.requiredChecks};
}
async function fixture046(c, arquivo046) {
  const email = (ler('database/migrations/' + arquivo046).match(/email_alvo text := '([^']+)'/) ?? [])[1];
  assert.ok(email, '046 sem e-mail');
  const b64 = n => randomBytes(n).toString('base64').replace(/=+$/, '');
  await c.query(`INSERT INTO usuarios_administrativos (email, nome, cargo, senha_hash, papel, ativo)
    VALUES (lower(btrim($1)), 'Representante Fixture Sintética', 'Fixture de teste', $2, 'REPRESENTANTE_AUTORIZADO', true)`,
  [email, `scrypt$v=1$N=131072$r=8$p=1$${b64(16)}==$${b64(64)}==`]);
}
async function aplicarInventario(c, arquivo, checks, kidmaisId) {
  const exigidos = checks(arquivo);
  const e046 = arquivo.split('_')[1] === '046';
  if (e046) await fixture046(c, arquivo);
  for (const x of exigidos.filter(n => n.includes('precheck'))) await c.query(ler('database/checks/' + x));
  let original = null;
  if (e046) {
    // Só para a kidmais sintética nascer com o id de produção: troca o DEFAULT durante a 046 e restaura o texto original.
    original = (await c.query("SELECT pg_get_expr(d.adbin, d.adrelid) AS e FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'public.empresas'::regclass AND a.attname = 'id'")).rows[0].e;
    await c.query(`ALTER TABLE public.empresas ALTER COLUMN id SET DEFAULT '${kidmaisId}'::uuid`);
  }
  try { await c.query(ler('database/migrations/' + arquivo)); }
  finally { if (e046) await c.query(`ALTER TABLE public.empresas ALTER COLUMN id SET DEFAULT ${original}`); }
  for (const x of exigidos.filter(n => !n.includes('precheck'))) await c.query(ler('database/checks/' + x));
}
async function recriar(admin, banco, template = 'template0') {
  assert.ok(PROPRIOS.includes(banco), 'BANCO_FORA_DA_LISTA ' + banco);
  assert.ok(template === 'template0' || PROPRIOS.includes(template));
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [banco]);
  await admin.query(`DROP DATABASE IF EXISTS ${banco}`);
  await admin.query(`CREATE DATABASE ${banco} TEMPLATE ${template}`);
}
/** Processo do lançamento com o mesmo marcador do main dele (como no ensaio de 19/10). */
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
const BLOQUEIOS_KIDMAIS_PROPRIOS = [['2026-12-05', '09:00', '12:00'], ['2027-01-10', '17:00', '21:00']];
async function montarBase(admin, marcadores, reparo, pacote) {
  const {arquivos, checks} = await inventario();
  const fim = arquivos.findIndex(a => a.split('_')[1] === '074');
  const ordem = [...arquivos.slice(0, fim + 1).filter(a => !['060', '065'].includes(a.split('_')[1])),
    arquivos.find(a => a.split('_')[1] === '079'), arquivos.find(a => a.split('_')[1] === '084')];
  await recriar(admin, BASE);
  const c = await conectar(BASE), c2 = await conectar(BASE);
  try {
    for (const a of ordem) await aplicarInventario(c, a, checks, reparo.KIDMAIS_ID);
    const k = (await c.query("SELECT id FROM empresas WHERE codigo = 'kidmais'")).rows;
    assert.deepEqual(k.map(x => x.id), [reparo.KIDMAIS_ID], 'kidmais sintética com o id de produção');
    // Estado de produção ANTES de 20/10: cinco bloqueios globais e dados mínimos (os mesmos do ensaio de 19/10).
    for (const a of reparo.ALVOS) await c.query("INSERT INTO bloqueios_agenda(id,data,horario_inicio,horario_fim,motivo) VALUES($1,$2,'17:00','21:00','Bloqueio sintetico do ensaio')", [a.id, a.data]);
    await c.query(ler('scripts/ensaio-migracoes-producao-20261019.dados.sql').replaceAll(':kidmais', `'${reparo.KIDMAIS_ID}'::uuid`));
    // Migrations de 20/10: o pacote de 19/10 pelo próprio aplicador (074a–078 pelo aplicador do lançamento).
    const lanc = require('./migrations-lancamento-production.cjs');
    const {sequencia} = pacote.carregar(raiz);
    const via = viaLancamentoComMarcador(lanc, lanc.carregar(raiz), c2, BASE, path.join(marcadores, 'lancamento'));
    const identidade = id => { assert.equal(id.db, BASE); assert.equal(Number(id.pg_major), 18); pacote.exigirSearchPath(id); return {banco: id.db, local: true}; };
    const ap = await pacote.aplicarNoCliente(c, {sequencia, backup: 'ensaio', identidade, dir: path.join(marcadores, 'pacote'), dirLancamento: path.join(marcadores, 'lancamento'), lancamento: via});
    assert.equal(ap.resultado, 'PASS', JSON.stringify(ap.falha));
    const estado = (await pacote.lerTudo(c)).estado;
    assert.ok(Object.values(estado).every(x => x === 'COMPLETA'), JSON.stringify(estado));
    const impressao = (await c.query(pacote.SQL_IMPRESSAO)).rows[0];
    // Dados que a produção pode ter e o reparo não pode tocar: bloqueios próprios da Kidmais e um global INATIVO futuro.
    for (const [d, i, f] of BLOQUEIOS_KIDMAIS_PROPRIOS)
      await c.query('INSERT INTO bloqueios_agenda(data,horario_inicio,horario_fim,motivo,empresa_id) VALUES($1,$2,$3,$4,$5)', [d, i, f, 'Bloqueio sintetico da Kidmais', reparo.KIDMAIS_ID]);
    await c.query("INSERT INTO bloqueios_agenda(data,horario_inicio,horario_fim,motivo,ativo) VALUES('2026-12-24','17:00','21:00','Global sintetico inativo',false)");
    return {migrations: ordem.length + ap.etapas.length, etapasDoPacote: ap.etapas.map(e => `${e.id}:${e.resultado}`), impressao};
  } finally { await c.end(); await c2.end(); }
}

// ---------- leituras de evidência ----------
async function retrato(c) {
  const q = async s => (await c.query(s)).rows;
  return {
    bloqueios: await q('SELECT id, data::text, horario_inicio::text, horario_fim::text, dia_inteiro, ativo, motivo, empresa_id, estabelecimento_id FROM bloqueios_agenda ORDER BY id'),
    resolucoes: await q('SELECT bloqueio_id, empresa_id, estabelecimento_id, decidido_por, motivo FROM agenda_062_bloqueios_resolucao ORDER BY bloqueio_id'),
    outras: (await q(`SELECT (SELECT count(*) FROM empresas)::int AS empresas, (SELECT count(*) FROM clientes)::int AS clientes,
      (SELECT count(*) FROM fechamentos)::int AS fechamentos, (SELECT count(*) FROM configuracao_agenda)::int AS turnos,
      (SELECT count(*) FROM empresa_assinaturas)::int AS assinaturas, (SELECT count(*) FROM buffet_itens)::int AS buffet_itens`))[0],
  };
}
/** Efeito na agenda: alcance de cada bloqueio para a Kidmais (inteira e numa unidade qualquer) e para uma empresa nova. */
async function alcance(c, reparo, outra) {
  return (await c.query(`SELECT
      count(*) FILTER (WHERE kidmais062_bloqueio_aplica(empresa_id, estabelecimento_id, $1::uuid, NULL))::int AS valem_para_kidmais,
      count(*) FILTER (WHERE kidmais062_bloqueio_aplica(empresa_id, estabelecimento_id, $1::uuid, $3::uuid))::int AS valem_para_unidade_da_kidmais,
      count(*) FILTER (WHERE kidmais062_bloqueio_aplica(empresa_id, estabelecimento_id, $2::uuid, NULL))::int AS valem_para_empresa_nova,
      count(*) FILTER (WHERE id = ANY($4::uuid[]) AND kidmais062_bloqueio_aplica(empresa_id, estabelecimento_id, $2::uuid, NULL))::int AS alvos_valem_para_empresa_nova,
      (SELECT count(*) FROM bloqueios_agenda WHERE empresa_id IS NULL AND ativo AND data >= current_date)::int AS guarda_do_cadastro_publico
    FROM bloqueios_agenda WHERE ativo`, [reparo.KIDMAIS_ID, outra, randomUUID(), reparo.ALVOS.map(a => a.id)])).rows[0];
}
const semMudanca = (a, b, msg) => assert.deepEqual(b, a, msg);

// ---------- ensaio ----------
async function ensaiar() {
  exigirAutorizacao(); exigirCaminhoReal(true);
  const reparo = require('./reparo-bloqueios-producao-20261020.cjs');
  const pacote = require('./migrations-producao-20261019.cjs');
  const sql = reparo.lerSql(raiz);
  const relatorio = {inicio: new Date().toISOString(), porta: PORTA, sqlSha256: reparo.SQL_SHA256, casos: []};
  const caso = (nome, x = {}) => { const r = {caso: nome, ...x, resultado: 'PASS'}; relatorio.casos.push(r); console.log(JSON.stringify(r).slice(0, 600)); return r; };
  const marcadores = path.join(RELATORIOS, 'marcadores-' + carimbo());
  const pastas = nome => ({dir: path.join(marcadores, nome, 'reparo-bloqueios-producao-20261020'), dirLancamento: path.join(marcadores, nome, 'lancamento-venda-20261011')});
  const identidade = id => { assert.equal(id.db, TRABALHO, 'BANCO_DIVERGENTE'); assert.equal(Number(id.pg_major), 18); return {banco: id.db, local: true, tls: id.tls}; };
  const admin = await conectar('postgres');
  const outra = randomUUID();
  /** Banco de trabalho novo a partir da base (um por cenário). */
  const novo = async () => { await recriar(admin, TRABALHO, BASE); return conectar(TRABALHO); };
  try {
    const base = await montarBase(admin, path.join(marcadores, 'montagem'), reparo, pacote);
    assert.deepEqual(base.impressao, IMPRESSAO_19_10, 'schema pós-migrations igual ao do ensaio aprovado de 19/10');
    caso('base_producao_pos_migrations', base);

    // ---- 1. Caminho principal: CONFERIR → (SQL sem autorização) → APLICAR → CONFERIR → repetições ----
    {
      const c = await novo(), p = pastas('principal');
      try {
        const antes = await retrato(c), alcanceAntes = await alcance(c, reparo, outra);
        const conf = await reparo.conferirNoCliente(c, {env: {}, identidade, ...p});
        assert.equal(conf.resultado, 'CONFERIDO', JSON.stringify(conf.motivos));
        assert.deepEqual(conf.alvos.map(a => a.estado), Array(5).fill('INTACTO'));
        assert.equal(conf.agregados.globais_ativos, 5); assert.equal(conf.agregados.globais_futuros, 4);
        assert.equal(conf.agregados.globais_futuros_fora_do_alvo, 0);
        assert.deepEqual([...conf.schema.gatilhos].sort(), [...reparo.GATILHOS_ESPERADOS].sort(), 'gatilhos pós-migrations = os de 062/014');
        semMudanca(antes, await retrato(c), 'CONFERIR não grava');
        assert.equal(fs.existsSync(p.dir), false, 'CONFERIR não cria marcador');
        caso('conferir_antes', {conferir: conf.resultado, alvos: conf.alvos, agregados: conf.agregados, gatilhos: conf.schema.gatilhos, alcanceAntes});

        await assert.rejects(c.query(sql), /REPARO_NAO_AUTORIZADO/);
        await c.query('ROLLBACK');
        semMudanca(antes, await retrato(c), 'SQL sem autorização de sessão não grava');
        caso('sql_sem_autorizacao_de_sessao_recusado');

        const ap = await reparo.aplicarNoCliente(c, {sql, identidade, ...p});
        assert.equal(ap.resultado, 'PASS', JSON.stringify(ap).slice(0, 800));
        const depois = await retrato(c), alcanceDepois = await alcance(c, reparo, outra);
        const ids = new Set(reparo.ALVOS.map(a => a.id));
        for (const x of depois.bloqueios) {
          const y = antes.bloqueios.find(b => b.id === x.id);
          if (ids.has(x.id)) {
            assert.equal(x.empresa_id, reparo.KIDMAIS_ID); assert.equal(x.estabelecimento_id, null);
            assert.deepEqual({...x, empresa_id: null}, y, 'só empresa_id muda nos cinco');
          } else assert.deepEqual(x, y, 'demais bloqueios intactos');
        }
        assert.equal(depois.bloqueios.length, antes.bloqueios.length);
        assert.equal(depois.resolucoes.length, 5);
        assert.ok(depois.resolucoes.every(r => ids.has(r.bloqueio_id) && r.empresa_id === reparo.KIDMAIS_ID && r.estabelecimento_id === null && r.decidido_por === 'Felipe'));
        semMudanca(antes.outras, depois.outras, 'nenhuma outra tabela muda');
        assert.equal(alcanceDepois.valem_para_kidmais, alcanceAntes.valem_para_kidmais, 'a Kidmais continua bloqueada nos mesmos horários');
        assert.equal(alcanceDepois.valem_para_unidade_da_kidmais, alcanceAntes.valem_para_unidade_da_kidmais);
        assert.equal(alcanceAntes.alvos_valem_para_empresa_nova, 5); assert.equal(alcanceDepois.alvos_valem_para_empresa_nova, 0);
        assert.equal(alcanceAntes.guarda_do_cadastro_publico, 4); assert.equal(alcanceDepois.guarda_do_cadastro_publico, 0);
        const mk = JSON.parse(fs.readFileSync(path.join(p.dir, 'reparo.json'), 'utf8'));
        assert.equal(mk.situacao, 'COMMIT_CONFIRMADO');
        caso('aplicar_pass', {antes: ap.antes.agregados, depois: ap.depois.agregados, alvosDepois: ap.depois.alvos, marcador: mk.situacao, alcanceAntes, alcanceDepois,
          motivoRegistrado: depois.resolucoes[0].motivo});

        const conf2 = await reparo.conferirNoCliente(c, {env: {}, identidade, ...p});
        assert.equal(conf2.resultado, 'REPARO_JA_APLICADO');
        caso('conferir_depois', {conferir: conf2.resultado, alvos: conf2.alvos.map(a => a.estado)});

        const r1 = await reparo.aplicarNoCliente(c, {sql, identidade, ...p});
        assert.equal(r1.resultado, 'FALHA'); assert.match(r1.falha, /ESTADO_NAO_APTO JA_APLICADO/); assert.equal(r1.gravado, true, 'estado já reparado (de antes)');
        const p2 = pastas('principal-sem-marcador');
        const r2 = await reparo.aplicarNoCliente(c, {sql, identidade, ...p2});
        assert.match(r2.falha, /ESTADO_NAO_APTO JA_APLICADO/); assert.equal(fs.existsSync(p2.dir), false);
        const r3 = await reparo.aplicarNoCliente(c, {sql, retomar: true, identidade, ...p});
        assert.match(r3.falha, /ESTADO_NAO_APTO JA_APLICADO/);
        await c.query(`SET kidmais.reparo_lancamento = '${reparo.AUTORIZACAO}'`);
        await assert.rejects(c.query(sql), /BLOQUEIOS_DIVERGENTES_OU_REPARO_JA_INICIADO/);
        await c.query('ROLLBACK'); await c.query('RESET kidmais.reparo_lancamento');
        semMudanca(depois, await retrato(c), 'repetições não gravam nada');
        caso('repeticao_recusada_sem_gravar', {executor: r1.falha, semMarcador: r2.falha, retomar: r3.falha, sqlDireto: 'BLOQUEIOS_DIVERGENTES_OU_REPARO_JA_INICIADO'});
      } finally { await c.end(); }
    }

    // ---- 2. Global futuro fora dos cinco: a conferência antecipa a mesma recusa do SQL ----
    {
      const c = await novo(), p = pastas('fora-do-alvo');
      try {
        await c.query("INSERT INTO bloqueios_agenda(data,horario_inicio,horario_fim,motivo) VALUES('2026-12-31','17:00','21:00','Global sintetico novo')");
        const antes = await retrato(c);
        const conf = await reparo.conferirNoCliente(c, {env: {}, identidade, ...p});
        assert.equal(conf.resultado, 'RECUSARIA'); assert.match(conf.motivos.join(' '), /CONJUNTO_GLOBAL_DIVERGENTE fora_do_alvo=1/);
        const ap = await reparo.aplicarNoCliente(c, {sql, identidade, ...p});
        assert.equal(ap.resultado, 'FALHA'); assert.equal(ap.gravado, false); assert.equal(fs.existsSync(p.dir), false, 'recusa antes do marcador');
        await c.query(`SET kidmais.reparo_lancamento = '${reparo.AUTORIZACAO}'`);
        await assert.rejects(c.query(sql), /CONJUNTO_GLOBAL_DIVERGENTE/);
        await c.query('ROLLBACK'); await c.query('RESET kidmais.reparo_lancamento');
        semMudanca(antes, await retrato(c));
        caso('global_fora_do_alvo_recusado_antes_de_escrever', {conferir: conf.motivos, aplicar: ap.falha, sqlDireto: 'CONJUNTO_GLOBAL_DIVERGENTE'});
      } finally { await c.end(); }
    }

    // ---- 3. Falha injetada: transação aberta na agenda → lock_timeout; nada gravado; repetição recusada; retomada conclui ----
    {
      const c = await novo(), trava = await conectar(TRABALHO), p = pastas('lock-timeout');
      try {
        const antes = await retrato(c);
        await trava.query('BEGIN');
        await trava.query('UPDATE bloqueios_agenda SET motivo = motivo WHERE id = $1', [reparo.ALVOS[1].id]);
        const t0 = Date.now();
        const ap = await reparo.aplicarNoCliente(c, {sql, identidade, ...p});
        const segundos = Math.round((Date.now() - t0) / 100) / 10;
        await trava.query('ROLLBACK');
        assert.equal(ap.resultado, 'FALHA'); assert.match(ap.falha, /lock timeout/); assert.equal(ap.gravado, false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, 'reparo.json'), 'utf8')).situacao, 'FALHA_NADA_GRAVADO');
        semMudanca(antes, await retrato(c), 'falha atômica');
        const conf = await reparo.conferirNoCliente(c, {env: {}, identidade, ...p});
        assert.equal(conf.resultado, 'RECUSARIA'); assert.match(conf.motivos.join(' '), /MARCADOR_ANTERIOR/);
        const r2 = await reparo.aplicarNoCliente(c, {sql, identidade, ...p});
        assert.match(r2.falha, /TENTATIVA_ANTERIOR_REVISAR reparo\.json/); semMudanca(antes, await retrato(c));
        const r3 = await reparo.aplicarNoCliente(c, {sql, retomar: true, identidade, ...p});
        assert.equal(r3.resultado, 'PASS', JSON.stringify(r3).slice(0, 600));
        assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, 'reparo.tentativa-2.json'), 'utf8')).situacao, 'COMMIT_CONFIRMADO');
        const r4 = await reparo.aplicarNoCliente(c, {sql, retomar: true, identidade, ...p});
        assert.match(r4.falha, /ESTADO_NAO_APTO JA_APLICADO/);
        caso('falha_injetada_lock_timeout_e_retomada', {segundos, falha: ap.falha, marcador: 'FALHA_NADA_GRAVADO', conferir: conf.resultado, repeticao: r2.falha,
          retomada: r3.resultado, retomadaDepois: r4.falha});
      } finally { await trava.end().catch(() => {}); await c.end(); }
    }

    // ---- 4. Falha injetada no MEIO da transação (depois do INSERT das resoluções): rollback integral ----
    {
      const c = await novo(), p = pastas('meio-da-transacao');
      try {
        await c.query('ALTER TABLE bloqueios_agenda ADD CONSTRAINT ensaio_falha_injetada CHECK (empresa_id IS NULL) NOT VALID');
        const antes = await retrato(c);
        const ap = await reparo.aplicarNoCliente(c, {sql, identidade, ...p});
        assert.equal(ap.resultado, 'FALHA'); assert.match(ap.falha, /ensaio_falha_injetada/); assert.equal(ap.gravado, false);
        semMudanca(antes, await retrato(c), 'resoluções e bloqueios desfeitos juntos');
        assert.equal((await c.query("SELECT current_setting('kidmais.reparo_lancamento', true) AS v")).rows[0].v, '', 'autorização de sessão desfeita');
        await c.query('ALTER TABLE bloqueios_agenda DROP CONSTRAINT ensaio_falha_injetada');
        const r = await reparo.aplicarNoCliente(c, {sql, retomar: true, identidade, ...p});
        assert.equal(r.resultado, 'PASS');
        caso('falha_injetada_no_meio_rollback_integral_e_retomada', {falha: ap.falha, situacaoDepois: ap.situacaoDepois.resultado, retomada: r.resultado});
      } finally { await c.end(); }
    }

    // ---- 5. Gatilho inesperado e papel sem privilégio: recusados antes de qualquer escrita ----
    {
      const c = await novo(), p = pastas('gatilho-privilegio');
      try {
        await c.query("CREATE FUNCTION ensaio_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
        await c.query('CREATE TRIGGER ensaio_inesperado_trg BEFORE UPDATE ON bloqueios_agenda FOR EACH ROW EXECUTE FUNCTION ensaio_trg()');
        const conf = await reparo.conferirNoCliente(c, {env: {}, identidade, ...p});
        assert.equal(conf.resultado, 'RECUSARIA'); assert.match(conf.motivos.join(' '), /GATILHOS_DIVERGENTES/);
        const ap = await reparo.aplicarNoCliente(c, {sql, identidade, ...p});
        assert.match(ap.falha, /GATILHOS_DIVERGENTES/); assert.equal(fs.existsSync(p.dir), false);
        await c.query('DROP TRIGGER ensaio_inesperado_trg ON bloqueios_agenda'); await c.query('DROP FUNCTION ensaio_trg()');
        await c.query('DROP ROLE IF EXISTS kidmais_ensaio_sem_privilegio'); await c.query('CREATE ROLE kidmais_ensaio_sem_privilegio NOLOGIN');
        await c.query('GRANT USAGE ON SCHEMA public TO kidmais_ensaio_sem_privilegio');
        await c.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO kidmais_ensaio_sem_privilegio');
        await c.query('SET ROLE kidmais_ensaio_sem_privilegio');
        const sp = await reparo.conferirNoCliente(c, {env: {}, identidade, ...p});
        await c.query('RESET ROLE');
        assert.equal(sp.resultado, 'RECUSARIA'); assert.match(sp.motivos.join(' '), /SEM_PRIVILEGIO bloqueios/); assert.equal(sp.schema.papel_trocado, true);
        await c.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kidmais_ensaio_sem_privilegio');
        await c.query('REVOKE USAGE ON SCHEMA public FROM kidmais_ensaio_sem_privilegio'); await c.query('DROP ROLE kidmais_ensaio_sem_privilegio');
        const ok = await reparo.conferirNoCliente(c, {env: {CADASTRO_PUBLICO_ATIVO: 'true'}, identidade, ...p});
        assert.equal(ok.resultado, 'RECUSARIA'); assert.match(ok.motivos.join(' '), /FLAG_LIGADA CADASTRO_PUBLICO_ATIVO/);
        caso('gatilho_privilegio_flag_recusados', {gatilho: conf.motivos, privilegio: sp.motivos, flag: ok.motivos});
      } finally { await c.end(); }
    }
    relatorio.resultado = relatorio.casos.every(x => x.resultado === 'PASS') ? 'PASS' : 'FALHA';
  } catch (erro) {
    relatorio.resultado = 'FALHA'; relatorio.erro = String(erro?.stack ?? erro).slice(0, 2000);
    console.error(relatorio.erro);
  } finally {
    try { await admin.query(`DROP DATABASE IF EXISTS ${TRABALHO} WITH (FORCE)`); relatorio.bancoDeTrabalhoRemovido = true; } catch { relatorio.bancoDeTrabalhoRemovido = false; }
    await admin.end();
    console.log('relatório: ' + registrar('ensaio.json', relatorio));
  }
  if (relatorio.resultado !== 'PASS') process.exitCode = 1;
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
  const acoes = {preparar, ensaiar, encerrar, limpar};
  const acao = acoes[process.argv[2]];
  if (!acao) { console.error('uso: preparar|ensaiar|encerrar|limpar'); process.exitCode = 2; }
  else acao().catch(e => { console.error(String(e?.stack ?? e).slice(0, 1500)); process.exitCode = 1; });
}
module.exports = {AUTORIZACAO, PORTA, DIR, RELATORIOS, TRABALHO, BASE, IMPRESSAO_19_10};
