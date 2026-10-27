/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 105 (canal MCP por assinatura: persistência OAuth) — staging
// (scripts/migration-105-staging.cjs fixa o alvo, a identidade da conexão e o disco). Mesmo desenho dos aplicadores da
// 092–094, da 100 e da 102/103 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador exclusivo no
// disco persistente, códigos 0/1/2/3), para UMA migration aditiva:
//   - a 105 só CRIA objetos novos (6 tabelas mcp_*, 11 índices, 1 função e 1 gatilho); não altera tabela existente.
//     As FKs para usuarios_administrativos e empresas pegam SHARE ROW EXCLUSIVE nessas duas tabelas durante a transação
//     (escritas nelas esperam no máximo o lock_timeout de 5 s da migration);
//   - estado SÓ pelo catálogo e privilégios (nenhuma tabela de dados é lida antes do plano): 105 ausente | completa |
//     parcial pelos objetos (6 tabelas, a função e o gatilho). Parcial recusa (APLICACAO_PARCIAL_105);
//   - sem trava de versão do PostgreSQL: a integridade confere contagens no catálogo e o corpo da função pelo prosrc
//     (texto da função), que não dependem do deparse da versão; a prova no próprio alvo vem na aplicação;
//   - aplicação: precheck (READ ONLY) → migration SEM o COMMIT final do arquivo → postcheck e integridade DENTRO da
//     mesma transação → COMMIT só com tudo PASS → estado completo → integridade (READ ONLY). O postcheck exige as
//     tabelas vazias e por isso só vale nessa hora; depois (conferência de uma 105 completa) só a integridade, que é
//     só catálogo e repetível;
//   - situação do COMMIT: falha no corpo ou nas verificações antes do COMMIT = NAO_COMMITADA (o COMMIT nunca foi
//     enviado); falha NO COMMIT = DESFEITA_PELO_SERVIDOR com SQLSTATE fora de 08/57/58/XX e diferente de 40003, senão
//     INDETERMINADO (reconciliar pela conferência); COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - toda leitura: BEGIN TRANSACTION READ ONLY, lock_timeout 5s e search_path = public, pg_catalog; a conferência não
//     grava no banco nem no disco.
// Ordem: o CÓDIGO com este aplicador, a integridade e os SQL é publicado ANTES (a #252 já publicou a migration e o
// código do canal, que funciona sem a 105: rotas 503 e persistência falha fechada). Depois: --conferir-105 → ponto de
// recuperação comprovado e registrado → autorização → janela sem DDL concorrente → --conferir-105 de novo →
// --aplicar-105-autorizado --backup <registro> → --conferir-105. Aplicar a 105 NÃO liga o canal (MCP_ENABLED continua
// desligado; ligar é passo separado, com autorização própria).
// Nunca executa o down (rollback manual, autorização própria). Saída só com nomes de etapas, booleanos, a versão do
// servidor e contagens (sem ids, nomes, tokens ou URL do banco).
// Privilégios, avaliados como current_user (no Render a credencial entra com `SET role`; lição de 14/10/2026), um a um:
//   sempre: USAGE em public;
//   105 pendente: CREATE em public, REFERENCES em usuarios_administrativos e empresas (FKs), USAGE em plpgsql (função e
//           blocos DO do precheck/postcheck) e EXECUTE em gen_random_uuid() (DEFAULT das chaves);
//   105 completa: SELECT nas 6 tabelas mcp_* (contagens) — a integridade só lê o catálogo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const FLAG_CONFERIR = '--conferir-105';
const FLAG_APLICAR = '--aplicar-105-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-105.json';
const ETAPAS = Object.freeze([
  ['precheck 105', 'database/checks/20261027_105_precheck.sql', 'b18e92228586409aad55c0966ca95fadc510dac411a59569d1f5e68e39c194d1'],
  ['migration 105', 'database/migrations/20261027_105_mcp_assinaturas.sql', 'e1ddedd8d18e82e88b37fbea7620dac310f4affdaf65ef053cda0c5394dbfb2c'],
  ['postcheck 105', 'database/checks/20261027_105_postcheck.sql', '97d49a638b830c3d0d59db1371754dbc4913217e3becd301420056e10c8290d3'],
  ['integridade 105', 'database/checks/20261027_105_integridade.sql', 'eccd6bf66c47235063228074f0b2b93c685406f828483f0b6b6ec527b67209b2'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);
/** Verificações dentro da transação da migration, antes do COMMIT. Depois do COMMIT (e numa 105 completa) só a integridade. */
const VERIFICACOES_NA_TRANSACAO = Object.freeze(['postcheck 105', 'integridade 105']);

const reg = t => `to_regclass('public.${t}')`;
const TABELAS_105 = Object.freeze(['mcp_oauth_clientes', 'mcp_oauth_pedidos', 'mcp_oauth_concessoes', 'mcp_oauth_codigos', 'mcp_oauth_tokens', 'mcp_auditoria']);
const FUNCAO_105 = 'mcp_oauth_concessao_revogacao_imutavel';
const GATILHO_105 = 'mcp_oauth_concessoes_revogacao_imutavel';
const tabela = (t, privilegio) => `coalesce((SELECT has_table_privilege(current_user, oid, '${privilegio}') FROM pg_class WHERE oid = ${reg(t)}), false)`;

/** Estado (somente catálogo e privilégios, sem ler nenhuma tabela de dados). */
const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (${reg('usuarios_administrativos')} IS NOT NULL AND ${reg('empresas')} IS NOT NULL AND ${reg('memberships')} IS NOT NULL
    AND to_regprocedure('gen_random_uuid()') IS NOT NULL) AS d105,
  (${TABELAS_105.map(t => `(${reg(t)} IS NOT NULL)::int`).join(' + ')})::int AS m105_tabelas,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${FUNCAO_105}')::int AS m105_funcao,
  (SELECT count(*) FROM pg_trigger WHERE tgname = '${GATILHO_105}' AND NOT tgisinternal)::int AS m105_gatilho,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  (${tabela('usuarios_administrativos', 'REFERENCES')} AND ${tabela('empresas', 'REFERENCES')}) AS referencias_105,
  coalesce(has_language_privilege(current_user, 'plpgsql', 'USAGE'), false) AS plpgsql,
  coalesce((SELECT has_function_privilege(current_user, to_regprocedure('gen_random_uuid()'), 'EXECUTE') WHERE to_regprocedure('gen_random_uuid()') IS NOT NULL), false) AS gerar_uuid,
  ${TABELAS_105.map(t => tabela(t, 'SELECT')).join(' AND ')} AS ler_105,
  (session_user <> current_user) AS papel_trocado`;

const BOOLEANOS = Object.freeze(['d105', 'usar_public', 'pode_criar', 'referencias_105', 'plpgsql', 'gerar_uuid', 'ler_105', 'papel_trocado']);
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** Estado lido: m105 ausente/completa/parcial pelos objetos. */
function lerEstado(e) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  for (const k of ['versao_pg', 'm105_tabelas', 'm105_funcao', 'm105_gatilho']) assert.ok(Number.isInteger(e?.[k]) && e[k] >= 0, 'ESTADO_ILEGIVEL ' + k);
  const s = Object.fromEntries(BOOLEANOS.map(k => [k, e[k]]));
  s.versao_pg = e.versao_pg;
  const presentes = e.m105_tabelas + e.m105_funcao + e.m105_gatilho;
  s.m105 = presentes === 0 ? 'ausente' : e.m105_tabelas === TABELAS_105.length && e.m105_funcao === 1 && e.m105_gatilho === 1 ? 'completa' : 'parcial';
  return s;
}

/** Guardas antes de qualquer leitura de dados: 105 parcial, dependências e privilégios de cada caso. */
function exigirCatalogo(s) {
  assert.notEqual(s.m105, 'parcial', 'APLICACAO_PARCIAL_105');
  assert.ok(s.usar_public, 'SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC');
  if (s.m105 === 'ausente') {
    assert.ok(s.d105, 'DEPENDENCIA_AUSENTE_105 (usuarios_administrativos, empresas, memberships, gen_random_uuid)');
    const falta = [!s.pode_criar && 'CREATE', !s.referencias_105 && 'REFERENCES', !s.plpgsql && 'LINGUAGEM', !s.gerar_uuid && 'GEN_RANDOM_UUID'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_105 ' + falta.join(' '));
  } else assert.ok(s.ler_105, 'SEM_PRIVILEGIO_105 SELECT_TABELAS');
}

/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  exigirCatalogo(s);
  return s.m105 === 'completa' ? ['integridade 105'] : ['precheck 105', 'migration 105', 'integridade 105'];
}

/**
 * Situação do COMMIT quando o PRÓPRIO COMMIT falha (o corpo já rodou): com SQLSTATE fora das classes 08/57/58/XX e
 * diferente de 40003, o servidor recusou e desfez; sem SQLSTATE, nessas classes ou 40003, INDETERMINADO.
 */
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
/** Estado → guardas. Sem guardas (`guardar` false) só para a releitura depois de um COMMIT. */
async function estadoAtual(db, {guardar = true} = {}) {
  const s = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  if (guardar) exigirCatalogo(s);
  return s;
}
/** Uma verificação: a integridade exige integra_105 = true; precheck/postcheck são blocos que recusam com exceção. */
async function verificar(executar, nome, sql) {
  const r = await executar(sql);
  if (nome === 'integridade 105') assert.equal(r.rows?.[0]?.integra_105, true, 'INTEGRIDADE_105 ' + String(r.rows?.[0]?.integra_105));
  return 'PASS';
}
/** Contagens informativas (sem ids), só com a 105 completa: clientes, concessões (ativas), tokens e auditoria. */
async function contagens(db) {
  return (await somenteLeitura(db, `SELECT (SELECT count(*) FROM public.mcp_oauth_clientes)::int AS clientes,
    (SELECT count(*) FROM public.mcp_oauth_concessoes)::int AS concessoes,
    (SELECT count(*) FROM public.mcp_oauth_concessoes WHERE revogada_em IS NULL)::int AS concessoes_ativas,
    (SELECT count(*) FROM public.mcp_oauth_tokens)::int AS tokens, (SELECT count(*) FROM public.mcp_auditoria)::int AS auditoria`)).rows[0];
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado, guardas, plano e, em READ ONLY, o precheck
 * (105 ausente) ou a integridade (105 completa, com as contagens).
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  const completa = r.estado.m105 === 'completa';
  if (completa) r.contagens = await contagens(db);
  const nome = completa ? 'integridade 105' : 'precheck 105';
  const [, arquivo, hash] = etapa(nome);
  r.checks = {};
  try { r.checks[nome] = await verificar(sql => somenteLeitura(db, sql), nome, lerRevisado(raiz, arquivo, hash)); }
  catch (e) { r.checks[nome] = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.resultado = completa ? 'JA_APLICADA_INTEGRIDADE_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Migration sem o COMMIT final; postcheck e integridade dentro da transação; COMMIT só com tudo PASS. Registra a
 * situação do COMMIT (NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO) antes de qualquer outra leitura.
 */
async function migrarComVerificacao(db, sqls, passo, registrar) {
  let fase = 'corpo';
  try {
    await db.query(semCommitFinal(sqls.get('migration 105'), 'migration 105'));
    fase = 'verificacao';
    passo.antesDoCommit = {};
    for (const nome of VERIFICACOES_NA_TRANSACAO) passo.antesDoCommit[nome] = await verificar(sql => db.query(sql), nome, sqls.get(nome));
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_105'); }
  } catch (e) {
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    registrar();
    await db.query('ROLLBACK').catch(() => {}); throw e;
  }
  passo.commit = 'CONFIRMADO'; registrar();
}

/**
 * Aplicação, na ordem do plano: precheck (READ ONLY) → migration sem COMMIT → verificações na transação → COMMIT →
 * estado completo → integridade (READ ONLY). O estado é relido aqui, imediatamente antes.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  semCommitFinal(sqls.get('migration 105'), 'migration 105');
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.plano = planoEtapas(r.estadoAntes);
  if (r.estadoAntes.m105 === 'completa') r.contagensAntes = await contagens(db);
  registrar(r);
  for (const nome of r.plano) {
    const passo = {nome, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    if (nome === 'migration 105') {
      await migrarComVerificacao(db, sqls, passo, () => registrar(r));
      assert.equal((await estadoAtual(db, {guardar: false})).m105, 'completa', 'ESTADO_DEPOIS_105');
    } else await verificar(sql => somenteLeitura(db, sql), nome, sqls.get(nome));
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db, {guardar: false});
  assert.equal(r.estadoDepois.m105, 'completa', 'ESTADO_FINAL_105');
  r.contagensDepois = await contagens(db);
  r.resultado = r.plano.includes('migration 105') ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_INTEGRIDADE_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => ['105', x.commit]));
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

/** Fábrica do aplicador de um ambiente (mesmo contrato da 092–094, 100 e 102/103: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco). */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      provaNoAlvo: 'postcheck e integridade DENTRO da transação da 105, antes do COMMIT; depois, a integridade (só catálogo) em READ ONLY',
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['105: usuarios_administrativos, empresas e memberships presentes e gen_random_uuid() disponível; nenhum objeto da 105 (parcial recusa)',
        '105: current_user com USAGE e CREATE em public, REFERENCES em usuarios_administrativos e empresas, USAGE em plpgsql e EXECUTE em gen_random_uuid()',
        'o código do canal (#252/#253) já está publicado e funciona sem a 105 (rotas 503, persistência falha fechada); aplicar a 105 NÃO liga o canal'],
      ordem: ['deploy do código com este aplicador e os SQL; conferir commit e hashes implantados', FLAG_CONFERIR,
        'ponto de recuperação do PostgreSQL de staging comprovado (PITR do Render disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação)',
        'autorização de Felipe para a 105 neste ambiente',
        'janela combinada: sem DDL concorrente; escritas em usuarios_administrativos e empresas podem esperar até 5 s (SHARE ROW EXCLUSIVE das FKs durante a transação)',
        `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR,
        'ligar o canal (MCP_ENABLED, MCP_TENANT_ALLOWLIST, MCP_PUBLIC_URL, MCP_REF_SECRET) é passo SEPARADO, com autorização própria'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'marcador incompleto ou ilegível, processo interrompido (sem saída final) ou 105 confirmada com integridade falha: parar, preservar saída e marcador, reconciliar pela conferência autorizada e só então decidir retomada ou restauração',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-105.<horario>.json'],
      recuperacao: ['database/rollback/20261027_105_mcp_assinaturas_down.sql só com autorização própria (recusa se houver concessão ou auditoria; o canal se desliga por MCP_ENABLED=false, sem apagar nada)',
        'em último caso, restauração PITR ao ponto registrado'],
      nuncaExecuta: ['down 105', 'alteração de env (inclusive MCP_ENABLED)', 'deploy', 'restart', 'escrita nas tabelas mcp_*']};
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
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-105\..+\.json$/.test(n)).sort();
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
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
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

module.exports = {ETAPAS, VERIFICACOES_NA_TRANSACAO, TABELAS_105, FUNCAO_105, GATILHO_105, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR,
  SQL_ESTADO, lerEstado, exigirCatalogo, planoEtapas, commitNaFalha, semCommitFinal, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
