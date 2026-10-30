/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 109 (renovação substituta, B-9: plano docs/PLANO_B9_PRODUCAO_PUTS_JANELA_20261029.md §3) —
// staging (scripts/migration-109-staging.cjs fixa o alvo, a identidade da conexão e o disco). Mesmo desenho dos aplicadores
// da 092–094, 100, 102/103 e 105 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador exclusivo no
// disco persistente, códigos 0/1/2/3), para UMA migration que ALTERA uma tabela com dados:
//   - a 109 altera public.assinatura_renovacoes (coluna substitui_id, constraints, índice parcial, 2 funções e os gatilhos)
//     sob ACCESS EXCLUSIVE com lock_timeout de 5 s; leituras e escritas da tabela esperam a transação (curta);
//   - estado pelo CONTRATO de integridade do cron (lib/assinatura/renovacao-schema.ts, o mesmo do cron, da renovação manual
//     e do preflight): retrato completo igual ao da 075 = pendente; igual ao da 109 = completa; qualquer outro =
//     DIVERGENTE (recusa com os nomes das divergências, nunca as definições). Nenhuma tabela de dados é lida antes do plano;
//   - corte (plano §3): o código compatível (#271) já está em TODOS os consumidores — web, cron da renovação, cron da
//     reconciliação (crn-db493i142hec73ahmoe0, que também hospeda o preflight) e as ferramentas manuais do Shell do web —,
//     com as execuções antigas drenadas; conferido no Render antes da janela, fora deste script. Aqui: nenhuma sessão
//     `kidmais-renovacao*` ativa no banco (cron, renovação manual/restrita, preflight) — é fotografia, não exclusão mútua;
//     o cron da renovação fica suspenso na janela;
//   - prazo: lock_timeout 5 s (do SQL) e statement_timeout de sessão (ORCAMENTO_DDL) em cada comando da transação do DDL;
//   - aplicação: precheck (READ ONLY) → migration SEM o COMMIT final → postcheck (retrato = 109, gerado do contrato) e a
//     capacidade '109' DENTRO da mesma transação → COMMIT só com tudo PASS → capacidade '109' de novo (READ ONLY);
//   - situação do COMMIT: falha no corpo ou nas verificações antes do COMMIT = NAO_COMMITADA (o COMMIT nunca foi
//     enviado); falha NO COMMIT = DESFEITA_PELO_SERVIDOR com SQLSTATE fora de 08/57/58/XX e diferente de 40003, senão
//     INDETERMINADO (reconciliar pela conferência); COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - toda leitura: BEGIN TRANSACTION READ ONLY, lock_timeout 5s e search_path = public, pg_catalog (o retrato fixa o
//     próprio caminho e restaura); a conferência não grava no banco nem no disco.
// Nunca executa o down. Rollback (manual, autorização própria): só SEM histórico de substituição (o down recusa); depois da
// primeira substituição, nem o down nem o código anterior voltam — a saída é corrigir para frente.
// Saída só com nomes de etapas, booleanos, a versão do servidor, nomes de divergências e contagens por estado (sem ids).
// Privilégios, avaliados como current_user (no Render a credencial entra com `SET role`), um a um:
//   sempre: USAGE em public;
//   109 pendente: ser DONO (privilégios do papel dono) de assinatura_renovacoes (ALTER TABLE, gatilhos, FK para ela mesma),
//                 CREATE em public (2 funções) e USAGE em plpgsql (funções e blocos DO do precheck/postcheck);
//   sempre: SELECT em assinatura_renovacoes (contagens por estado).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const FLAG_CONFERIR = '--conferir-109';
const FLAG_APLICAR = '--aplicar-109-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-109.json';
const ETAPAS = Object.freeze([
  ['precheck 109', 'database/checks/20261029_109_precheck.sql', 'cd5ef84f17b38fedf885c776fee7efe0b0c738aaee2a8638ab7abd0deab147d6'],
  ['migration 109', 'database/migrations/20261029_109_renovacao_substituta.sql', 'dbc47a65677fe440d2f2eea525e5e341239b3d8b03fe862c2e5885df7bc76b2c'],
  ['postcheck 109', 'database/checks/20261029_109_postcheck.sql', '6d455e7779a902ccd9e35bb85ce26d18649aae27cb068345af34b1e6f876ad2c'],
]);
/** O contrato de integridade (TypeScript) e os retratos aprovados também são conferidos por hash antes de qualquer conexão. */
const CONTRATO = Object.freeze([
  ['lib/assinatura/renovacao-schema.ts', '4ca0842277a12d79ccd59fd56542eebe81760f875b20b542cb674d817dccea94'],
  ['lib/assinatura/renovacao-schema-retratos.ts', 'b930bca1302fcf4fc6346d60a6ac170f147ae89f55126e7ee27cbd57d67757cd'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);
const PREFIXO_RENOVACAO = 'kidmais-renovacao';
/** Prazo de execução por comando na transação do DDL (staging: poucas renovações; o DDL inteiro leva milissegundos). */
const ORCAMENTO_DDL = '60s';

const REL = "to_regclass('public.assinatura_renovacoes')";
/** Estado (somente catálogo, privilégios e pg_stat_activity, sem ler nenhuma tabela de dados). */
const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (${REL} IS NOT NULL) AS tabela,
  coalesce((SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = ${REL}), false) AS dono,
  coalesce((SELECT has_table_privilege(current_user, oid, 'SELECT') FROM pg_class WHERE oid = ${REL}), false) AS ler_renovacoes,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  coalesce(has_language_privilege(current_user, 'plpgsql', 'USAGE'), false) AS plpgsql,
  (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
     AND application_name LIKE '${PREFIXO_RENOVACAO}%')::int AS sessoes_renovacao,
  (session_user <> current_user) AS papel_trocado`;

const BOOLEANOS = Object.freeze(['tabela', 'dono', 'ler_renovacoes', 'usar_public', 'pode_criar', 'plpgsql', 'papel_trocado']);
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);

/** O contrato do cron, importado da árvore conferida (ESM/TypeScript: o processo roda com --experimental-strip-types). */
async function contrato(raiz) {
  for (const [arquivo, hash] of CONTRATO) lerRevisado(raiz, arquivo, hash);
  return import(pathToFileURL(path.join(raiz, 'lib/assinatura/renovacao-schema.ts')).href);
}

/** Estado lido: catálogo + capacidade do contrato → m109 ausente (075) | completa (109) | divergente. */
function lerEstado(e, cap) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  for (const k of ['versao_pg', 'sessoes_renovacao']) assert.ok(Number.isInteger(e?.[k]) && e[k] >= 0, 'ESTADO_ILEGIVEL ' + k);
  assert.ok(['075', '109', 'INCOMPATIVEL'].includes(cap?.capacidade), 'ESTADO_ILEGIVEL capacidade');
  const s = Object.fromEntries(BOOLEANOS.map(k => [k, e[k]]));
  Object.assign(s, {versao_pg: e.versao_pg, sessoes_renovacao: e.sessoes_renovacao, capacidade: cap.capacidade});
  s.m109 = cap.capacidade === '075' ? 'ausente' : cap.capacidade === '109' ? 'completa' : 'divergente';
  if (s.m109 === 'divergente') s.divergencias = [...cap.divergencias];
  return s;
}

/** Guardas antes de qualquer leitura de dados: retrato divergente, sessões da renovação ativas e privilégios de cada caso. */
function exigirCatalogo(s) {
  assert.ok(s.tabela, 'TABELA_AUSENTE assinatura_renovacoes');
  assert.notEqual(s.m109, 'divergente', 'RETRATO_DIVERGENTE_109 ' + (s.divergencias ?? []).slice(0, 12).join(' '));
  assert.ok(s.usar_public, 'SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC');
  assert.ok(s.ler_renovacoes, 'SEM_PRIVILEGIO_LEITURA SELECT_RENOVACOES');
  if (s.m109 === 'ausente') {
    const falta = [!s.dono && 'DONO_RENOVACOES', !s.pode_criar && 'CREATE', !s.plpgsql && 'LINGUAGEM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_109 ' + falta.join(' '));
    assert.ok(s.sessoes_renovacao === 0, 'RENOVACAO_EM_EXECUCAO ' + s.sessoes_renovacao);
  }
}

/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  exigirCatalogo(s);
  return s.m109 === 'completa' ? ['capacidade 109'] : ['precheck 109', 'migration 109', 'capacidade 109'];
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
/**
 * Precheck e postcheck são arquivos SOMENTE LEITURA com a própria moldura (BEGIN TRANSACTION READ ONLY … ROLLBACK). O
 * aplicador envia só o CORPO: dentro da sua transação READ ONLY (conferência) ou da transação da migration (postcheck).
 */
function corpoSomenteLeitura(sql, nome) {
  assert.equal((sql.match(/^BEGIN TRANSACTION READ ONLY;$/gm) ?? []).length, 1, 'MOLDURA_INESPERADA ' + nome);
  assert.equal((sql.match(/^ROLLBACK;$/gm) ?? []).length, 1, 'MOLDURA_INESPERADA ' + nome);
  assert.equal((sql.match(/^(?:BEGIN;|COMMIT;|START TRANSACTION|SET TRANSACTION|SAVEPOINT|RELEASE)/gm) ?? []).length, 0, 'MOLDURA_INESPERADA ' + nome);
  const i = sql.indexOf('BEGIN TRANSACTION READ ONLY;\n');
  assert.ok(sql.endsWith('\nROLLBACK;\n') && i >= 0, 'MOLDURA_INESPERADA ' + nome);
  return sql.slice(i + 'BEGIN TRANSACTION READ ONLY;\n'.length, -'ROLLBACK;\n'.length);
}

async function somenteLeitura(db, f) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = typeof f === 'string' ? await db.query(f) : await f();
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Estado → guardas. Sem guardas (`guardar` false) só para a releitura depois de um COMMIT. */
async function estadoAtual(db, schema, {guardar = true} = {}) {
  const e = (await somenteLeitura(db, SQL_ESTADO)).rows[0];
  const s = lerEstado(e, await somenteLeitura(db, () => schema.capacidadeRenovacao(db)));
  if (guardar) exigirCatalogo(s);
  return s;
}
/** Capacidade exigida: '109' (retrato completo igual ao aprovado), na transação dada. */
async function exigirCapacidade109(schema, db) {
  const cap = await schema.capacidadeRenovacao(db);
  assert.equal(cap.capacidade, '109', 'CAPACIDADE_109 ' + cap.capacidade + (cap.divergencias ? ' ' + cap.divergencias.slice(0, 12).join(' ') : ''));
  return 'PASS';
}
/** Contagens informativas por estado (sem ids). Na 109 também os vínculos de substituição (devem ser 0 logo após aplicar). */
async function contagens(db, m109) {
  const r = await somenteLeitura(db, `SELECT estado, count(*)::int AS n FROM public.assinatura_renovacoes GROUP BY estado ORDER BY estado`);
  const porEstado = Object.fromEntries(r.rows.map(x => [x.estado, x.n]));
  const c = {total: r.rows.reduce((t, x) => t + x.n, 0), porEstado};
  if (m109 === 'completa') c.comSubstituto = (await somenteLeitura(db, 'SELECT count(*)::int AS n FROM public.assinatura_renovacoes WHERE substitui_id IS NOT NULL')).rows[0].n;
  return c;
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado, guardas, plano e, em READ ONLY, o precheck
 * (109 pendente) ou a capacidade '109' (completa), com as contagens por estado.
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  const schema = await contrato(raiz);
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = await estadoAtual(db, schema, {guardar: false});
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  const completa = r.estado.m109 === 'completa';
  r.contagens = await contagens(db, r.estado.m109);
  r.checks = {};
  const nome = completa ? 'capacidade 109' : 'precheck 109';
  try {
    if (completa) r.checks[nome] = await somenteLeitura(db, () => exigirCapacidade109(schema, db));
    else { const [, arquivo, hash] = etapa(nome); await somenteLeitura(db, corpoSomenteLeitura(lerRevisado(raiz, arquivo, hash), nome)); r.checks[nome] = 'PASS'; }
  } catch (e) { r.checks[nome] = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.resultado = completa ? 'JA_APLICADA_CAPACIDADE_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Migration sem o COMMIT final; postcheck e capacidade '109' dentro da transação; COMMIT só com tudo PASS. Registra a
 * situação do COMMIT (NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO) antes de qualquer outra leitura.
 */
async function migrarComVerificacao(db, sqls, schema, passo, registrar, orcamento = ORCAMENTO_DDL) {
  let fase = 'corpo';
  try {
    // Revisão do Astra (P3-1): o SQL fixado só traz lock_timeout. O prazo de EXECUÇÃO vale na sessão desta conexão dedicada
    // (fora de transação, antes do BEGIN do corpo) e cobre cada comando do corpo, o postcheck, a capacidade e o COMMIT:
    // estouro antes do COMMIT = NAO_COMMITADA; no COMMIT, 57014 (classe 57) = INDETERMINADO.
    passo.orcamento = orcamento;
    await db.query(`SET statement_timeout = '${orcamento}'`);
    await db.query(semCommitFinal(sqls.get('migration 109'), 'migration 109'));
    fase = 'verificacao';
    passo.antesDoCommit = {};
    await db.query(corpoSomenteLeitura(sqls.get('postcheck 109'), 'postcheck 109'));
    passo.antesDoCommit['postcheck 109'] = 'PASS';
    passo.antesDoCommit['capacidade 109'] = await exigirCapacidade109(schema, db);
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_109'); }
  } catch (e) {
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    registrar();
    await db.query('ROLLBACK').catch(() => {}); await db.query('RESET statement_timeout').catch(() => {}); throw e;
  }
  passo.commit = 'CONFIRMADO'; registrar();
  await db.query('RESET statement_timeout').catch(() => {});
}

/**
 * Aplicação, na ordem do plano: precheck (READ ONLY) → migration sem COMMIT → verificações na transação → COMMIT →
 * capacidade '109' (READ ONLY). O estado é relido aqui, imediatamente antes.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}, orcamento = ORCAMENTO_DDL}) {
  assert.match(orcamento, /^[1-9][0-9]{0,5}(ms|s)$/, 'ORCAMENTO_INVALIDO');
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  semCommitFinal(sqls.get('migration 109'), 'migration 109');
  for (const nome of ['precheck 109', 'postcheck 109']) corpoSomenteLeitura(sqls.get(nome), nome);
  const schema = await contrato(raiz);
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db, schema);
  r.plano = planoEtapas(r.estadoAntes);
  r.contagensAntes = await contagens(db, r.estadoAntes.m109);
  registrar(r);
  for (const nome of r.plano) {
    const passo = {nome, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    if (nome === 'migration 109') {
      await migrarComVerificacao(db, sqls, schema, passo, () => registrar(r), orcamento);
      assert.equal((await estadoAtual(db, schema, {guardar: false})).m109, 'completa', 'ESTADO_DEPOIS_109');
    } else if (nome === 'precheck 109') await somenteLeitura(db, corpoSomenteLeitura(sqls.get(nome), nome));
    else await somenteLeitura(db, () => exigirCapacidade109(schema, db));
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db, schema, {guardar: false});
  assert.equal(r.estadoDepois.m109, 'completa', 'ESTADO_FINAL_109');
  r.contagensDepois = await contagens(db, 'completa');
  // A 109 não toca dados: mesmas linhas por estado e nenhum vínculo de substituição recém-criado.
  assert.deepEqual(r.contagensDepois.porEstado, r.contagensAntes.porEstado, 'CONTAGENS_MUDARAM_109');
  r.resultado = r.plano.includes('migration 109') ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_CAPACIDADE_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => ['109', x.commit]));
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

/** Fábrica do aplicador de um ambiente (mesmo contrato dos aplicadores 092–105: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco). */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: [...ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
        ...CONTRATO.map(([arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome: 'contrato', arquivo, sha256: hash}; })],
      provaNoAlvo: 'postcheck (retrato = 109) e capacidade 109 DENTRO da transação da 109, antes do COMMIT; depois, a capacidade 109 (mesmo contrato do cron) em READ ONLY',
      prazos: `lock_timeout 5 s (do SQL) e statement_timeout ${ORCAMENTO_DDL} por comando na transação do DDL (estouro antes do COMMIT = NAO_COMMITADA; no COMMIT = INDETERMINADO)`,
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['109: retrato de assinatura_renovacoes IGUAL ao da 075 aprovado (capacidade 075; qualquer divergência recusa com os nomes)',
        '109: current_user com os privilégios do DONO de assinatura_renovacoes, USAGE e CREATE em public e USAGE em plpgsql',
        'código compatível (#271, 139ab9bc ou posterior) publicado em TODOS os consumidores do plano §3: web, cron da renovação, cron da reconciliação (crn-db493i142hec73ahmoe0, que também hospeda o preflight) e as ferramentas manuais (rodam no Shell do web), com execuções antigas drenadas; o código anterior QUEBRA com a 109'],
      ordem: ['conferir no Render o commit do web, do cron da renovação e do cron da reconciliação (todos com a #271; nenhuma execução antiga em andamento) e o deploy deste aplicador; conferir os hashes implantados', FLAG_CONFERIR,
        'ponto de recuperação do PostgreSQL de staging comprovado (PITR do Render disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação)',
        'autorização de Felipe para a 109 neste ambiente',
        'janela: cron da renovação SUSPENSO no Render (e nenhuma renovação manual/restrita/preflight em andamento; o aplicador recusa com sessão kidmais-renovacao* ativa); sem DDL concorrente; leituras e escritas de assinatura_renovacoes esperam a transação (ACCESS EXCLUSIVE, lock_timeout 5 s)',
        `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR,
        'reativar o cron da renovação; a execução seguinte lê a capacidade 109 (conferir no log do cron: sem saída 1)'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir; manter o cron suspenso',
        'FALHA: commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'marcador incompleto ou ilegível, processo interrompido (sem saída final) ou 109 confirmada com capacidade diferente de 109: parar, preservar saída e marcador, reconciliar pela conferência autorizada e só então decidir retomada ou restauração',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-109.<horario>.json'],
      recuperacao: ['database/rollback/20261029_109_renovacao_substituta_down.sql só com autorização própria e SEM histórico de substituição (o down recusa se houver SUBSTITUIDA ou vínculo); código compatível continua publicado',
        'depois da primeira substituição: só correção para frente (nem o down nem o código anterior voltam)',
        'em último caso, restauração PITR ao ponto registrado'],
      nuncaExecuta: ['down 109', 'alteração de env', 'deploy', 'restart', 'suspender ou reativar o cron', 'escrita em assinatura_renovacoes']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env)}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  /** `orcamento` só existe para a prova no PG descartável (estouro real); a CLI usa sempre ORCAMENTO_DDL. */
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco(), orcamento = ORCAMENTO_DDL}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of [...ETAPAS.map(([, a, h]) => [null, a, h]), ...CONTRATO.map(([a, h]) => [null, a, h])]) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-109\..+\.json$/.test(n)).sort();
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), orcamento,
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA', commits: situacoes(r), commitadas: commitadas(r)});
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        contagensAntes: r.contagensAntes, contagensDepois: r.contagensDepois, etapas: r.etapas.map(e => e.nome), commits: situacoes(r), commitadas: commitadas(r)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      const situacao = {commits: situacoes(ultimo), commitadas: commitadas(ultimo), reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir; manter o cron suspenso`};
      salvar({...ultimo, situacao: 'FALHA', falha, ...situacao});
      return {resultado: 'FALHA', marcador, falha, ...situacao};
    } finally { await db.end().catch(() => {}); }
  }
  /** Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA. */
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_CAPACIDADE_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
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

module.exports = {ETAPAS, CONTRATO, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, PREFIXO_RENOVACAO, ORCAMENTO_DDL, SQL_ESTADO, lerEstado,
  exigirCatalogo, planoEtapas, commitNaFalha, semCommitFinal, corpoSomenteLeitura, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
