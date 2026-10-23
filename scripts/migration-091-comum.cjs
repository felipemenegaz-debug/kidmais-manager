/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo dos aplicadores manuais da 091 (documento fiscal CPF/CNPJ do contratante) — staging e produção
// (scripts/migration-091-staging.cjs e scripts/migration-091-production.cjs, que fixam o alvo, a identidade da conexão e
// o disco). Derivado do núcleo da 090/089: alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, estado
// ausente/completa/parcial, privilégios, marcador exclusivo no disco persistente, saída sanitizada.
// Ordem: o CÓDIGO é publicado ANTES, já com este aplicador e os SQL na árvore implantada; sem a 091 o código recusa CPF
// (CPF_INDISPONIVEL). Depois: --conferir-091 → autorização → --aplicar-091-autorizado --backup <registro> → --conferir-091 →
// só então, com autorização própria, ASSINATURA_CPF_ATIVO=true. Independente da 090.
// Conferência: somente leitura (BEGIN TRANSACTION READ ONLY em toda consulta), não grava nada no banco nem no disco.
// Aplicação: precheck (READ ONLY) → migration (transação própria do arquivo, lock_timeout 5s) → postcheck (READ ONLY) →
// prova agregada de preservação (documentos e qualificações existentes iguais antes e depois; a 091 não atualiza linhas).
// Nunca executa o down. A saída tem só nomes de etapas, booleanos, contagens e resumos md5 agregados (sem documentos).
// Privilégios avaliados como current_user (no Render a credencial entra com `SET role` do dono; lição de 14/10/2026).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const FLAG_CONFERIR = '--conferir-091';
const FLAG_APLICAR = '--aplicar-091-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-091.json';
const ETAPAS = Object.freeze([
  ['precheck 091', 'database/checks/20261022_091_precheck.sql', '40578941cc3ddd1c4a3af2d5f2405e99390ad8c8852207c94e893d22a622f3ed'],
  ['migration 091', 'database/migrations/20261022_091_documento_fiscal_contratante.sql', 'dd175ec1fb1c8db3154d9c1ec8da4efc75b98d9149bb9c35aa508ba79cf2228c'],
  ['postcheck 091', 'database/checks/20261022_091_postcheck.sql', 'dea02160f59a7a89a17283bbea25b17646bdd894a6dd4652970c896c5cb57329'],
]);
/** FKs da continuidade (D5): REFERENCES exigido nestas tabelas. Altera CHECKs das ALTERADAS (dono exigido). */
const REFERENCIADAS = Object.freeze(['empresas', 'usuarios_administrativos']);
const ALTERADAS = Object.freeze(['empresa_assinaturas', 'assinatura_fundadores', 'cadastros_empresas', 'solicitacoes_acesso_empresa', 'empresa_representacoes']);
const lista = xs => xs.map(x => `'${x}'`).join(',');
const def = nome => `coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='${nome}' AND contype='c' LIMIT 1), '')`;
/** Estado estrutural (leitura): dependências, cada objeto da 091 e privilégios. Sem dados. */
const SQL_ESTADO = `SELECT
  (to_regclass('public.empresa_assinaturas') IS NOT NULL AND to_regclass('public.empresa_representacoes') IS NOT NULL) AS m067_068,
  (to_regclass('public.cadastros_empresas') IS NOT NULL AND to_regclass('public.solicitacoes_acesso_empresa') IS NOT NULL) AS m069,
  to_regclass('public.assinatura_fundadores') IS NOT NULL AS m074a,
  to_regprocedure('public.kidmais_091_documento_valido(text)') IS NOT NULL AS funcao,
  to_regprocedure('public.kidmais_091_documento_guarda()') IS NOT NULL AS guarda,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='empresa_assinaturas_091_documento' AND tgrelid=to_regclass('public.empresa_assinaturas')) AS dv_teste,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_fundadores_091_documento' AND tgrelid=to_regclass('public.assinatura_fundadores')) AS dv_fundador,
  ${def('empresa_assinaturas_documento_teste_check')} LIKE '%[0-9]{11}|%' AS formato_teste,
  ${def('assinatura_fundadores_documento_beneficiario_check')} LIKE '%[0-9]{11}|%' AS formato_fundador,
  ${def('cadastros_empresas_documento_check')} LIKE '%[0-9]{11}|%' AS formato_cadastro,
  ${def('solicitacoes_documento_check')} LIKE '%[0-9]{11}|%' AS formato_solicitacao,
  ${def('empresa_representacoes_qualificacao_check')} LIKE '%TITULAR_PF%' AS qualificacao_pf,
  to_regclass('public.empresa_documento_continuidades') IS NOT NULL AS continuidades,
  to_regprocedure('public.kidmais_091_continuidade_guarda()') IS NOT NULL AS guarda_continuidade,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT bool_and(has_table_privilege(current_user,to_regclass('public.'||t),'REFERENCES'))
    FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${REFERENCIADAS.length} AS pode_referenciar,
  coalesce((SELECT bool_and(pg_has_role(current_user, c.relowner, 'USAGE')) FROM pg_class c
    WHERE c.oid IN (SELECT to_regclass('public.'||t) FROM unnest(ARRAY[${lista(ALTERADAS)}]) t)), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(ALTERADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${ALTERADAS.length} AS dono_alteradas,
  session_user <> current_user AS papel_trocado`;
