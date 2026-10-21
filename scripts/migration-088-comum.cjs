/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo dos aplicadores manuais da 088 (autorização do responsável para Convites com IA) — staging e produção
// (scripts/migration-088-staging.cjs e scripts/migration-088-production.cjs, que fixam o alvo, a identidade da conexão e
// o disco). Derivado dos aplicadores 084 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador
// exclusivo no disco persistente) e 085/086 (estado ausente/completa/parcial, privilégios de criação e de referência).
// Ordem decidida em 21/10/2026 (revisão de 15aa937, §7): o CÓDIGO é publicado ANTES, já com este aplicador e os SQL na
// árvore implantada; sem a 088 a geração com IA fica bloqueada (falha fechada). Depois: --conferir-088 → autorização →
// --aplicar-088-autorizado --backup <registro> → --conferir-088.
// Conferência: somente leitura (BEGIN TRANSACTION READ ONLY em toda consulta), não grava nada no banco nem no disco.
// Aplicação: precheck (READ ONLY) → migration (transação própria do arquivo, lock_timeout 5s) → postcheck (READ ONLY).
// Nunca executa o down. A saída tem só nomes de etapas, booleanos e contagens (sem ids, nomes ou URL do banco).
// Privilégios: avaliados como current_user, que é quem executa o DDL. No Render a credencial entra com `SET role` do
// dono (current_user = dono, session_user = credencial; lição de 14/10/2026): por isso current_user, e o papel trocado
// só é informado (papel_trocado), nunca o nome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const FLAG_CONFERIR = '--conferir-088';
const FLAG_APLICAR = '--aplicar-088-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-088.json';
const ETAPAS = Object.freeze([
  ['precheck 088', 'database/checks/20261021_088_precheck.sql', 'cfc745da8a01eb85161def50b0cbfea046be80da084f9d4ad043d4952f53f99e'],
  ['migration 088', 'database/migrations/20261021_088_convite_ia_autorizacoes.sql', '10b4d32685aeb58f7cca1ca358c44e4c35808cb42a28da6045f6865743e0fe91'],
  ['postcheck 088', 'database/checks/20261021_088_postcheck.sql', 'd1a4a9985d6ceed8f72cd877dde4a0c351d4a889f20f8895309c0124408c94d1'],
]);
/** Tabelas que a 088 referencia por FK (REFERENCES exigido); memberships só é lida pelo gatilho. */
const REFERENCIADAS = Object.freeze(['convites', 'empresas', 'festas', 'clientes', 'usuarios_administrativos']);
const lista = xs => xs.map(x => `'${x}'`).join(',');
/** Estado estrutural (leitura): dependências, cada objeto da 088, privilégios. Sem ids nem dados de clientes. */
const SQL_ESTADO = `SELECT
  (to_regclass('public.convites') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.convites') AND contype='u'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('public.convites') AND attname='id'),
                       (SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('public.convites') AND attname='empresa_id')]::int2[])) AS m073,
  to_regclass('public.memberships') IS NOT NULL AS memberships,
  to_regclass('public.convite_ia_autorizacoes') IS NOT NULL AS tabela,
  to_regprocedure('public.convite_ia_autorizacao_validar()') IS NOT NULL AS funcao,
  to_regclass('public.convite_ia_autorizacao_vigente') IS NOT NULL AS indice_vigente,
  to_regclass('public.convite_ia_autorizacoes_empresa') IS NOT NULL AS indice_empresa,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='convite_ia_autorizacao_validar' AND tgrelid=to_regclass('public.convite_ia_autorizacoes')) AS gatilho,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT bool_and(has_table_privilege(current_user,to_regclass('public.'||t),'REFERENCES'))
    FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${REFERENCIADAS.length} AS pode_referenciar,
  session_user <> current_user AS papel_trocado`;
