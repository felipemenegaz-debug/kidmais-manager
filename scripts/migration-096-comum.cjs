/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo dos aplicadores manuais da 096 (comprovante da contratação e arquivo das versões dos documentos legais;
// grupo B do parecer de apoio, 22/10/2026) — staging e produção (scripts/migration-096-staging.cjs e
// scripts/migration-096-production.cjs, que fixam o alvo, a identidade da conexão e o disco). Derivado do núcleo da 091:
// alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, estado ausente/completa/parcial, privilégios, marcador
// exclusivo no disco persistente, saída sanitizada.
// Ordem: o CÓDIGO é publicado ANTES, já com este aplicador e os SQL na árvore implantada; sem a 096 a contratação segue
// sem comprovante persistido. Depois: --conferir-096 → autorização → --aplicar-096-autorizado --backup <registro> →
// --conferir-096 → só então, com autorização própria, ASSINATURA_COMPROVANTE_EMAIL=true (cópia por e-mail).
// Conferência: somente leitura (BEGIN TRANSACTION READ ONLY em toda consulta), não grava nada no banco nem no disco.
// Aplicação: precheck (READ ONLY) → migration (transação própria do arquivo, lock_timeout 5s) → postcheck (READ ONLY) →
// prova agregada de preservação (ofertas e aceites existentes iguais antes e depois; a 096 só cria tabelas novas).
// Nunca executa o down. A saída tem só nomes de etapas, booleanos, contagens e resumos md5 agregados (sem dados pessoais).
// Privilégios avaliados como current_user (no Render a credencial entra com `SET role` do dono; lição de 14/10/2026).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const FLAG_CONFERIR = '--conferir-096';
const FLAG_APLICAR = '--aplicar-096-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-096.json';
const ETAPAS = Object.freeze([
  ['precheck 096', 'database/checks/20261022_096_precheck.sql', 'ed272122f76bd66eb1d2c308928a48301f31a764f310498ae0af8ea713de332e'],
  ['migration 096', 'database/migrations/20261022_096_comprovante_contratacao.sql', 'f7481a6ee77c8fdd00797fc470e51974ce337a3a2cf8afbe7781df0621e49a98'],
  ['postcheck 096', 'database/checks/20261022_096_postcheck.sql', 'b6a829d2190d099260d3414e36ee2065d510548adc533db700cea0a188f60064'],
]);
/** FKs do comprovante: REFERENCES exigido nestas tabelas. A 096 só CRIA tabelas: nenhuma tabela existente é alterada. */
const REFERENCIADAS = Object.freeze(['assinatura_contratacoes', 'usuarios_administrativos']);
const ALTERADAS = Object.freeze([]);
const lista = xs => xs.map(x => `'${x}'`).join(',');
const def = nome => `coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='${nome}' AND contype='c' LIMIT 1), '')`;
/** Estado estrutural (leitura): dependências, cada objeto da 096 e privilégios. Sem dados. */
const SQL_ESTADO = `SELECT
  to_regclass('public.aceites_documentos_legais') IS NOT NULL AS m069,
  (to_regclass('public.assinatura_contratacoes') IS NOT NULL AND to_regclass('public.usuarios_administrativos') IS NOT NULL) AS m074a,
  to_regclass('public.documentos_legais_versoes') IS NOT NULL AS versoes,
  to_regclass('public.assinatura_comprovantes') IS NOT NULL AS comprovantes,
  to_regprocedure('public.kidmais_096_guarda()') IS NOT NULL AS guarda,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='documentos_legais_versoes_096_guarda' AND tgrelid=to_regclass('public.documentos_legais_versoes')) AS gatilho_versoes,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_comprovantes_096_guarda' AND tgrelid=to_regclass('public.assinatura_comprovantes')) AS gatilho_comprovantes,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT bool_and(has_table_privilege(current_user,to_regclass('public.'||t),'REFERENCES'))
    FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${REFERENCIADAS.length} AS pode_referenciar,
  true AS dono_alteradas,
  session_user <> current_user AS papel_trocado`;
const OBJETOS = Object.freeze(['versoes', 'comprovantes', 'guarda', 'gatilho_versoes', 'gatilho_comprovantes']);
/** Corte lido no banco ANTES da migration: a prova compara só linhas criadas até ele (tráfego durante a janela não conta). */
const SQL_CORTE = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS corte`;
const CORTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const tx = c => `coalesce((${c})::text,'~')`;
/**
 * Resumo só das colunas IMUTÁVEIS das ofertas (074a) e dos aceites (069) criados até o corte; estado e confirmação mudam
 * com o tráfego e ficam fora. A 096 só cria tabelas: nada disso pode mudar. Só o md5 agregado sai.
 */
function SQL_PRESERVACAO(corte) {
  assert.match(String(corte), CORTE, 'CORTE_INVALIDO');
  const ate = `'${corte}'::timestamptz`;
  return `/* preservacao-096 */ SELECT
  (SELECT count(*)::int FROM assinatura_contratacoes WHERE criada_em <= ${ate}) AS ofertas,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, empresa_id, plano, ciclo, valor_final_centavos, ${tx('fundador_id')}), ',' ORDER BY id)), 'vazio') FROM assinatura_contratacoes WHERE criada_em <= ${ate}) AS resumo_ofertas,
  (SELECT count(*)::int FROM aceites_documentos_legais WHERE aceito_em <= ${ate}) AS aceites,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, usuario_id, documento, versao, hash_conteudo), ',' ORDER BY id)), 'vazio') FROM aceites_documentos_legais WHERE aceito_em <= ${ate}) AS resumo_aceites`;
}

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** ausente | completa | parcial, pelos objetos da 096 (a migration é uma transação só). */
function lerEstado(e) {
  for (const k of ['m069', 'm074a', ...OBJETOS, 'pode_criar', 'pode_referenciar', 'dono_alteradas', 'papel_trocado'])
    assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const presentes = OBJETOS.filter(k => e[k]).length;
  return {m069: e.m069, m074a: e.m074a, m096: presentes === 0 ? 'ausente' : presentes === OBJETOS.length ? 'completa' : 'parcial',
    pode_criar: e.pode_criar, pode_referenciar: e.pode_referenciar, dono_alteradas: e.dono_alteradas, papel_trocado: e.papel_trocado};
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.m069 && s.m074a, 'DEPENDENCIA_AUSENTE_069_074A');
  assert.notEqual(s.m096, 'parcial', 'APLICACAO_PARCIAL_096');
  if (s.m096 === 'completa') return ['postcheck 096'];
  assert.ok(s.pode_criar && s.pode_referenciar, 'SEM_PRIVILEGIO_096 ' + (s.pode_criar ? '' : 'CREATE ') + (s.pode_referenciar ? '' : 'REFERENCES'));
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
/** Contagens e resumos agregados (sem dados pessoais); com a 096 completa, versões arquivadas e comprovantes. */
async function contagens(db, estado, corte) {
  const r = {...(await somenteLeitura(db, SQL_PRESERVACAO(corte))).rows[0]};
  if (estado.m096 === 'completa') Object.assign(r, (await somenteLeitura(db, `SELECT
    (SELECT count(*) FROM documentos_legais_versoes)::int AS versoes_arquivadas,
    (SELECT count(*) FROM assinatura_comprovantes)::int AS comprovantes`)).rows[0]);
  return r;
}

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e o check aplicável em READ ONLY. */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = await contagens(db, r.estado, (await somenteLeitura(db, SQL_CORTE)).rows[0]?.corte);
  const [nome, arquivo, hash] = r.estado.m096 === 'completa' ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.estado.m096 === 'completa' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
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
    if (nome === 'migration 096') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
      // A migration commitou no próprio arquivo: o estado precisa estar completo antes do postcheck.
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]).m096, 'completa', 'ESTADO_DEPOIS_096');
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m096, 'completa', 'ESTADO_FINAL_096');
  r.contagensDepois = await contagens(db, r.estadoDepois, r.corte);
  // Prova agregada: nenhuma oferta nem aceite existente mudou (a 096 só cria tabelas).
  for (const k of ['ofertas', 'resumo_ofertas', 'aceites', 'resumo_aceites'])
    assert.equal(r.contagensDepois[k], r.contagensAntes[k], 'PRESERVACAO_DIVERGENTE ' + k);
  r.resultado = r.plano.length === 1 ? 'JA_APLICADA_POSTCHECK_PASS' : 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}

/** Modo pelos argumentos: nenhum (plano), --conferir-096, ou --aplicar-096-autorizado --backup <registro>. */
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
      preRequisitos: ['069/074a (aceites_documentos_legais, assinatura_contratacoes, usuarios_administrativos)',
        '096 ausente ou completa (nunca parcial)', 'CREATE em public', 'REFERENCES em ' + REFERENCIADAS.join('/')],
      ordem: ['deploy do código (sem a 096: contratação sem comprovante persistido)', FLAG_CONFERIR, 'autorização de Felipe', FLAG_APLICAR, FLAG_CONFERIR,
        'ASSINATURA_COMPROVANTE_EMAIL continua desligada até autorização própria'],
      nuncaExecuta: ['down 096', 'alteração de env (ASSINATURA_COMPROVANTE_EMAIL)', 'atualização de linhas existentes', 'chamada ao Asaas', 'envio de e-mail']};
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
      return {resultado: 'FALHA', marcador, falha, migracaoCommitada: ultimo.etapas?.some(x => x.nome === 'migration 096' && x.ok) === true};
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