const OBJETOS = Object.freeze(['funcao', 'guarda', 'dv_teste', 'dv_fundador', 'formato_teste', 'formato_fundador', 'formato_cadastro', 'formato_solicitacao', 'qualificacao_pf',
  'continuidades', 'guarda_continuidade']);
/** Corte lido no banco ANTES da migration: a prova compara só linhas criadas até ele (tráfego durante a janela não conta). */
const SQL_CORTE = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS corte`;
const CORTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const tx = c => `coalesce((${c})::text,'~')`;
/**
 * Resumo só das colunas IMUTÁVEIS que a 091 poderia afetar (documentos e qualificação), das linhas criadas até o corte;
 * situação, versão e decisões mudam com o tráfego e ficam fora (revisão de 22/10/2026). Só o md5 agregado sai.
 */
function SQL_PRESERVACAO(corte) {
  assert.match(String(corte), CORTE, 'CORTE_INVALIDO');
  const ate = `'${corte}'::timestamptz`;
  return `/* preservacao-091 */ SELECT
  (SELECT count(*)::int FROM empresa_assinaturas WHERE criado_em <= ${ate}) AS assinaturas,
  (SELECT coalesce(md5(string_agg(concat_ws('|', empresa_id, ${tx('documento_teste')}), ',' ORDER BY empresa_id)), 'vazio') FROM empresa_assinaturas WHERE criado_em <= ${ate}) AS resumo_assinaturas,
  (SELECT count(*)::int FROM assinatura_fundadores WHERE reservada_em <= ${ate}) AS fundadores,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, documento_beneficiario), ',' ORDER BY id)), 'vazio') FROM assinatura_fundadores WHERE reservada_em <= ${ate}) AS resumo_fundadores,
  (SELECT count(*)::int FROM cadastros_empresas WHERE criado_em <= ${ate}) AS cadastros,
  (SELECT coalesce(md5(string_agg(concat_ws('|', usuario_id, chave, documento), ',' ORDER BY usuario_id, chave)), 'vazio') FROM cadastros_empresas WHERE criado_em <= ${ate}) AS resumo_cadastros,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, usuario_id, documento), ',' ORDER BY id)), 'vazio') FROM solicitacoes_acesso_empresa WHERE criado_em <= ${ate}) AS resumo_solicitacoes,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, qualificacao), ',' ORDER BY id)), 'vazio') FROM empresa_representacoes WHERE declarado_em <= ${ate}) AS resumo_representacoes`;
}

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** ausente | completa | parcial, pelos objetos da 091 (a migration é uma transação só). */
function lerEstado(e) {
  for (const k of ['m067_068', 'm069', 'm074a', ...OBJETOS, 'pode_criar', 'pode_referenciar', 'dono_alteradas', 'papel_trocado'])
    assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const presentes = OBJETOS.filter(k => e[k]).length;
  return {m067_068: e.m067_068, m069: e.m069, m074a: e.m074a, m091: presentes === 0 ? 'ausente' : presentes === OBJETOS.length ? 'completa' : 'parcial',
    pode_criar: e.pode_criar, pode_referenciar: e.pode_referenciar, dono_alteradas: e.dono_alteradas, papel_trocado: e.papel_trocado};
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.m067_068 && s.m069 && s.m074a, 'DEPENDENCIA_AUSENTE_067_068_069_074A');
  assert.notEqual(s.m091, 'parcial', 'APLICACAO_PARCIAL_091');
  if (s.m091 === 'completa') return ['postcheck 091'];
  assert.ok(s.pode_criar && s.pode_referenciar && s.dono_alteradas, 'SEM_PRIVILEGIO_091 ' + (s.pode_criar ? '' : 'CREATE ')
    + (s.pode_referenciar ? '' : 'REFERENCES ') + (s.dono_alteradas ? '' : 'DONO'));
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
/** Contagens e resumos agregados (sem documentos); com a 091 completa, contratantes por tipo. */
async function contagens(db, estado, corte) {
  const r = {...(await somenteLeitura(db, SQL_PRESERVACAO(corte))).rows[0]};
  if (estado.m091 === 'completa') Object.assign(r, (await somenteLeitura(db, `SELECT
    (SELECT count(*) FROM empresa_assinaturas WHERE length(documento_teste) = 11)::int AS teste_cpf,
    (SELECT count(*) FROM empresa_representacoes WHERE qualificacao = 'TITULAR_PF')::int AS titulares_pf`)).rows[0]);
  return r;
}

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e o check aplicável em READ ONLY. */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = await contagens(db, r.estado, (await somenteLeitura(db, SQL_CORTE)).rows[0]?.corte);
  const [nome, arquivo, hash] = r.estado.m091 === 'completa' ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.estado.m091 === 'completa' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
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
    if (nome === 'migration 091') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
      // A migration commitou no próprio arquivo: o estado precisa estar completo antes do postcheck.
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]).m091, 'completa', 'ESTADO_DEPOIS_091');
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m091, 'completa', 'ESTADO_FINAL_091');
  r.contagensDepois = await contagens(db, r.estadoDepois, r.corte);
  // Prova agregada: nenhum documento, qualificação ou estado existente mudou (a 091 só alarga CHECKs).
  for (const k of ['assinaturas', 'resumo_assinaturas', 'fundadores', 'resumo_fundadores', 'cadastros', 'resumo_cadastros', 'resumo_solicitacoes', 'resumo_representacoes'])
    assert.equal(r.contagensDepois[k], r.contagensAntes[k], 'PRESERVACAO_DIVERGENTE ' + k);
  r.resultado = r.plano.length === 1 ? 'JA_APLICADA_POSTCHECK_PASS' : 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}

/** Modo pelos argumentos: nenhum (plano), --conferir-091, ou --aplicar-091-autorizado --backup <registro>. */
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
      preRequisitos: ['067/068/069/074a (empresa_assinaturas, empresa_representacoes, cadastros_empresas, solicitacoes_acesso_empresa, assinatura_fundadores)',
        '091 ausente ou completa (nunca parcial)', 'CREATE em public', 'REFERENCES em ' + REFERENCIADAS.join('/'), 'dono de ' + ALTERADAS.join('/')],
      ordem: ['deploy do código (sem a 091: CPF recusado com CPF_INDISPONIVEL)', FLAG_CONFERIR, 'autorização de Felipe', FLAG_APLICAR, FLAG_CONFERIR,
        'ASSINATURA_CPF_ATIVO continua desligada até revisão jurídica/fiscal e autorização própria'],
      nuncaExecuta: ['down 091', 'alteração de env (ASSINATURA_CPF_ATIVO)', 'atualização de linhas existentes', 'chamada ao Asaas']};
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
      return {resultado: 'FALHA', marcador, falha, migracaoCommitada: ultimo.etapas?.some(x => x.nome === 'migration 091' && x.ok) === true};
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
