/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 112 (cliente pessoa jurídica, Entrega B do plano "importação de contrato com dados
// completos", rev. 2.1) — staging (scripts/migration-112-staging.cjs fixa o alvo, a identidade da conexão e o disco). Mesmo
// desenho do aplicador da 109 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador exclusivo no disco
// persistente, códigos 0/1/2/3), para UMA migration que ACRESCENTA estrutura a uma tabela com dados:
//   - a 112 acrescenta a public.clientes 6 colunas (DEFAULT constante: só catálogo, sem reescrever a tabela), 7 CHECKs, o
//     índice único de CNPJ por empresa, 3 funções e 2 gatilhos (um em clientes, um em mesclagens_clientes), sob ACCESS
//     EXCLUSIVE de clientes com lock_timeout 5 s e statement_timeout 60 s (os dois do próprio SQL, SET LOCAL); leituras e
//     escritas de clientes esperam a transação (curta). Nenhuma linha é atualizada;
//   - compatibilidade: o código anterior continua funcionando com a 112 (as linhas novas nascem PF pelo DEFAULT; nenhuma
//     consulta antiga lê as colunas novas) e o código da Entrega B funciona sem ela (PJ recusada com PJ_INDISPONIVEL /
//     MIGRACAO_PENDENTE, detectada a cada transação, sem cache). Por isso não há corte de consumidores nem sessão a drenar;
//     a ordem do cabeçalho da 112 (código antes) vale para a PJ aparecer só quando o banco estiver pronto;
//   - estado só pelo catálogo: os 19 objetos da 112 (6 colunas, 7 CHECKs, 1 índice, 3 funções, 2 gatilhos). Nenhum =
//     ausente; todos = presente (o postcheck decide entre completa e divergente); qualquer outro número = PARCIAL (recusa);
//   - aplicação: precheck (READ ONLY) → migration SEM o COMMIT final → na MESMA transação: prova de preservação (nenhuma
//     linha de clientes nem de mesclagens_clientes escrita por esta transação: xmin diferente do xid dela) e o postcheck →
//     COMMIT só com tudo PASS → postcheck de novo (READ ONLY);
//   - situação do COMMIT: falha no corpo ou nas verificações = NAO_COMMITADA (o COMMIT nunca foi enviado); falha NO COMMIT =
//     DESFEITA_PELO_SERVIDOR com SQLSTATE fora de 08/57/58/XX e diferente de 40003, senão INDETERMINADO (reconciliar pela
//     conferência); COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - toda leitura: BEGIN TRANSACTION READ ONLY, lock_timeout 5s e search_path = public, pg_catalog; a conferência não grava
//     no banco nem no disco.
// Nunca executa o down. Rollback (manual, autorização própria): só SEM nenhum dado de PJ (o down recusa); depois da primeira
// PJ, só correção para frente.
// Saída só com nomes de etapas, booleanos, a versão do servidor, contagens (por status e por tipo) e nomes de divergências.
// Privilégios, avaliados como current_user (no Render a credencial entra com `SET role`):
//   sempre: USAGE em public e SELECT em clientes (contagens);
//   112 ausente: DONO de clientes (ALTER TABLE, índice, gatilho) e de mesclagens_clientes (gatilho), CREATE em public
//                (3 funções) e USAGE em plpgsql (funções e blocos DO do precheck/postcheck).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const FLAG_CONFERIR = '--conferir-112';
const FLAG_APLICAR = '--aplicar-112-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-112.json';
const ETAPAS = Object.freeze([
  ['precheck 112', 'database/checks/20261101_112_precheck.sql', '0020a57bea747de911f16186276e2a7e4d363513ceb265a7145516ed0498bdde'],
  ['migration 112', 'database/migrations/20261101_112_clientes_pessoa_juridica.sql', '8c80940613ebe00050c185ca7e323419ae9a49f379a6ff09c26e28f112e2a5e3'],
  ['postcheck 112', 'database/checks/20261101_112_postcheck.sql', 'eda573af1acea80ffe1343c0948af857350899f544545a770699773b93927a57'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);

/** Os 19 objetos da 112, por grupo (o estado conta cada grupo pelo catálogo). */
const OBJETOS = Object.freeze({
  colunas: Object.freeze(['tipo_pessoa', 'cnpj', 'razao_social', 'nome_fantasia', 'representante_nome', 'representante_cpf']),
  restricoes: Object.freeze(['clientes_112_tipo_pessoa_check', 'clientes_112_cnpj_formato', 'clientes_112_representante_cpf_formato',
    'clientes_112_textos_nao_vazios', 'clientes_112_pf_sem_campos_pj', 'clientes_112_pj_identidade', 'clientes_112_representante_nome']),
  indices: Object.freeze(['clientes_cnpj_empresa_canonico_uk']),
  funcoes: Object.freeze(['kidmais_112_cpf_valido(text)', 'kidmais_112_cnpj_valido(text)', 'kidmais_112_mesclagem_mesmo_tipo()']),
  gatilhos: Object.freeze(['clientes_112_mesclagem_mesmo_tipo', 'mesclagens_clientes_112_mesmo_tipo']),
});
const TOTAL_OBJETOS = Object.values(OBJETOS).reduce((t, x) => t + x.length, 0);
const lista = xs => xs.map(x => `'${x}'`).join(',');
const CLI = "to_regclass('public.clientes')";
const MESC = "to_regclass('public.mesclagens_clientes')";
const dono = rel => `coalesce((SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = ${rel}), false)`;

/** Estado (somente catálogo e privilégios, sem ler nenhuma tabela de dados). */
const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (${CLI} IS NOT NULL) AS clientes,
  (${MESC} IS NOT NULL) AS mesclagens,
  (SELECT count(*) FROM pg_attribute WHERE attrelid = ${CLI} AND NOT attisdropped AND attname IN (${lista(OBJETOS.colunas)}))::int AS colunas,
  (SELECT count(*) FROM pg_constraint WHERE conrelid = ${CLI} AND conname IN (${lista(OBJETOS.restricoes)}))::int AS restricoes,
  (SELECT count(*) FROM unnest(ARRAY[${lista(OBJETOS.indices)}]) i WHERE to_regclass('public.' || i) IS NOT NULL)::int AS indices,
  (SELECT count(*) FROM unnest(ARRAY[${lista(OBJETOS.funcoes)}]) f WHERE to_regprocedure('public.' || f) IS NOT NULL)::int AS funcoes,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (${lista(OBJETOS.gatilhos)}))::int AS gatilhos,
  ${dono(CLI)} AS dono_clientes,
  ${dono(MESC)} AS dono_mesclagens,
  coalesce((SELECT has_table_privilege(current_user, oid, 'SELECT') FROM pg_class WHERE oid = ${CLI}), false) AS ler_clientes,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  coalesce(has_language_privilege(current_user, 'plpgsql', 'USAGE'), false) AS plpgsql,
  (session_user <> current_user) AS papel_trocado`;
const BOOLEANOS = Object.freeze(['clientes', 'mesclagens', 'dono_clientes', 'dono_mesclagens', 'ler_clientes', 'usar_public', 'pode_criar', 'plpgsql', 'papel_trocado']);
const GRUPOS = Object.freeze(Object.keys(OBJETOS));
/**
 * Prova de preservação, DENTRO da transação da migration, sob a trava: nenhuma linha de clientes nem de mesclagens_clientes
 * tem xmin igual ao xid desta transação (ADD COLUMN com DEFAULT constante não reescreve; a 112 não atualiza linha).
 */
const SQL_PRESERVACAO = `/* preservacao-112 */ SELECT
  (SELECT count(*) FROM public.clientes WHERE xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text)::int AS clientes_escritos,
  (SELECT count(*) FROM public.mesclagens_clientes WHERE xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text)::int AS mesclagens_escritas`;
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);

/** Estado lido: ausente (0 objetos) | presente (19; o postcheck decide) | parcial (qualquer outro). */
function lerEstado(e) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  for (const k of ['versao_pg', ...GRUPOS]) assert.ok(Number.isInteger(e?.[k]) && e[k] >= 0, 'ESTADO_ILEGIVEL ' + k);
  for (const k of GRUPOS) assert.ok(e[k] <= OBJETOS[k].length, 'ESTADO_ILEGIVEL ' + k);
  const s = Object.fromEntries(BOOLEANOS.map(k => [k, e[k]]));
  s.versao_pg = e.versao_pg;
  s.objetos = GRUPOS.reduce((t, k) => t + e[k], 0);
  s.m112 = s.objetos === 0 ? 'ausente' : s.objetos === TOTAL_OBJETOS ? 'presente' : 'parcial';
  if (s.m112 === 'parcial') s.divergencias = GRUPOS.filter(k => e[k] !== OBJETOS[k].length).map(k => `${k} ${e[k]}/${OBJETOS[k].length}`);
  return s;
}

/** Guardas antes de qualquer leitura de dados: tabelas, aplicação parcial e privilégios de cada caso. */
function exigirCatalogo(s) {
  assert.ok(s.clientes, 'TABELA_AUSENTE clientes');
  assert.ok(s.mesclagens, 'TABELA_AUSENTE mesclagens_clientes');
  assert.notEqual(s.m112, 'parcial', 'APLICACAO_PARCIAL_112 ' + (s.divergencias ?? []).join(', '));
  const leitura = [!s.usar_public && 'USAGE_PUBLIC', !s.ler_clientes && 'SELECT_CLIENTES'].filter(Boolean);
  assert.ok(leitura.length === 0, 'SEM_PRIVILEGIO_LEITURA ' + leitura.join(' '));
  if (s.m112 === 'ausente') {
    const falta = [!s.dono_clientes && 'DONO_CLIENTES', !s.dono_mesclagens && 'DONO_MESCLAGENS', !s.pode_criar && 'CREATE', !s.plpgsql && 'LINGUAGEM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_112 ' + falta.join(' '));
  }
}

/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  exigirCatalogo(s);
  return s.m112 === 'presente' ? ['postcheck 112'] : ['precheck 112', 'migration 112', 'postcheck 112'];
}

/** Situação do COMMIT quando o PRÓPRIO COMMIT falha (mesma regra da 109, com 40003 indeterminado). */
function commitNaFalha(e) {
  const sqlstate = typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  return sqlstate && !/^(08|57|58|XX)/.test(sqlstate) && sqlstate !== '40003' ? 'DESFEITA_PELO_SERVIDOR' : 'INDETERMINADO';
}
/** O arquivo revisado sem o COMMIT final: uma única transação (um BEGIN, um COMMIT), terminando exatamente em COMMIT. */
function semCommitFinal(sql, nome) {
  assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.ok(sql.endsWith('\nCOMMIT;\n'), 'TRANSACAO_INESPERADA ' + nome);
  return sql.slice(0, -'COMMIT;\n'.length);
}
/** Precheck e postcheck têm a própria moldura (BEGIN TRANSACTION READ ONLY … ROLLBACK); o aplicador envia só o CORPO. */
function corpoSomenteLeitura(sql, nome) {
  assert.equal((sql.match(/^BEGIN TRANSACTION READ ONLY;$/gm) ?? []).length, 1, 'MOLDURA_INESPERADA ' + nome);
  assert.equal((sql.match(/^ROLLBACK;$/gm) ?? []).length, 1, 'MOLDURA_INESPERADA ' + nome);
  assert.equal((sql.match(/^(?:BEGIN;|COMMIT;|START TRANSACTION|SET TRANSACTION|SAVEPOINT|RELEASE)/gm) ?? []).length, 0, 'MOLDURA_INESPERADA ' + nome);
  const i = sql.indexOf('BEGIN TRANSACTION READ ONLY;\n');
  assert.ok(sql.endsWith('\nROLLBACK;\n') && i >= 0, 'MOLDURA_INESPERADA ' + nome);
  return sql.slice(i + 'BEGIN TRANSACTION READ ONLY;\n'.length, -'ROLLBACK;\n'.length);
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Estado → guardas. Sem guardas (`guardar` false) na conferência e na releitura depois de um COMMIT. */
async function estadoAtual(db, {guardar = true} = {}) {
  const s = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  if (guardar) exigirCatalogo(s);
  return s;
}
/** Contagens informativas (sem ids): clientes por status e, com a 112, por tipo. */
async function contagens(db, m112) {
  const r = await somenteLeitura(db, 'SELECT status::text AS status, count(*)::int AS n FROM public.clientes GROUP BY status ORDER BY status');
  const c = {total: r.rows.reduce((t, x) => t + x.n, 0), porStatus: Object.fromEntries(r.rows.map(x => [x.status, x.n]))};
  if (m112 === 'presente') {
    const t = await somenteLeitura(db, 'SELECT tipo_pessoa AS tipo, count(*)::int AS n FROM public.clientes GROUP BY tipo_pessoa ORDER BY tipo_pessoa');
    c.porTipo = Object.fromEntries(t.rows.map(x => [x.tipo, x.n]));
  }
  return c;
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado, guardas, plano, contagens e, em READ ONLY, o
 * precheck (ausente) ou o postcheck (presente).
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = await estadoAtual(db, {guardar: false});
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  const presente = r.estado.m112 === 'presente';
  r.contagens = await contagens(db, r.estado.m112);
  r.checks = {};
  const nome = presente ? 'postcheck 112' : 'precheck 112';
  try { const [, arquivo, hash] = etapa(nome); await somenteLeitura(db, corpoSomenteLeitura(lerRevisado(raiz, arquivo, hash), nome)); r.checks[nome] = 'PASS'; }
  catch (e) { r.checks[nome] = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.resultado = presente ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Migration sem o COMMIT final; preservação e postcheck dentro da transação; COMMIT só com tudo PASS. Registra a situação
 * do COMMIT (NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO) antes de qualquer outra leitura.
 */
async function migrarComVerificacao(db, sqls, passo, registrar) {
  let fase = 'corpo';
  try {
    await db.query(semCommitFinal(sqls.get('migration 112'), 'migration 112'));
    fase = 'verificacao';
    passo.antesDoCommit = {};
    const p = (await db.query(SQL_PRESERVACAO)).rows[0];
    assert.ok(p && p.clientes_escritos === 0 && p.mesclagens_escritas === 0, `PRESERVACAO_112 clientes=${p?.clientes_escritos} mesclagens=${p?.mesclagens_escritas}`);
    passo.antesDoCommit.preservacao = 'PASS';
    await db.query(corpoSomenteLeitura(sqls.get('postcheck 112'), 'postcheck 112'));
    passo.antesDoCommit['postcheck 112'] = 'PASS';
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_112'); }
  } catch (e) {
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    registrar();
    await db.query('ROLLBACK').catch(() => {}); throw e;
  }
  passo.commit = 'CONFIRMADO'; registrar();
}

/**
 * Aplicação, na ordem do plano: precheck (READ ONLY) → migration sem COMMIT → verificações na transação → COMMIT →
 * postcheck (READ ONLY). O estado é relido aqui, imediatamente antes.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  semCommitFinal(sqls.get('migration 112'), 'migration 112');
  for (const nome of ['precheck 112', 'postcheck 112']) corpoSomenteLeitura(sqls.get(nome), nome);
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.plano = planoEtapas(r.estadoAntes);
  r.contagensAntes = await contagens(db, r.estadoAntes.m112);
  registrar(r);
  for (const nome of r.plano) {
    const passo = {nome, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    if (nome === 'migration 112') {
      await migrarComVerificacao(db, sqls, passo, () => registrar(r));
      assert.equal((await estadoAtual(db, {guardar: false})).m112, 'presente', 'ESTADO_DEPOIS_112');
    } else await somenteLeitura(db, corpoSomenteLeitura(sqls.get(nome), nome));
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db, {guardar: false});
  assert.equal(r.estadoDepois.m112, 'presente', 'ESTADO_FINAL_112');
  r.contagensDepois = await contagens(db, 'presente');
  r.resultado = r.plano.includes('migration 112') ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => ['112', x.commit]));
const commitadas = r => Object.entries(situacoes(r)).filter(([, c]) => c === 'CONFIRMADO').map(([id]) => id);

function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === FLAG_BACKUP) {
    assert.match(argv[2], /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', backup: argv[2]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

/** Fábrica do aplicador de um ambiente (mesmo contrato dos aplicadores 092–109: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco). */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      provaNoAlvo: 'preservação (nenhuma linha de clientes/mesclagens_clientes escrita pela transação) e postcheck DENTRO da transação da 112, antes do COMMIT; depois, o postcheck em READ ONLY',
      prazos: 'lock_timeout 5 s e statement_timeout 60 s do próprio SQL (SET LOCAL); estouro antes do COMMIT = NAO_COMMITADA; no COMMIT = INDETERMINADO',
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['112: nenhum dos 19 objetos presente (precheck: 004, 009, 054 e 076 aplicadas)',
        '112: current_user com os privilégios do DONO de clientes e de mesclagens_clientes, USAGE e CREATE em public e USAGE em plpgsql',
        'código da Entrega B (compatível com e sem a 112) publicado no web; o código anterior também convive com a 112 (linhas novas nascem PF)'],
      ordem: ['conferir no Render o commit do web (Entrega B) e os hashes implantados', FLAG_CONFERIR,
        'ponto de recuperação do PostgreSQL deste ambiente comprovado (PITR disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação)',
        'autorização de Felipe para a 112 neste ambiente',
        'janela curta: sem DDL concorrente; leituras e escritas de clientes esperam a transação (ACCESS EXCLUSIVE, lock_timeout 5 s)',
        `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR,
        'conferência funcional logada: cadastro PF segue igual; PJ (cliente, importação, fechamento) liberada'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'marcador incompleto ou ilegível, processo interrompido (sem saída final) ou conferência RECUSARIA depois de CONFIRMADO: parar, preservar saída e marcador, reconciliar e só então decidir',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-112.<horario>.json'],
      recuperacao: ['database/rollback/20261101_112_clientes_pessoa_juridica_down.sql só com autorização própria e SEM nenhum dado de PJ (o down recusa)',
        'depois da primeira PJ: só correção para frente', 'em último caso, restauração PITR ao ponto registrado'],
      nuncaExecuta: ['down 112', 'alteração de env', 'deploy', 'restart', 'escrita em clientes ou mesclagens_clientes']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env)}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco()}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of ETAPAS) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-112\..+\.json$/.test(n)).sort();
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env),
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA', commits: situacoes(r), commitadas: commitadas(r)});
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        contagensAntes: r.contagensAntes, contagensDepois: r.contagensDepois, etapas: r.etapas.map(e => e.nome), commits: situacoes(r), commitadas: commitadas(r)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      const situacao = {commits: situacoes(ultimo), commitadas: commitadas(ultimo), reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir`};
      salvar({...ultimo, situacao: 'FALHA', falha, ...situacao});
      return {resultado: 'FALHA', marcador, falha, ...situacao};
    } finally { await db.end().catch(() => {}); }
  }
  /** Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA. */
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_POSTCHECK_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
  async function principal(argv, env, deps = {}) {
    const m = modo(argv);
    if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
    const s = m.modo === 'conferir' ? await conferir({env, ...deps}) : await executar({env, backup: m.backup, ...deps});
    return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
  }
  function cli() {
    principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
      (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
    }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
  }
  return {plano, conferir, executar, principal, cli, CODIGO};
}

module.exports = {ETAPAS, OBJETOS, TOTAL_OBJETOS, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, SQL_ESTADO, SQL_PRESERVACAO, lerEstado,
  exigirCatalogo, planoEtapas, commitNaFalha, semCommitFinal, corpoSomenteLeitura, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
