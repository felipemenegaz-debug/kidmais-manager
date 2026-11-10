/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo dos aplicadores manuais da 087 (fila de avisos por e-mail da assinatura, recorte de production de 02/11/2026) — staging e produção
// (scripts/migration-087-staging.cjs e scripts/migration-087-production.cjs, que fixam o alvo, a identidade da conexão e
// o disco). Derivado dos aplicadores 084 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador
// exclusivo no disco persistente) e 085/086 (estado ausente/completa/parcial, privilégios de criação e de referência).
// Derivado dos aplicadores da 089 (devolucao-gerar-aplicador-089.cjs → recorte-gerar-aplicador-087.cjs). Ordem igual à da 088/089: o CÓDIGO é
// publicado ANTES, já com este aplicador e os SQL na árvore implantada; sem a 087 nenhum aviso é gravado nem enviado (a trava
// ASSINATURA_AVISOS_EMAIL só é ligada depois). Depois: --conferir-087 → autorização →
// --aplicar-087-autorizado --backup <registro> → --conferir-087.
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

const FLAG_CONFERIR = '--conferir-087';
const FLAG_APLICAR = '--aplicar-087-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-087.json';
const ETAPAS = Object.freeze([
  ['precheck 087', 'database/checks/20261019_087_precheck.sql', '15f466c3e0cc4b6611f63d379c050591e744b345b7f5a20240e301470b1ff192'],
  ['migration 087', 'database/migrations/20261019_087_assinatura_avisos.sql', '9e3b8d47dc94571dd556954aef6b5bc0545e34f066ce803ebacda4114708145a'],
  ['postcheck 087', 'database/checks/20261019_087_postcheck.sql', 'ce92f1e0b3c0310b4bbbde31d22dde7487c03200dec0727b7fe0e04dc5fc43f0'],
]);
/** Tabelas que a 087 referencia por FK (REFERENCES exigido); empresa_assinaturas e memberships só são lidas pelo gatilho. */
const REFERENCIADAS = Object.freeze(['empresas', 'usuarios_administrativos']);
const lista = xs => xs.map(x => `'${x}'`).join(',');
/** Estado estrutural (leitura): dependências, cada objeto da 087, privilégios. Sem ids nem dados de clientes. */
const SQL_ESTADO = `SELECT
  (to_regclass('public.empresa_assinaturas') IS NOT NULL AND to_regclass('public.memberships') IS NOT NULL
    AND to_regclass('public.empresas') IS NOT NULL) AS m068,
  to_regclass('public.usuarios_administrativos') IS NOT NULL AS usuarios,
  to_regclass('public.assinatura_avisos') IS NOT NULL AS tabela,
  to_regprocedure('public.kidmais_087_aviso_guarda()') IS NOT NULL AS funcao,
  to_regclass('public.assinatura_avisos_087_um_por_evento') IS NOT NULL AS indice_unico,
  to_regclass('public.assinatura_avisos_087_fila_idx') IS NOT NULL AS indice_fila,
  to_regclass('public.assinatura_avisos_087_externo_idx') IS NOT NULL AS indice_externo,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_avisos_087_guarda' AND tgrelid=to_regclass('public.assinatura_avisos')) AS gatilho,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_avisos_087_truncate' AND tgrelid=to_regclass('public.assinatura_avisos')) AS gatilho_truncate,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT bool_and(has_table_privilege(current_user,to_regclass('public.'||t),'REFERENCES'))
    FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${REFERENCIADAS.length} AS pode_referenciar,
  session_user <> current_user AS papel_trocado`;
const OBJETOS = Object.freeze(['tabela', 'funcao', 'indice_unico', 'indice_fila', 'indice_externo', 'gatilho', 'gatilho_truncate']);

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** ausente | completa | parcial, pelos sete objetos da 087 (a migration é uma transação só). */
function lerEstado(e) {
  for (const k of ['m068', 'usuarios', ...OBJETOS, 'pode_criar', 'pode_referenciar', 'papel_trocado']) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const presentes = OBJETOS.filter(k => e[k]).length;
  return {m068: e.m068, usuarios: e.usuarios, m087: presentes === 0 ? 'ausente' : presentes === OBJETOS.length ? 'completa' : 'parcial',
    pode_criar: e.pode_criar, pode_referenciar: e.pode_referenciar, papel_trocado: e.papel_trocado};
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.m068 && s.usuarios, 'DEPENDENCIA_AUSENTE_068');
  assert.notEqual(s.m087, 'parcial', 'APLICACAO_PARCIAL_087');
  if (s.m087 === 'completa') return ['postcheck 087'];
  assert.ok(s.pode_criar && s.pode_referenciar, 'SEM_PRIVILEGIO_087 ' + (s.pode_criar ? '' : 'CREATE ') + (s.pode_referenciar ? '' : 'REFERENCES'));
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
/** Contagens informativas (sem ids): assinaturas e, com a 087 completa, avisos registrados. */
async function contagens(db, estado) {
  const sql = estado.m087 === 'completa'
    ? 'SELECT (SELECT count(*) FROM empresa_assinaturas)::int AS assinaturas, (SELECT count(*) FROM assinatura_avisos)::int AS avisos'
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
  const [nome, arquivo, hash] = r.estado.m087 === 'completa' ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.estado.m087 === 'completa' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
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
    if (nome === 'migration 087') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
      // A migration commitou no próprio arquivo: o estado precisa estar completo antes do postcheck.
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]).m087, 'completa', 'ESTADO_DEPOIS_087');
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m087, 'completa', 'ESTADO_FINAL_087');
  r.contagensDepois = await contagens(db, r.estadoDepois);
  r.resultado = r.plano.length === 1 ? 'JA_APLICADA_POSTCHECK_PASS' : 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}

/** Modo pelos argumentos: nenhum (plano), --conferir-087, ou --aplicar-087-autorizado --backup <registro>. */
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
      preRequisitos: ['068 (empresa_assinaturas, memberships, empresas) e usuarios_administrativos', '087 ausente ou completa (nunca parcial)', 'CREATE em public', 'REFERENCES em ' + REFERENCIADAS.join('/')],
      ordem: ['deploy do código (sem a 087: nenhum aviso é gravado nem enviado)', FLAG_CONFERIR, 'autorização de Felipe', FLAG_APLICAR, FLAG_CONFERIR],
      nuncaExecuta: ['down 087', 'alteração de env', 'envio de e-mail']};
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
      return {resultado: 'FALHA', marcador, falha, migracaoCommitada: ultimo.etapas?.some(x => x.nome === 'migration 087' && x.ok) === true};
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
