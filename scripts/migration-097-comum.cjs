/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo dos aplicadores manuais da 097 (manifestações do direito de arrependimento; grupo C do parecer de apoio,
// 23/10/2026) — staging e produção (scripts/migration-097-staging.cjs e scripts/migration-097-production.cjs, que fixam o
// alvo, a identidade da conexão e o disco). Derivado do núcleo da 096: alvo travado, TLS, hash fixado de cada SQL com
// CRLF normalizado, estado ausente/completa/parcial, privilégios, marcador exclusivo no disco persistente, saída sanitizada.
// Ordem: o CÓDIGO é publicado ANTES, já com este aplicador e os SQL na árvore implantada; sem a 097 a tela indica o canal
// oficial para o arrependimento. Depois: --conferir-097 → autorização → --aplicar-097-autorizado --backup <registro> →
// --conferir-097.
// Conferência: somente leitura (BEGIN TRANSACTION READ ONLY em toda consulta), não grava nada no banco nem no disco.
// Aplicação: precheck (READ ONLY) → migration (transação própria do arquivo, lock_timeout 5s) → postcheck (READ ONLY) →
// prova agregada de preservação (assinaturas existentes iguais antes e depois; a 097 só cria uma tabela nova).
// Nunca executa o down. A saída tem só nomes de etapas, booleanos, contagens e resumos md5 agregados (sem dados pessoais).
// Privilégios avaliados como current_user (no Render a credencial entra com `SET role` do dono; lição de 14/10/2026).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const FLAG_CONFERIR = '--conferir-097';
const FLAG_APLICAR = '--aplicar-097-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-097.json';
const ETAPAS = Object.freeze([
  ['precheck 097', 'database/checks/20261023_097_precheck.sql', 'cbd89bdfc1e2e7012f6a405ba03849eb1550bb4bd75b1f04c57fe7c0755dd137'],
  ['migration 097', 'database/migrations/20261023_097_assinatura_arrependimentos.sql', '9b10f5ccae95e32717c75ad6718afad4f6015b8c5b49a852f423861e3361813d'],
  ['postcheck 097', 'database/checks/20261023_097_postcheck.sql', '10e96188cbb4a96a8a69baa9bd26e7774ec51233d8272d5b744cc2d12fcb6b4d'],
]);
/** FKs das manifestações: REFERENCES exigido nestas tabelas. A 097 só CRIA uma tabela: nenhuma tabela existente é alterada. */
const REFERENCIADAS = Object.freeze(['empresa_assinaturas', 'usuarios_administrativos']);
const ALTERADAS = Object.freeze([]);
const lista = xs => xs.map(x => `'${x}'`).join(',');
const def = nome => `coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='${nome}' AND contype='c' LIMIT 1), '')`;
/** Estado estrutural (leitura): dependências, cada objeto da 097 e privilégios. Sem dados. */
const SQL_ESTADO = `SELECT
  to_regclass('public.empresa_assinaturas') IS NOT NULL AS m068,
  to_regclass('public.usuarios_administrativos') IS NOT NULL AS usuarios,
  to_regclass('public.assinatura_arrependimentos') IS NOT NULL AS tabela,
  to_regprocedure('public.kidmais_097_guarda()') IS NOT NULL AS guarda,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_arrependimentos_097_guarda' AND tgrelid=to_regclass('public.assinatura_arrependimentos')) AS gatilho,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT bool_and(has_table_privilege(current_user,to_regclass('public.'||t),'REFERENCES'))
    FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${REFERENCIADAS.length} AS pode_referenciar,
  true AS dono_alteradas,
  session_user <> current_user AS papel_trocado`;
const OBJETOS = Object.freeze(['tabela', 'guarda', 'gatilho']);
/** Corte lido no banco ANTES da migration: a prova compara só linhas criadas até ele (tráfego durante a janela não conta). */
const SQL_CORTE = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS corte`;
const CORTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const tx = c => `coalesce((${c})::text,'~')`;
/**
 * Resumo das colunas que a 097 não pode tocar nas assinaturas criadas até o corte (empresa e criação); situação e datas
 * mudam com o tráfego e ficam fora. A 097 só cria uma tabela. Só o md5 agregado sai.
 */
function SQL_PRESERVACAO(corte) {
  assert.match(String(corte), CORTE, 'CORTE_INVALIDO');
  const ate = `'${corte}'::timestamptz`;
  return `/* preservacao-097 */ SELECT
  (SELECT count(*)::int FROM empresa_assinaturas WHERE criado_em <= ${ate}) AS assinaturas,
  (SELECT coalesce(md5(string_agg(concat_ws('|', empresa_id, criado_em), ',' ORDER BY empresa_id)), 'vazio') FROM empresa_assinaturas WHERE criado_em <= ${ate}) AS resumo_assinaturas`;
}

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** ausente | completa | parcial, pelos objetos da 097 (a migration é uma transação só). */
function lerEstado(e) {
  for (const k of ['m068', 'usuarios', ...OBJETOS, 'pode_criar', 'pode_referenciar', 'dono_alteradas', 'papel_trocado'])
    assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const presentes = OBJETOS.filter(k => e[k]).length;
  return {m068: e.m068, usuarios: e.usuarios, m097: presentes === 0 ? 'ausente' : presentes === OBJETOS.length ? 'completa' : 'parcial',
    pode_criar: e.pode_criar, pode_referenciar: e.pode_referenciar, dono_alteradas: e.dono_alteradas, papel_trocado: e.papel_trocado};
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.m068 && s.usuarios, 'DEPENDENCIA_AUSENTE_068_USUARIOS');
  assert.notEqual(s.m097, 'parcial', 'APLICACAO_PARCIAL_097');
  if (s.m097 === 'completa') return ['postcheck 097'];
  assert.ok(s.pode_criar && s.pode_referenciar, 'SEM_PRIVILEGIO_097 ' + (s.pode_criar ? '' : 'CREATE ') + (s.pode_referenciar ? '' : 'REFERENCES'));
  return ETAPAS.map(([nome]) => nome);
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout = '30s'");
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Contagens e resumos agregados (sem dados pessoais); com a 097 completa, manifestações por situação. */
async function contagens(db, estado, corte) {
  const r = {...(await somenteLeitura(db, SQL_PRESERVACAO(corte))).rows[0]};
  if (estado.m097 === 'completa') Object.assign(r, (await somenteLeitura(db, `SELECT
    (SELECT count(*) FROM assinatura_arrependimentos)::int AS manifestacoes,
    (SELECT count(*) FROM assinatura_arrependimentos WHERE situacao = 'RECEBIDO')::int AS manifestacoes_abertas`)).rows[0]);
  return r;
}

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e o check aplicável em READ ONLY. */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = await contagens(db, r.estado, (await somenteLeitura(db, SQL_CORTE)).rows[0]?.corte);
  const [nome, arquivo, hash] = r.estado.m097 === 'completa' ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.estado.m097 === 'completa' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/** Aplicação: precheck (READ ONLY) → migration (transação do arquivo) → estado completo → postcheck → preservação. */
/**
 * Uma escrita feita ANTES do corte, mas ainda não confirmada quando o corte é lido, entraria no "depois" e não no "antes"
 * (falso PRESERVACAO_DIVERGENTE; revisão de 22/10/2026). Espera, só lendo, até nenhuma outra sessão deste banco ter
 * transação aberta desde antes do corte; sem isso, recusa ANTES de qualquer escrita. Limite: o papel precisa enxergar
 * `xact_start` das outras sessões (mesmo papel ou pg_read_all_stats); sessões invisíveis não são esperadas.
 */
// Só sessões de cliente (autovacuum e processos de fundo não escrevem nessas tabelas). Sessões cujo detalhe o papel não
// enxerga ('<insufficient privilege>') são CONTADAS e informadas no registro: não dá para esperá-las (revisão de 22/10/2026).
const SQL_ANTERIORES = corte => `SELECT
  count(*) FILTER (WHERE xact_start IS NOT NULL AND xact_start <= '${corte}'::timestamptz)::int AS n,
  count(*) FILTER (WHERE query = '<insufficient privilege>')::int AS invisiveis
  FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND backend_type = 'client backend'`;
async function esperarTransacoesAnteriores(db, corte, pausa, tentativas) {
  assert.match(String(corte), CORTE, 'CORTE_INVALIDO');
  for (let i = 0; i < tentativas; i++) {
    const linha = (await somenteLeitura(db, SQL_ANTERIORES(corte))).rows[0];
    if (Number(linha?.n ?? 1) === 0) return {esperas: i, sessoesInvisiveis: Number(linha?.invisiveis ?? 0)};
    await pausa(500);
  }
  assert.fail('TRANSACOES_ANTERIORES_AO_CORTE');
}
const dormir = ms => new Promise(fim => setTimeout(fim, ms));

async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}, pausa = dormir, tentativas = 60}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  r.plano = planoEtapas(r.estadoAntes);
  r.corte = (await somenteLeitura(db, SQL_CORTE)).rows[0]?.corte;
  r.esperasCorte = await esperarTransacoesAnteriores(db, r.corte, pausa, tentativas);
  r.contagensAntes = await contagens(db, r.estadoAntes, r.corte); registrar(r);
  for (const nome of r.plano) {
    r.etapas.push({nome, inicio: new Date().toISOString()}); registrar(r);
    if (nome === 'migration 097') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
      // A migration commitou no próprio arquivo: o estado precisa estar completo antes do postcheck.
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]).m097, 'completa', 'ESTADO_DEPOIS_097');
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m097, 'completa', 'ESTADO_FINAL_097');
  r.contagensDepois = await contagens(db, r.estadoDepois, r.corte);
  // Prova agregada: nenhuma assinatura existente mudou (a 097 só cria uma tabela).
  for (const k of ['assinaturas', 'resumo_assinaturas'])
    assert.equal(r.contagensDepois[k], r.contagensAntes[k], 'PRESERVACAO_DIVERGENTE ' + k);
  r.resultado = r.plano.length === 1 ? 'JA_APLICADA_POSTCHECK_PASS' : 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}

/** Modo pelos argumentos: nenhum (plano), --conferir-097, ou --aplicar-097-autorizado --backup <registro>. */
function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === FLAG_BACKUP) {
    // Referência do backup/export feito antes (ex.: horário e id do export, PITR anotado); só texto curto e seguro.
    assert.match(argv[2], /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', backup: argv[2]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

/**
 * Fábrica do aplicador de um ambiente. `amb` fixa: nome, alvo(env) → opções do pg, SQL de identidade, identidade(linha),
 * diretório do registro e verificação do disco persistente.
 */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['068 (empresa_assinaturas) e usuarios_administrativos',
        '097 ausente ou completa (nunca parcial)', 'CREATE em public', 'REFERENCES em ' + REFERENCIADAS.join('/')],
      ordem: ['deploy do código (sem a 097: a tela indica o canal oficial para o arrependimento)', FLAG_CONFERIR, 'autorização de Felipe', FLAG_APLICAR, FLAG_CONFERIR,
        'conferir o aviso interno (SITE_ATENDIMENTO_EMAIL) e a D-C4 antes de anunciar o registro pela tela'],
      nuncaExecuta: ['down 097', 'alteração de env', 'atualização de linhas existentes', 'chamada ao Asaas', 'envio de e-mail']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env)}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco(), pausa, tentativas}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of ETAPAS) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA'};
    // Exclusivo: qualquer tentativa anterior (concluída, falha ou perdida) impede repetição automática.
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), pausa, tentativas,
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA'});
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        contagensAntes: r.contagensAntes, contagensDepois: r.contagensDepois, esperaCorte: r.esperasCorte, etapas: r.etapas.map(e => e.nome)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      salvar({...ultimo, situacao: 'FALHA', falha});
      return {resultado: 'FALHA', marcador, falha, migracaoCommitada: ultimo.etapas?.some(x => x.nome === 'migration 097' && x.ok) === true};
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

module.exports = {ETAPAS, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, REFERENCIADAS, ALTERADAS, OBJETOS, SQL_ESTADO, SQL_PRESERVACAO, SQL_CORTE, SQL_ANTERIORES,
  lerRevisado, lerEstado, planoEtapas, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
