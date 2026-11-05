/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador da 105 (canal MCP por assinatura: persistência OAuth) para PRODUÇÃO. Plano MCP produção
// pré-requisitos, rev. 3, item P1. O alvo, o TLS, a identidade (papel) e o disco ficam no adaptador
// (scripts/migration-105-production.cjs). Reaproveita do núcleo de staging (scripts/migration-105-comum.cjs) só o que é
// leitura pura: hashes dos 4 SQL, SQL_ESTADO/lerEstado/exigirCatalogo (catálogo e privilégios de current_user) e
// commitNaFalha (40003 = INDETERMINADO, núcleo F-1). Diferenças em relação ao staging, todas pedidas pelo plano:
//   - CONFERIR (somente leitura, nada no banco nem no disco) com cinco estados: PRONTA_PARA_APLICAR e
//     JA_APLICADA_INTEGRIDADE_PASS (código 0); DIVERGENTE, PARCIAL e FALHA_DE_CONFERENCIA (código 3: parar e analisar);
//   - integridade REFORÇADA por definições (database/checks/20261029_105_definicoes.sql + scripts/migration-105-definicoes.cjs)
//     além da integridade antiga (contagens e nomes), na conferência e na aplicação;
//   - APLICAR numa ÚNICA transação: trava consultiva, estado relido com as guardas, precheck, DDL (o arquivo sem o
//     BEGIN e sem o COMMIT finais), postcheck, integridade, definições e estado completo, tudo ANTES do COMMIT;
//   - marcador: o estado do COMMIT fica em memória (`ultimo`) e é a fonte da saída. Gravação atômica (arquivo .tmp +
//     rename). Depois de conectar, falha de gravação nunca vira recusa (1): FALHA (2) se o marcador registrou a falha,
//     FALHA_MARCADOR_DESATUALIZADO (5) se não registrou, sempre com o estado do COMMIT na saída;
//   - PITR como gate operacional: --backup exige "PITR <AAAA-MM-DDTHH:MMZ> <referência>" conferido há no máximo 120 min
//     (Felipe conferiu no painel do Render que o ponto de restauração cobre o instante da aplicação); o marcador guarda;
//   - nunca executa o down (rollback só ANTES do piloto, autorização própria; depois de uso real: MCP_ENABLED=false e
//     tabelas preservadas). Aplicar a 105 NÃO liga o canal.
// Códigos: 0 PLANO/PRONTA/JA_APLICADA/APLICADA_POSTCHECK_PASS; 1 RECUSADO antes de conectar (lançado); 2 FALHA depois de
// conectar, registrada no marcador; 3 conferência que para (DIVERGENTE/PARCIAL/FALHA_DE_CONFERENCIA); 5 FALHA com o
// marcador DESATUALIZADO (a saída é o único registro do COMMIT). O 4 é reservado à recusa do próprio bloco de Shell.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const comum = require('./migration-105-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const {ESPERADO, SET_DEPARSE, compararDefinicoes} = require('./migration-105-definicoes.cjs');

const {FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, SQL_ESTADO, lerEstado, exigirCatalogo, commitNaFalha} = comum;
const ETAPAS = Object.freeze([...comum.ETAPAS,
  ['definicoes 105', 'database/checks/20261029_105_definicoes.sql', '6d044c5275dffe080982323955a75f7d3cc1beece63b47995c34fe235a083778']]);
/** Chave da trava consultiva da aplicação (só esta aplicação a usa; outra sessão com ela = aplicação concorrente). */
const TRAVA = 1052029;
const PITR = /^PITR (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z) ([A-Za-z0-9:._/ -]{3,80})$/;
const PITR_IDADE_MAXIMA_MIN = 120, PITR_FUTURO_MAXIMO_MIN = 5;
const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0, APLICADA_POSTCHECK_PASS: 0,
  FALHA: 2, DIVERGENTE: 3, PARCIAL: 3, FALHA_DE_CONFERENCIA: 3, FALHA_MARCADOR_DESATUALIZADO: 5});
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);
const sqlsRevisados = raiz => new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));

