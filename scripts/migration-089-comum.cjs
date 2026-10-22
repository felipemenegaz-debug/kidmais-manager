/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo dos aplicadores manuais da 089 (pedidos de cancelamento e devolução da assinatura, L1) — staging e produção
// (scripts/migration-089-staging.cjs e scripts/migration-089-production.cjs, que fixam o alvo, a identidade da conexão e
// o disco). Derivado dos aplicadores 084 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador
// exclusivo no disco persistente) e 085/086 (estado ausente/completa/parcial, privilégios de criação e de referência).
// Ordem decidida em 21/10/2026 (revisão de 15aa937, §7): o CÓDIGO é publicado ANTES, já com este aplicador e os SQL na
// árvore implantada; sem a 089 o cancelamento segue sem protocolo e a devolução fica oculta. Depois: --conferir-089 → autorização →
// --aplicar-089-autorizado --backup <registro> → --conferir-089.
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

const FLAG_CONFERIR = '--conferir-089';
const FLAG_APLICAR = '--aplicar-089-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-089.json';
const ETAPAS = Object.freeze([
  ['precheck 089', 'database/checks/20261021_089_precheck.sql', '9002dc4e005d2c342716873f88078e9fc12f009a0e7a30b7f77085027a7b483e'],
  ['migration 089', 'database/migrations/20261021_089_assinatura_encerramentos.sql', '8c7c1f4dc36cc6ef7978572195fd9ff41ce12507730703b51fc5d18198602ba1'],
  ['postcheck 089', 'database/checks/20261021_089_postcheck.sql', 'edb7ff32dd4a38c16488079d9ede109aa9a7f04057046daa8cfa4bb6f45069ec'],
]);
/** Tabelas que a 089 referencia por FK (REFERENCES exigido). */
const REFERENCIADAS = Object.freeze(['empresa_assinaturas', 'usuarios_administrativos']);
const lista = xs => xs.map(x => `'${x}'`).join(',');
/** Estado estrutural (leitura): dependências, cada objeto da 089, privilégios. Sem ids nem dados de clientes. */
const SQL_ESTADO = `SELECT
  (to_regclass('public.empresa_assinaturas') IS NOT NULL AND to_regclass('public.cobranca_eventos') IS NOT NULL
    AND to_regclass('public.assinatura_contratacoes') IS NOT NULL) AS m074a,
  to_regclass('public.usuarios_administrativos') IS NOT NULL AS usuarios,
  to_regclass('public.assinatura_encerramentos') IS NOT NULL AS tabela,
  to_regprocedure('public.kidmais_089_encerramento_guarda()') IS NOT NULL AS funcao,
  to_regclass('public.assinatura_encerramentos_cobranca_uk') IS NOT NULL AS indice_cobranca,
  to_regclass('public.assinatura_encerramentos_garantia_uk') IS NOT NULL AS indice_garantia,
  to_regclass('public.assinatura_encerramentos_empresa_idx') IS NOT NULL AS indice_empresa,
  to_regclass('public.assinatura_encerramentos_abertos_idx') IS NOT NULL AS indice_abertos,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_encerramentos_089_guarda_trg' AND tgrelid=to_regclass('public.assinatura_encerramentos')) AS gatilho,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_encerramentos_089_sem_truncate_trg' AND tgrelid=to_regclass('public.assinatura_encerramentos')) AS gatilho_truncate,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT bool_and(has_table_privilege(current_user,to_regclass('public.'||t),'REFERENCES'))
    FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${REFERENCIADAS.length} AS pode_referenciar,
  session_user <> current_user AS papel_trocado`;
const OBJETOS = Object.freeze(['tabela', 'funcao', 'indice_cobranca', 'indice_garantia', 'indice_empresa', 'indice_abertos', 'gatilho', 'gatilho_truncate']);

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** ausente | completa | parcial, pelos oito objetos da 089 (a migration é uma transação só). */
function lerEstado(e) {
  for (const k of ['m074a', 'usuarios', ...OBJETOS, 'pode_criar', 'pode_referenciar', 'papel_trocado']) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const presentes = OBJETOS.filter(k => e[k]).length;
  return {m074a: e.m074a, usuarios: e.usuarios, m089: presentes === 0 ? 'ausente' : presentes === OBJETOS.length ? 'completa' : 'parcial',
    pode_criar: e.pode_criar, pode_referenciar: e.pode_referenciar, papel_trocado: e.papel_trocado};
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.m074a && s.usuarios, 'DEPENDENCIA_AUSENTE_067_068_074A');
  assert.notEqual(s.m089, 'parcial', 'APLICACAO_PARCIAL_089');
  if (s.m089 === 'completa') return ['postcheck 089'];
  assert.ok(s.pode_criar && s.pode_referenciar, 'SEM_PRIVILEGIO_089 ' + (s.pode_criar ? '' : 'CREATE ') + (s.pode_referenciar ? '' : 'REFERENCES'));
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
/** Contagens informativas (sem ids): assinaturas e, com a 089 completa, pedidos registrados. */
async function contagens(db, estado) {
  const sql = estado.m089 === 'completa'
    ? 'SELECT (SELECT count(*) FROM empresa_assinaturas)::int AS assinaturas, (SELECT count(*) FROM assinatura_encerramentos)::int AS pedidos'
    : 'SELECT (SELECT count(*) FROM empresa_assinaturas)::int AS assinaturas';
  return (await somenteLeitura(db, sql)).rows[0];
}

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e o check aplicável em READ ONLY. */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = await contagens(db, r.estado);
  const [nome, arquivo, hash] = r.estado.m089 === 'completa' ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.estado.m089 === 'completa' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
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
    if (nome === 'migration 089') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
      // A migration commitou no próprio arquivo: o estado precisa estar completo antes do postcheck.
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]).m089, 'completa', 'ESTADO_DEPOIS_089');
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m089, 'completa', 'ESTADO_FINAL_089');
  r.contagensDepois = await contagens(db, r.estadoDepois);
  r.resultado = r.plano.length === 1 ? 'JA_APLICADA_POSTCHECK_PASS' : 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}

/** Modo pelos argumentos: nenhum (plano), --conferir-089, ou --aplicar-089-autorizado --backup <registro>. */
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
      preRequisitos: ['067/068/074a (empresa_assinaturas, cobranca_eventos, assinatura_contratacoes) e usuarios_administrativos', '089 ausente ou completa (nunca parcial)', 'CREATE em public', 'REFERENCES em ' + REFERENCIADAS.join('/')],
      ordem: ['deploy do código (sem a 089: cancelamento sem protocolo, devolução oculta)', FLAG_CONFERIR, 'autorização de Felipe', FLAG_APLICAR, FLAG_CONFERIR],
      nuncaExecuta: ['down 089', 'alteração de env', 'chamada ao Asaas']};
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
      return {resultado: 'FALHA', marcador, falha, migracaoCommitada: ultimo.etapas?.some(x => x.nome === 'migration 089' && x.ok) === true};
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
