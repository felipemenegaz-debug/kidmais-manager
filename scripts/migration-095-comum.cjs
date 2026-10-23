/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo dos aplicadores manuais da 095 (créditos de IA: carteiras, lotes, extrato, compra avulsa, devolução, corte) — staging e produção
// (scripts/migration-095-staging.cjs e scripts/migration-095-production.cjs, que fixam o alvo, a identidade da conexão e
// o disco). Derivado dos aplicadores 084 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador
// exclusivo no disco persistente) e 085/086 (estado ausente/completa/parcial, privilégios de criação e de referência).
// Ordem igual à da 088/089 (decidida em 21/10/2026, revisão de 15aa937, §7): o CÓDIGO é publicado ANTES, já com este aplicador e os SQL na
// árvore implantada; sem a 095 os fluxos antigos seguem e compra/consumo novos recusam (503). Depois: --conferir-095 → autorização →
// --aplicar-095-autorizado --backup <registro> → --conferir-095.
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

const FLAG_CONFERIR = '--conferir-095';
const FLAG_APLICAR = '--aplicar-095-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-095.json';
const ETAPAS = Object.freeze([
  ['precheck 095', 'database/checks/20261022_095_precheck.sql', '470f3b135a1453a9841acdd500f1b52d064cf99109bb67fb3143707d4b9a6438'],
  ['migration 095', 'database/migrations/20261022_095_ia_creditos.sql', '0dac17714c1d820c35cb57e7b9e5afc139fad1b80cd473c78023dd5dd9af7e4e'],
  ['postcheck 095', 'database/checks/20261022_095_postcheck.sql', '8b33991e782cb763962a5a0c1f02c7b1bf3782f8f872ba3bf95f9d5a6e296f9c'],
]);
/** Tabelas EXISTENTES que a 095 referencia por FK (REFERENCES exigido); as demais FKs são entre as tabelas novas. */
const REFERENCIADAS = Object.freeze(['empresas', 'usuarios_administrativos']);
const lista = xs => xs.map(x => `'${x}'`).join(',');
/** Estado estrutural (leitura): dependências, cada objeto da 095, privilégios. Sem ids nem dados de clientes. */
const SQL_ESTADO = `SELECT
  (to_regclass('public.empresas') IS NOT NULL AND to_regclass('public.convite_carteiras') IS NOT NULL AND to_regclass('public.convite_geracoes') IS NOT NULL
    AND to_regclass('public.cobranca_eventos') IS NOT NULL AND to_regclass('public.empresa_assinaturas') IS NOT NULL) AS dependencias,
  to_regclass('public.usuarios_administrativos') IS NOT NULL AS usuarios,
  to_regclass('public.ia_credito_carteiras') IS NOT NULL AS carteiras,
  to_regclass('public.ia_credito_pedidos') IS NOT NULL AS pedidos,
  to_regclass('public.ia_credito_lotes') IS NOT NULL AS lotes,
  to_regclass('public.ia_credito_lancamentos') IS NOT NULL AS lancamentos,
  to_regclass('public.ia_credito_reservas') IS NOT NULL AS reservas,
  to_regclass('public.ia_credito_reserva_lotes') IS NOT NULL AS reserva_lotes,
  to_regclass('public.ia_credito_cobrancas') IS NOT NULL AS cobrancas,
  to_regclass('public.ia_credito_devolucoes') IS NOT NULL AS devolucoes,
  to_regclass('public.ia_credito_cortesias') IS NOT NULL AS cortesias,
  to_regclass('public.ia_credito_cortes') IS NOT NULL AS cortes,
  to_regclass('public.ia_credito_notificacoes') IS NOT NULL AS notificacoes,
  to_regprocedure('public.kidmais_095_guarda()') IS NOT NULL AS funcao,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname ~ '^ia_credito_[a-z_]+_095_(guarda|sem_truncate)_trg$')=22 AS gatilhos,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT bool_and(has_table_privilege(current_user,to_regclass('public.'||t),'REFERENCES'))
    FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${REFERENCIADAS.length} AS pode_referenciar,
  session_user <> current_user AS papel_trocado`;