/** O arquivo revisado sem o BEGIN e sem o COMMIT finais: o corpo entra na transação única do aplicador. */
function corpoDaMigration(sql) {
  const semCommit = comum.semCommitFinal(sql, 'migration 105');
  assert.equal((semCommit.match(/^BEGIN;\n/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA migration 105');
  return semCommit.replace(/^BEGIN;\n/m, '');
}

/** PITR conferido por Felipe no painel (gate operacional): formato, horário UTC válido, recente e não no futuro. */
function lerPitr(backup, agora = Date.now()) {
  const m = PITR.exec(String(backup ?? ''));
  assert.ok(m, 'PITR_REFERENCIA_INVALIDA use "PITR <AAAA-MM-DDTHH:MMZ> <referencia>"');
  const t = Date.parse(m[1].replace('Z', ':00Z'));
  assert.ok(Number.isFinite(t) && new Date(t).toISOString().slice(0, 16) + 'Z' === m[1], 'PITR_HORARIO_INVALIDO');
  assert.ok(t <= agora + PITR_FUTURO_MAXIMO_MIN * 60000, 'PITR_CONFERENCIA_NO_FUTURO');
  assert.ok(t >= agora - PITR_IDADE_MAXIMA_MIN * 60000, 'PITR_CONFERENCIA_ANTIGA conferir de novo no painel do Render');
  return {referencia: m[0], conferidoEm: new Date(t).toISOString(),
    gate: 'Felipe conferiu no painel do Render que o ponto de restauração cobre o instante da aplicação (a referência textual sozinha não comprova PITR)'};
}

function modo(argv, agora = Date.now()) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === FLAG_BACKUP) return {modo: 'aplicar', backup: argv[2], pitr: lerPitr(argv[2], agora)};
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

/** Uma transação READ ONLY com lock_timeout, statement_timeout e search_path fixos; `corpo(q)` faz as consultas. */
async function emLeitura(db, corpo) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = await corpo(sql => db.query(sql));
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Integridade antiga (contagens/nomes) e definições, na transação corrente. Devolve {antiga, definicoes}. */
async function integridadeCompleta(q, sqls) {
  const antiga = (await q(sqls.get('integridade 105'))).rows?.[0]?.integra_105 === true;
  for (const s of SET_DEPARSE) await q(s);
  const definicoes = compararDefinicoes((await q(sqls.get('definicoes 105'))).rows);
  return {antiga, definicoes};
}
const integra = i => i.antiga && i.definicoes.integra;
const resumo = i => ({integridade: i.antiga ? 'PASS' : 'FALHOU', definicoes: i.definicoes.integra ? 'PASS' : 'FALHOU',
  definicoesLidas: i.definicoes.total, definicoesEsperadas: i.definicoes.esperado, divergencias: i.definicoes.divergencias.slice(0, 40)});

/** Contagens informativas (sem ids), só com a 105 completa. */
const SQL_CONTAGENS = `SELECT (SELECT count(*) FROM public.mcp_oauth_clientes)::int AS clientes,
  (SELECT count(*) FROM public.mcp_oauth_concessoes)::int AS concessoes,
  (SELECT count(*) FROM public.mcp_oauth_concessoes WHERE revogada_em IS NULL)::int AS concessoes_ativas,
  (SELECT count(*) FROM public.mcp_oauth_tokens)::int AS tokens, (SELECT count(*) FROM public.mcp_auditoria)::int AS auditoria`;

/**
 * Conferência somente leitura. Nunca lança: qualquer erro (conexão, identidade, consulta, guarda) vira
 * FALHA_DE_CONFERENCIA com o motivo curto.
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  try {
    const sqls = sqlsRevisados(raiz);
    r.conexao = identidade((await emLeitura(db, q => q(sqlIdentidade))).rows[0]);
    r.estado = lerEstado((await emLeitura(db, q => q(SQL_ESTADO))).rows[0]);
    if (r.estado.m105 === 'parcial') return {...r, resultado: 'PARCIAL', motivo: 'APLICACAO_PARCIAL_105'};
    exigirCatalogo(r.estado);
    if (r.estado.m105 === 'ausente') {
      // Com a 105 ausente, o inventário só pode trazer a linha do public.gen_random_uuid(): ausente ou o pgcrypto
      // genuíno. Um homônimo seria resolvido pelo DEFAULT das chaves na aplicação (revisão do Astra, rodada 1, P2-2).
      const uuid = await emLeitura(db, async q => {
        await q(sqls.get('precheck 105'));
        for (const s of SET_DEPARSE) await q(s);
        return (await q(sqls.get('definicoes 105'))).rows;
      });
      const linhaUuid = Array.isArray(uuid) && uuid.length === 1 ? uuid[0] : null;
      assert.ok(linhaUuid?.chave === 'uuid_publico:gen_random_uuid()' && [ESPERADO[linhaUuid.chave]].flat().includes(linhaUuid.definicao),
        'UUID_PUBLICO_HOMONIMO (public.gen_random_uuid() não é o pgcrypto genuíno, ou há objeto da 105 fora do estado)');
      return {...r, checks: {'precheck 105': 'PASS', 'uuid publico': linhaUuid.definicao === 'ausente' ? 'AUSENTE' : 'PGCRYPTO'}, resultado: 'PRONTA_PARA_APLICAR'};
    }
    const i = await emLeitura(db, async q => ({...await integridadeCompleta(q, sqls), contagens: (await q(SQL_CONTAGENS)).rows[0]}));
    r.contagens = i.contagens; r.checks = resumo(i);
    return {...r, resultado: integra(i) ? 'JA_APLICADA_INTEGRIDADE_PASS' : 'DIVERGENTE'};
  } catch (e) { return {...r, resultado: 'FALHA_DE_CONFERENCIA', motivo: curta(e)}; }
}

/**
 * A transação ÚNICA da aplicação. Situação do COMMIT em `passo.commit`: NAO_COMMITADA (o COMMIT nunca foi enviado) |
 * CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO. `registrar` grava o marcador e pode lançar (disco): antes do
 * COMMIT isso desfaz a transação (nada é confirmado sem o marcador saber); depois do COMMIT a falha sobe com o estado
 * já guardado em memória.
 */
async function transacaoUnica(db, sqls, passo, registrar) {
  let fase = 'verificacao';
  passo.antesDoCommit = {};
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    assert.equal((await db.query(`SELECT pg_try_advisory_xact_lock(${TRAVA}) AS ok`)).rows?.[0]?.ok, true, 'APLICACAO_CONCORRENTE_105');
    const s = lerEstado((await db.query(SQL_ESTADO)).rows[0]);
    exigirCatalogo(s);
    assert.equal(s.m105, 'ausente', 'ESTADO_MUDOU_105 ' + s.m105);
    await db.query(sqls.get('precheck 105')); passo.antesDoCommit['precheck 105'] = 'PASS';
    fase = 'corpo';
    await db.query(corpoDaMigration(sqls.get('migration 105')));
    fase = 'verificacao';
    await db.query(sqls.get('postcheck 105')); passo.antesDoCommit['postcheck 105'] = 'PASS';
    const i = await integridadeCompleta(q => db.query(q), sqls);
    Object.assign(passo.antesDoCommit, resumo(i));
    assert.ok(integra(i), 'INTEGRIDADE_105_ANTES_DO_COMMIT');
    await db.query('SET LOCAL search_path = public, pg_catalog');
    assert.equal(lerEstado((await db.query(SQL_ESTADO)).rows[0]).m105, 'completa', 'ESTADO_ANTES_DO_COMMIT_105');
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_105'); }
  } catch (e) {
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    if (fase !== 'commit') await db.query('ROLLBACK').catch(() => {});
    try { registrar(); } catch { /* o estado do COMMIT segue em memória; a saída o informa */ }
    throw e;
  }
  passo.commit = 'CONFIRMADO';
  registrar();
}

/** Aplicação: identidade → estado (guardas, antes de qualquer escrita) → transação única → conferência depois do COMMIT. */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}}) {
  const sqls = sqlsRevisados(raiz);
  corpoDaMigration(sqls.get('migration 105'));
  const r = {etapas: []};
  r.conexao = identidade((await emLeitura(db, q => q(sqlIdentidade))).rows[0]); registrar(r);
  r.estadoAntes = lerEstado((await emLeitura(db, q => q(SQL_ESTADO))).rows[0]); registrar(r);
  exigirCatalogo(r.estadoAntes);
  if (r.estadoAntes.m105 === 'completa') {
    const c = await conferirNoCliente(db, {raiz, sqlIdentidade, identidade});
    r.conferencia = {resultado: c.resultado, checks: c.checks, motivo: c.motivo}; registrar(r);
    assert.equal(c.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', 'JA_APLICADA_SEM_INTEGRIDADE_105 ' + c.resultado);
    r.resultado = 'JA_APLICADA_INTEGRIDADE_PASS'; registrar(r);
    return r;
  }
  const passo = {nome: 'transacao 105', inicio: new Date().toISOString()};
  r.etapas.push(passo); registrar(r);
  await transacaoUnica(db, sqls, passo, () => registrar(r));
  Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  const depois = await conferirNoCliente(db, {raiz, sqlIdentidade, identidade});
  r.conferenciaDepois = {resultado: depois.resultado, checks: depois.checks, motivo: depois.motivo}; r.contagensDepois = depois.contagens;
  registrar(r);
  assert.equal(depois.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', 'CONFERENCIA_DEPOIS_DO_COMMIT_105 ' + depois.resultado);
  r.resultado = 'APLICADA_POSTCHECK_PASS'; registrar(r);
  return r;
}
const commitDe = r => r?.etapas?.find(e => e.commit)?.commit ?? 'SEM_TRANSACAO';

/** Fábrica do aplicador de produção: amb = {nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco, ordem}. */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      definicoesEsperadas: Object.keys(ESPERADO).length,
      provaNoAlvo: 'uma transação: trava, estado, precheck, DDL, postcheck, integridade, definições e estado completo ANTES do COMMIT; depois, CONFERIR em READ ONLY',
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} "PITR <AAAA-MM-DDTHH:MMZ> <referencia>"`}, registro: amb.DIR,
      estadosDaConferencia: {PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0, DIVERGENTE: 3, PARCIAL: 3, FALHA_DE_CONFERENCIA: 3},
      ordem: amb.ordem,
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'DIVERGENTE, PARCIAL ou FALHA_DE_CONFERENCIA (3): parar e pedir análise; nada é corrigido pelo aplicador',
        'FALHA (2) ou FALHA_MARCADOR_DESATUALIZADO (5): commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO (inclusive 40003) = CONFERIR antes de decidir',
        'código 5: a saída é o ÚNICO registro do COMMIT; copiá-la antes de qualquer outra coisa; o marcador antigo continua no disco e impede a repetição',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-105.<horario>.json'],
      recuperacao: ['down (database/rollback/20261027_105_mcp_assinaturas_down.sql) SÓ ANTES DO PILOTO, com autorização própria; ele recusa com concessão ou auditoria',
        'depois de uso real: MCP_ENABLED=false + deploy, tabelas PRESERVADAS',
        'em último caso, restauração PITR ao ponto registrado no marcador'],
      nuncaExecuta: ['down 105', 'alteração de env (inclusive MCP_ENABLED)', 'deploy', 'restart', 'escrita nas tabelas mcp_*']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      try { await db.connect(); } catch (e) { return {modo: 'conferencia', resultado: 'FALHA_DE_CONFERENCIA', motivo: 'CONEXAO ' + curta(e)}; }
      return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env)});
    } finally { await db.end().catch(() => {}); }
  }
  /** `escrever`/`renomear` existem para os testes de disco (ENOSPC); a CLI usa sempre o fs. */
  async function executar({env, backup, pitr, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco(),
    escrever = fs.writeFileSync, renomear = fs.renameSync, agora = Date.now()}) {
    const opts = amb.alvo(env); disco();
    const gate = pitr ?? lerPitr(backup, agora);
    sqlsRevisados(raiz);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-105\..+\.json$/.test(n)).sort();
    const registro = {inicio: new Date(agora).toISOString(), ambiente: amb.nome, backup, pitr: gate, situacao: 'INICIADA', tentativasAnteriores: anteriores};
    try { escrever(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => { const tmp = marcador + '.tmp'; escrever(tmp, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600}); renomear(tmp, marcador); };
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env),
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA', commit: commitDe(r)});
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, conferenciaDepois: r.conferenciaDepois ?? r.conferencia,
        contagensDepois: r.contagensDepois, etapas: r.etapas.map(e => e.nome), commit: commitDe(r), pitr: gate};
    } catch (e) {
      // Já conectou: o estado do COMMIT vem da memória (`ultimo`), nunca do disco. Parecer B-3 (P2) e plano P1 (P2-4).
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? (ultimo.conexao ? 'ESTADO' : 'CONEXAO'), mensagem: curta(e)};
      const situacao = {commit: commitDe(ultimo), reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir`};
      try { salvar({...ultimo, situacao: 'FALHA', falha, ...situacao}); }
      catch (e2) {
        return {resultado: 'FALHA_MARCADOR_DESATUALIZADO', marcador, falha, ...situacao, marcadorAtualizado: false, erroMarcador: curta(e2),
          aviso: 'MARCADOR_DESATUALIZADO: esta saída é o único registro do COMMIT; copiá-la; não repetir'};
      }
      return {resultado: 'FALHA', marcador, falha, ...situacao, marcadorAtualizado: true};
    } finally { await db.end().catch(() => {}); }
  }
  async function principal(argv, env, deps = {}) {
    const m = modo(argv, deps.agora ?? Date.now());
    if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
    const s = m.modo === 'conferir' ? await conferir({env, ...deps}) : await executar({env, backup: m.backup, pitr: m.pitr, ...deps});
    return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
  }
  function cli() {
    principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
      (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
    }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
  }
  return {plano, conferir, executar, principal, cli, CODIGO};
}

module.exports = {ETAPAS, TRAVA, CODIGO, PITR_IDADE_MAXIMA_MIN, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR,
  corpoDaMigration, lerPitr, modo, conferirNoCliente, aplicarNoCliente, transacaoUnica, criarAplicador};