const OBJETOS = Object.freeze(['tabela', 'funcao', 'indice_vigente', 'indice_empresa', 'gatilho']);

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** ausente | completa | parcial, pelos cinco objetos da 088 (a migration é uma transação só). */
function lerEstado(e) {
  for (const k of ['m073', 'memberships', ...OBJETOS, 'pode_criar', 'pode_referenciar', 'papel_trocado']) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const presentes = OBJETOS.filter(k => e[k]).length;
  return {m073: e.m073, memberships: e.memberships, m088: presentes === 0 ? 'ausente' : presentes === OBJETOS.length ? 'completa' : 'parcial',
    pode_criar: e.pode_criar, pode_referenciar: e.pode_referenciar, papel_trocado: e.papel_trocado};
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.m073 && s.memberships, 'DEPENDENCIA_AUSENTE_073');
  assert.notEqual(s.m088, 'parcial', 'APLICACAO_PARCIAL_088');
  if (s.m088 === 'completa') return ['postcheck 088'];
  assert.ok(s.pode_criar && s.pode_referenciar, 'SEM_PRIVILEGIO_088 ' + (s.pode_criar ? '' : 'CREATE ') + (s.pode_referenciar ? '' : 'REFERENCES'));
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
/** Contagens informativas (sem ids): convites e, com a 088 completa, autorizações registradas. */
async function contagens(db, estado) {
  const sql = estado.m088 === 'completa'
    ? 'SELECT (SELECT count(*) FROM convites)::int AS convites, (SELECT count(*) FROM convite_ia_autorizacoes)::int AS autorizacoes'
    : 'SELECT (SELECT count(*) FROM convites)::int AS convites';
  return (await somenteLeitura(db, sql)).rows[0];
}

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e o check aplicável em READ ONLY. */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = await contagens(db, r.estado);
  const [nome, arquivo, hash] = r.estado.m088 === 'completa' ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.estado.m088 === 'completa' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/** Aplicação: precheck (READ ONLY) → migration (transação do arquivo) → estado completo → postcheck (READ ONLY). */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  r.plano = planoEtapas(r.estadoAntes); r.contagensAntes = await contagens(db, r.estadoAntes); registrar(r);
  for (const nome of r.plano) {
    r.etapas.push({nome, inicio: new Date().toISOString()}); registrar(r);
    if (nome === 'migration 088') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
      // A migration commitou no próprio arquivo: o estado precisa estar completo antes do postcheck.
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]).m088, 'completa', 'ESTADO_DEPOIS_088');
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m088, 'completa', 'ESTADO_FINAL_088');
  r.contagensDepois = await contagens(db, r.estadoDepois);
  r.resultado = r.plano.length === 1 ? 'JA_APLICADA_POSTCHECK_PASS' : 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}

/** Modo pelos argumentos: nenhum (plano), --conferir-088, ou --aplicar-088-autorizado --backup <registro>. */
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
      preRequisitos: ['073 (convites com UNIQUE (id, empresa_id)) e memberships', '088 ausente ou completa (nunca parcial)', 'CREATE em public', 'REFERENCES em ' + REFERENCIADAS.join('/')],
      ordem: ['deploy do código (IA bloqueada sem a 088)', FLAG_CONFERIR, 'autorização de Felipe', FLAG_APLICAR, FLAG_CONFERIR],
      nuncaExecuta: ['down 088', 'alteração de env', 'chamada a provedor de IA']};
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
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA'};
    // Exclusivo: qualquer tentativa anterior (concluída, falha ou perdida) impede repetição automática.
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env),
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA'});
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        contagensAntes: r.contagensAntes, contagensDepois: r.contagensDepois, etapas: r.etapas.map(e => e.nome)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      salvar({...ultimo, situacao: 'FALHA', falha});
      return {resultado: 'FALHA', marcador, falha, migracaoCommitada: ultimo.etapas?.some(x => x.nome === 'migration 088' && x.ok) === true};
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

module.exports = {ETAPAS, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, REFERENCIADAS, SQL_ESTADO, lerRevisado, lerEstado, planoEtapas,
  conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