const OBJETOS = Object.freeze(['carteiras', 'pedidos', 'lotes', 'lancamentos', 'reservas', 'reserva_lotes', 'cobrancas', 'devolucoes', 'cortesias', 'cortes', 'notificacoes', 'funcao', 'gatilhos']);

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** ausente | completa | parcial, pelos treze objetos da 095 (onze tabelas, a guarda e os 22 gatilhos; a migration é uma transação só). */
function lerEstado(e) {
  for (const k of ['dependencias', 'usuarios', ...OBJETOS, 'pode_criar', 'pode_referenciar', 'papel_trocado']) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const presentes = OBJETOS.filter(k => e[k]).length;
  return {dependencias: e.dependencias, usuarios: e.usuarios, m095: presentes === 0 ? 'ausente' : presentes === OBJETOS.length ? 'completa' : 'parcial',
    pode_criar: e.pode_criar, pode_referenciar: e.pode_referenciar, papel_trocado: e.papel_trocado};
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.dependencias && s.usuarios, 'DEPENDENCIA_AUSENTE_068_073_084');
  assert.notEqual(s.m095, 'parcial', 'APLICACAO_PARCIAL_095');
  if (s.m095 === 'completa') return ['postcheck 095'];
  assert.ok(s.pode_criar && s.pode_referenciar, 'SEM_PRIVILEGIO_095 ' + (s.pode_criar ? '' : 'CREATE ') + (s.pode_referenciar ? '' : 'REFERENCES'));
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
/** Contagens informativas (sem ids): empresas e, com a 095 completa, carteiras, lotes e pedidos registrados. */
async function contagens(db, estado) {
  const sql = estado.m095 === 'completa'
    ? 'SELECT (SELECT count(*) FROM empresas)::int AS empresas, (SELECT count(*) FROM ia_credito_carteiras)::int AS carteiras, (SELECT count(*) FROM ia_credito_lotes)::int AS lotes, (SELECT count(*) FROM ia_credito_pedidos)::int AS pedidos'
    : 'SELECT (SELECT count(*) FROM empresas)::int AS empresas';
  return (await somenteLeitura(db, sql)).rows[0];
}

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e o check aplicável em READ ONLY. */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = await contagens(db, r.estado);
  const [nome, arquivo, hash] = r.estado.m095 === 'completa' ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.estado.m095 === 'completa' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
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
    if (nome === 'migration 095') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
      // A migration commitou no próprio arquivo: o estado precisa estar completo antes do postcheck.
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]).m095, 'completa', 'ESTADO_DEPOIS_095');
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m095, 'completa', 'ESTADO_FINAL_095');
  r.contagensDepois = await contagens(db, r.estadoDepois);
  r.resultado = r.plano.length === 1 ? 'JA_APLICADA_POSTCHECK_PASS' : 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}

/** Modo pelos argumentos: nenhum (plano), --conferir-095, ou --aplicar-095-autorizado --backup <registro>. */
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
      preRequisitos: ['empresas, usuarios_administrativos, 068 (cobranca_eventos, empresa_assinaturas), 073 (convite_carteiras) e 084 (convite_geracoes)', '095 ausente ou completa (nunca parcial)', 'CREATE em public', 'REFERENCES em ' + REFERENCIADAS.join('/')],
      ordem: ['deploy do código com as flags CREDITOS_* desligadas (sem a 095: fluxos antigos, compra/consumo novos recusam)', FLAG_CONFERIR, 'autorização de Felipe', FLAG_APLICAR, FLAG_CONFERIR],
      nuncaExecuta: ['down 095', 'alteração de env', 'chamada ao Asaas']};
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
      return {resultado: 'FALHA', marcador, falha, migracaoCommitada: ultimo.etapas?.some(x => x.nome === 'migration 095' && x.ok) === true};
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
