/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
// Registro de migrations no banco (vault "Registro de migrations no banco 20261120", plano r15 + 7 pontos da r15 corrigidos
// no código). Substitui o marcador migration-<id>.json do disco (os discos dos webs saíram em 20/11) pela tabela
// operacao_migration_tentativas (migration 129). Sem disco: nada aqui confere o disco.
//
// Escopo de ids (§3.0): legados 060–128 ficam com o CONFERIR que já têm (fora deste módulo); 129 só pelo bootstrap
// (--aplicar-129-bootstrap-autorizado); 130+ pela lista fechada ORDEM. A 129 é aceita, além do bootstrap, só em
// --conferir-tentativa, --concluir-verificacao e --arquivar-tentativa (que recusa com LINHA_129_NAO_ARQUIVA).
//
//   node scripts/registro-migrations-banco.cjs --ambiente <production|staging> <modo>
//     --conferir-registro [--tentativa <uuid>]… [--ids 130,131]   diagnóstico, sessões de leitura (aceita tabela ausente)
//     --conferir-tentativa <id> --tentativa <uuid>                 reconciliação de um uuid impresso (sessão de leitura)
//     --conferir-<id>                                              linha ativa, trava, estado, classificação e antecessora
//     --aplicar-<id>-autorizado --backup "<registro>"              130+: reserva, corpo e conclusão numa conexão só (C)
//     --aplicar-135-autorizado --backup "<registro>" --portao-135 "<registro da conferência do deploy>"   a 135 exige o portão
//     --aplicar-129-bootstrap-autorizado --backup "<registro>"     bootstrap da 129 (antecessoras pelo conferir-antecessoras)
//     --arquivar-tentativa <id> --tentativa <uuid> --motivo "<texto>"   com decisão de Felipe no vault citando o uuid
//     --concluir-verificacao <id> --tentativa <uuid>                     idem
// Códigos: 0 sem anomalia (nunca libera nada sozinho); 1 recusa/erro de verificação; 2 não conclusivo ou falha registrada;
// 3 pendência ou divergência que pede decisão. Cada escrita imprime REGISTRO_TENTATIVA … (copiar a saída inteira no vault).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const gen = require('./migration-generico-production.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const {commitNaFalha} = require('./migration-118-comum.cjs');
const prd = require('./conexao-production.cjs');
const stg = require('./conexao-staging.cjs');
const s116 = require('./migration-116-staging.cjs');

const ORDEM = Object.freeze(['130', '131', '132', '133', '134', '135']);
// 132 (Wall-e 1a) e 133 (agenda) são independentes entre si: as duas têm a 131 como antecessora no registro; a 134 segue a 133.
// A 135 (Wall-e 3b) depende da 060 (legada, fora do registro, conferida pelo precheck); no registro segue a 134, a ordem da promoção.
const ANTECESSORA = Object.freeze({'130': '129', '131': '130', '132': '131', '133': '131', '134': '133', '135': '134'});
/**
 * PORTÃO DE DEPLOY (Astra r4/r5 da 3b): a migration recusa sem a declaração na MESMA sessão. O operador só passa --portao-<id> depois de
 * conferir o procedimento do vault (código novo LIVE no web E no worker, nenhum gravador antigo vivo) e escreve ali o registro dessa
 * conferência; o aplicador grava o texto na reserva (detalhe.reserva.portao), imprime e faz o SET LOCAL na transação do corpo, antes do
 * precheck e da migration: some no COMMIT ou no ROLLBACK, nada fica na sessão. Sem o argumento = recusa antes de conectar (código 1).
 */
const PORTOES = Object.freeze({'135': Object.freeze({flag: '--portao-135', set: "SET LOCAL kidmais.portao_135 = 'deploy-novo-live-sem-gravador-antigo'"})});
/** Texto livre do registro da conferência (letras com acento, números e pontuação simples; sem controle nem aspas): vai como parâmetro. */
const PORTAO_TEXTO = /^[\p{L}\p{N}:._/ +;,()#-]{20,200}$/u;
/**
 * Validador ÚNICO da declaração (Astra r1 P1), usado no modo() e no aplicar(): exige string, tira só os ESPAÇOS das pontas (quebra de
 * linha, tabulação e outros controles continuam recusados, não são aparados), confere 20–200 caracteres do conjunto e exige ao menos uma
 * letra ou número. Devolve o texto validado (é ele que se imprime e grava) ou null.
 */
function validarPortao(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/^ +| +$/g, '');
  return PORTAO_TEXTO.test(t) && /[\p{L}\p{N}]/u.test(t) ? t : null;
}
const ESCOPO_129 = Object.freeze(['--conferir-tentativa', '--concluir-verificacao', '--arquivar-tentativa']);
const ARQUIVOS_129 = Object.freeze([
  Object.freeze(['precheck', 'database/checks/20261121_129_precheck.sql', '7625809dbd28aec433af30582387f353908627697e5be818391a44d74904e78d']),
  Object.freeze(['migration', 'database/migrations/20261121_129_registro_migrations.sql', '2e8e1bea7acef7bb376c372c4bd8ef777e473c9586b259108c5d67d3dcdfb805']),
  Object.freeze(['postcheck', 'database/checks/20261121_129_postcheck.sql', '201c3ab61e5d03abf4b54d45ab696eb182a53a3b809ea7da42487665bcd53684']),
]);
const BACKUP = /^[A-Za-z0-9:._/ -]{6,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AMBIENTES_VALIDOS = Object.freeze(['production', 'staging']);
/** Chave da trava advisory (sessão ou transação) de uma migration: a mesma para o registro e para o adaptador genérico de staging. */
const chaveTrava = (amb, id) => { assert.ok(AMBIENTES_VALIDOS.includes(amb), 'AMBIENTE_INVALIDO'); return amb + ':' + id; };
/** Chaves que o registro trava (129 no bootstrap, 130 a 135 pela ORDEM), nos dois ambientes: insumo do teste de colisão de hashtext. */
const CHAVES_TRAVA = Object.freeze(AMBIENTES_VALIDOS.flatMap(a => ['129', ...ORDEM].map(id => chaveTrava(a, id))));
const raizPadrao = path.resolve(__dirname, '..');
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').slice(0, 300);

// ---------------------------------------------------------------- SQL (todo UPDATE filtra ambiente, migration, tentativa, versao, situacao)
const T = 'public.operacao_migration_tentativas';
// tem_corpo: evidência ESTRUTURADA (objeto com txid string decimal não vazia, como o aplicador grava, e postcheck=PASS); tem_chave_corpo: qualquer chave 'corpo' (inclusive {"corpo":null}),
// usada só para RECUSAR (arquivar, classificar), nunca para aceitar.
const COLS = "id, tentativa::text AS tentativa, ambiente, migration, situacao, versao, (detalhe ? 'corpo') AS tem_chave_corpo, " +
  "COALESCE(jsonb_typeof(detalhe -> 'corpo') = 'object' AND jsonb_typeof(detalhe -> 'corpo' -> 'txid') = 'string' " +
  "AND detalhe -> 'corpo' ->> 'txid' ~ '^[0-9]+$' AND detalhe -> 'corpo' ->> 'postcheck' = 'PASS', false) AS tem_corpo, " +
  'arquivada_em IS NOT NULL AS arquivada, arquivada_motivo, substituida_por::text AS substituida_por';
const SQL = Object.freeze({
  sondagem: "SELECT to_regclass('public.operacao_migration_tentativas')::text AS tabela",
  travaSessao: "SELECT pg_try_advisory_lock(hashtext('kidmais-migration'), hashtext($1::text)) AS ok",
  travaTransacao: "SELECT pg_try_advisory_xact_lock(hashtext('kidmais-migration'), hashtext($1::text)) AS ok",
  travaOcupada: "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = hashtext('kidmais-migration')::oid " +
    'AND objid = hashtext($1::text)::oid AND objsubid = 2 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS ocupada',
  ativa: `SELECT ${COLS} FROM ${T} WHERE ambiente = $1 AND migration = $2 AND arquivada_em IS NULL`,
  porUuid: `SELECT ${COLS} FROM ${T} WHERE tentativa = $1::uuid`,
  buscaDiagnostica: `SELECT ${COLS} FROM ${T} WHERE ambiente = $1 AND tentativa = $2::uuid`,
  historico: `SELECT tentativa::text AS tentativa, situacao, arquivada_em IS NOT NULL AS arquivada FROM ${T} WHERE ambiente = $1 AND migration = $2 ORDER BY id`,
  ultimaArquivada: `SELECT ${COLS} FROM ${T} WHERE ambiente = $1 AND migration = $2 AND arquivada_em IS NOT NULL AND substituida_por IS NULL ` +
    'ORDER BY arquivada_em DESC, id DESC LIMIT 1',
  inserir: `INSERT INTO ${T} (ambiente, migration, tentativa, backup, situacao, detalhe) VALUES ($1, $2, $3::uuid, $4, 'INICIADA', $5::jsonb) RETURNING versao`,
  inserir129: `INSERT INTO ${T} (ambiente, migration, tentativa, backup, situacao, detalhe) VALUES ($1, $2, $3::uuid, $4, 'VERIFICACAO_PENDENTE', ` +
    "jsonb_build_object('corpo', jsonb_build_object('txid', txid_current()::text, 'postcheck', 'PASS', 'em', clock_timestamp()))) RETURNING versao",
  vinculo: `UPDATE ${T} SET substituida_por = $6::uuid, versao = versao + 1, atualizada_em = clock_timestamp() ` +
    'WHERE ambiente = $1 AND migration = $2 AND tentativa = $3::uuid AND versao = $4 AND situacao = $5 AND arquivada_em IS NOT NULL AND substituida_por IS NULL',
  escrever: `UPDATE ${T} SET situacao = $6, versao = versao + 1, atualizada_em = clock_timestamp(), detalhe = detalhe || $7::jsonb ` +
    'WHERE ambiente = $1 AND migration = $2 AND tentativa = $3::uuid AND versao = $4 AND situacao = $5 AND arquivada_em IS NULL RETURNING versao',
  corpo: `UPDATE ${T} SET situacao = 'EM_ANDAMENTO', versao = versao + 1, atualizada_em = clock_timestamp(), ` +
    "detalhe = detalhe || jsonb_build_object('corpo', jsonb_build_object('txid', txid_current()::text, 'postcheck', 'PASS', 'em', clock_timestamp())) " +
    'WHERE ambiente = $1 AND migration = $2 AND tentativa = $3::uuid AND versao = $4 AND situacao = $5 AND arquivada_em IS NULL RETURNING versao',
  arquivar: `UPDATE ${T} SET arquivada_em = clock_timestamp(), arquivada_motivo = $6, versao = versao + 1, atualizada_em = clock_timestamp(), ` +
    'detalhe = detalhe || $7::jsonb WHERE ambiente = $1 AND migration = $2 AND tentativa = $3::uuid AND versao = $4 AND situacao = $5 AND arquivada_em IS NULL RETURNING versao',
  estado129: "SELECT to_regclass('public.operacao_migration_tentativas') IS NOT NULL AS c0, to_regclass('public.operacao_migration_tentativas_id_seq') IS NOT NULL AS c1, " +
    "to_regclass('public.operacao_migration_tentativas_ativa_uk') IS NOT NULL AS c2, to_regprocedure('public.operacao_migration_tentativas_terminal()') IS NOT NULL AS c3",
  beginLeitura: 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
});
const SET_LOCAL = timeout => ["SET LOCAL lock_timeout = '5s'", `SET LOCAL statement_timeout = '${timeout}'`, 'SET LOCAL search_path = public, pg_catalog'];

// ---------------------------------------------------------------- definições
function carregar129(raiz) {
  const corpos = {};
  for (const [etapa, arquivo, hash] of ARQUIVOS_129) {
    const sql = lerRevisado(raiz, arquivo, hash);
    corpos[etapa] = etapa === 'migration' ? gen.corpoMigration(sql, 'migration 129') : gen.corpoCheck(sql, `${etapa} 129`);
  }
  return corpos;
}
const carregarId = (raiz, id) => (id === '129' ? carregar129(raiz) : gen.carregar(raiz, id));
const ultimoResultado = r => [].concat(r ?? []).at(-1);
/** Linha da validação estrutural (postcheck da 129) → lista de divergências; formato inesperado lança (erro local, nunca "íntegro"). */
function lerDivergencias(r) {
  const linha = ultimoResultado(r)?.rows?.[0];
  assert.ok(Array.isArray(linha?.divergencias) && linha.divergencias.every(x => typeof x === 'string') && typeof linha.aprovado === 'boolean', 'ESTRUTURA_ILEGIVEL');
  assert.equal(linha.aprovado, linha.divergencias.length === 0, 'ESTRUTURA_ILEGIVEL');
  return linha.divergencias;
}
/** Postcheck concluído → {aprovado, motivo}; nunca lança por reprovação (o exigirAprovado que lança fica no APLICAR e nos legados). */
function avaliarPostcheck(r) {
  for (const x of [].concat(r ?? [])) for (const linha of x?.rows ?? [])
    if (linha && Object.hasOwn(linha, 'aprovado') && linha.aprovado !== true)
      return {aprovado: false, motivo: Array.isArray(linha.divergencias) && linha.divergencias.length ? linha.divergencias.join('; ') : 'aprovado=false'};
  return {aprovado: true, motivo: null};
}
function lerEstado129(linha) {
  const v = ['c0', 'c1', 'c2', 'c3'].map(c => linha?.[c]);
  for (const x of v) assert.equal(typeof x, 'boolean', 'ESTADO_ILEGIVEL 129');
  const n = v.filter(Boolean).length;
  return {situacao: n === 0 ? 'ausente' : n === v.length ? 'presente' : 'parcial'};
}
const sqlEstadoDe = id => (id === '129' ? SQL.estado129 : gen.sqlEstado(id));
const lerEstadoDe = (id, linha) => (id === '129' ? lerEstado129(linha) : gen.lerEstado(id, linha));

// ---------------------------------------------------------------- ambientes (alvo e identidade); testes injetam os seus
function ambienteDe(nome, env, deps = {}) {
  assert.ok(AMBIENTES_VALIDOS.includes(nome), 'AMBIENTE_INVALIDO');
  const base = nome === 'production'
    ? {alvo: app => prd.alvoRigido(env, app), sqlIdentidade: prd.SQL_IDENTIDADE, identidade: linha => prd.identidade(linha)}
    : {alvo: app => { const c = s116.alvo(env); c.application_name = app; return c; }, sqlIdentidade: stg.SQL_IDENTIDADE, identidade: linha => stg.conferirIdentidade(linha, env)};
  return {nome, alvo: deps.alvo ?? base.alvo, sqlIdentidade: deps.sqlIdentidade ?? base.sqlIdentidade, identidade: deps.identidade ?? base.identidade};
}

// ---------------------------------------------------------------- utilidades de erro e prazo
/** SQLSTATE só de resposta do servidor (erro de socket como EPIPE tem 5 letras e não é SQLSTATE). */
const sqlstateDe = e => (typeof e?.severity === 'string' && typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null);
/** Rejeição que encerra a conexão: sem SQLSTATE, classe 08, 57P01–57P03 ou severidade FATAL/PANIC (ex.: 25P03). */
const fatal = e => { const c = sqlstateDe(e); return !c || /^08/.test(c) || ['57P01', '57P02', '57P03'].includes(c) || ['FATAL', 'PANIC'].includes(e?.severity); };
const PARADA = Object.freeze({parada: true});
class ErroLocal extends Error { constructor(local, causa) { super(local + ': ' + curta(causa)); this.local = local; } }
const esperar = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
function comPrazo(p, ms, local) {
  let t;
  const prazo = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('prazo ' + local), {prazo: true, local})), ms); t.unref?.(); });
  return Promise.race([Promise.resolve(p), prazo]).finally(() => clearTimeout(t));
}
/** COMMIT com prazo local: estouro destrói o socket (o servidor decide sozinho) e propaga erro sem SQLSTATE (INDETERMINADO). */
async function commitComPrazo(ctx, db, local) {
  try { return await comPrazo(db.query('COMMIT'), ctx.prazoCommit ?? 75000, local); }
  catch (e) { if (e?.prazo) { destruir(db); db.destruido = true; } throw e; }
}
/** Fim de C: end com prazo; estouro ou C já destruída = destruir. */
async function encerrarC(ctx, db) {
  if (db.destruido) { destruir(db); return; }
  try { await comPrazo(db.end(), ctx.prazoDescarte ?? 10000, 'descarte_timeout'); } catch { destruir(db); }
}
function destruir(db) { try { (db.destruir ?? (() => db.connection?.stream?.destroy()))(); } catch { /* já destruído */ } }

// ---------------------------------------------------------------- sessão de leitura (§3.0 regras 1–5)
/**
 * Um cliente novo, uma transação READ COMMITTED READ ONLY, instruções em sequência, para no primeiro erro, um único registro
 * de falha, ROLLBACK único com prazo, descarte com prazo e só então a publicação. `corpo(s)` usa s.instrucao(rotulo, sql,
 * params, {ehPostcheck}) e s.fato(texto, codigo). Devolve o estado da sessão; quem chamou publica (depois do descarte).
 * Único ponto do módulo, além da conexão C do APLICAR/bootstrap, que cria cliente.
 */
async function abrirSessaoLeitura(ctx, nome, corpo, {timeout = '60s'} = {}) {
  const g = ctx.ganchos ?? {};
  const s = {nome, rotulo: 'CONEXAO', conexao: 'VIVA', falha: null, begin: false, fatos: [], respondidos: new Set(), recusa: null, identidadeRecusada: null, pid: null};
  const info = () => ({sessao: nome, rotulo: s.rotulo, pid: s.pid, conexao: s.conexao});
  let avisarPerda;
  const perda = new Promise(r => { avisarPerda = r; });
  const marcarPerda = () => { if (s.conexao === 'VIVA') { s.conexao = 'PERDIDA'; avisarPerda(); } };
  // Registro único: a 1ª observação fixa o rótulo; as seguintes só preenchem o código vazio (mesmo cliente, mesma perda).
  const falhar = (rotulo, codigo) => {
    if (!s.falha) s.falha = {rotulo, codigo: codigo ?? null};
    else if (s.falha.codigo == null && codigo) s.falha.codigo = codigo;
  };
  const observar = (tipo, e) => {
    if (s.conexao === 'ENCERRANDO') { if (tipo === 'error') s.erroNoDescarte = e ?? new Error('error'); return; }
    if (s.conexao === 'VIVA') { marcarPerda(); falhar(s.rotulo, sqlstateDe(e)); return; }
    falhar(s.rotulo, sqlstateDe(e));
  };
  const prazoLiquidacao = ctx.prazoLiquidacao ?? 10000;
  s.fato = (texto, codigo = 0) => s.fatos.push({texto, codigo});
  s.responder = item => s.respondidos.add(item);
  s.instrucao = async (rotulo, sql, params, {ehPostcheck = false} = {}) => {
    s.rotulo = rotulo; // antes de qualquer pausa ou trabalho local que precede a instrução
    await g.antesDe?.(info(), s);
    if (s.conexao !== 'VIVA' || s.falha) throw PARADA;
    const texto = g.sql?.(info(), sql) ?? sql;
    g.registro?.({...info(), sql: texto});
    // Com a conexão perdida, espera a instrução em curso liquidar (para colher o SQLSTATE dela) por um prazo; depois segue.
    const semLiquidacao = perda.then(() => esperar(prazoLiquidacao)).then(() => { throw Object.assign(new Error('sem liquidação'), {semLiquidacao: true}); });
    semLiquidacao.catch(() => {});
    try {
      return await Promise.race([db.query(texto, params), semLiquidacao]);
    } catch (e) {
      const codigo = sqlstateDe(e);
      // P0001 da instrução marcada, com a conexão viva e sem falha anterior: reprovação, classificada antes de criar falha.
      if (ehPostcheck && codigo === 'P0001' && !fatal(e) && s.conexao === 'VIVA' && !s.falha) return {falhou: curta(e)};
      if (fatal(e)) marcarPerda();
      falhar(rotulo, codigo);
      throw PARADA;
    }
  };
  let db;
  try {
    db = new ctx.Client(ctx.ambiente.alvo(`kidmais-registro-${ctx.ambiente.nome}-leitura`));
    db.on?.('error', e => observar('error', e));
    db.on?.('end', () => observar('end'));
    await g.antesDe?.(info(), s);
    try { await db.connect(); } catch (e) { marcarPerda(); falhar('CONEXAO', sqlstateDe(e)); throw PARADA; }
    s.pid = db.processID ?? null;
    const id = await s.instrucao('IDENTIDADE', ctx.ambiente.sqlIdentidade);
    try { (g.identidade?.(info()) ?? ctx.ambiente.identidade)(id.rows?.[0]); } catch (e) { s.identidadeRecusada = curta(e); throw PARADA; }
    await s.instrucao('BEGIN', SQL.beginLeitura);
    s.begin = true;
    const ro = await s.instrucao('SHOW', 'SHOW transaction_read_only');
    if (ro.rows?.[0]?.transaction_read_only !== 'on') { s.recusa = 'LEITURA_NAO_READ_ONLY'; throw PARADA; }
    const iso = await s.instrucao('SHOW', 'SHOW transaction_isolation');
    if (iso.rows?.[0]?.transaction_isolation !== 'read committed') { s.recusa = 'LEITURA_ISOLAMENTO_INVALIDO'; throw PARADA; }
    for (const set of SET_LOCAL(timeout)) await s.instrucao('SET', set);
    await corpo(s);
    s.rotulo = 'FIM'; // depois do último resultado, antes do finally
    await g.antesDe?.(info(), s);
  } catch (e) {
    if (e !== PARADA) falhar(s.rotulo, 'local=' + (e?.local ?? 'excecao'));
  } finally {
    s.rotulo = 'FIM';
    let destruido = false;
    if (db && s.begin && s.conexao === 'VIVA') {
      try {
        const pedido = 'ROLLBACK';
        const texto = g.sql?.(info(), pedido) ?? pedido;
        g.registro?.({...info(), sql: texto});
        await comPrazo(db.query(texto), ctx.prazoRollback ?? 10000, 'rollback_timeout');
      } catch (e) {
        if (e?.prazo) { falhar('FIM', 'local=rollback_timeout'); destruir(db); destruido = true; }
        else { if (fatal(e)) marcarPerda(); if (!s.falha) falhar('FIM', sqlstateDe(e)); }
      }
    }
    s.conexao = 'ENCERRANDO'; // daqui em diante end/error são do fechamento pedido
    if (db && !destruido) {
      try {
        await comPrazo(g.end ? g.end(info(), db) : db.end(), ctx.prazoDescarte ?? 10000, 'descarte_timeout');
        if (s.erroNoDescarte) throw s.erroNoDescarte;
      } catch (e) {
        destruir(db);
        // O fechamento é outro evento: nunca preenche o código de uma falha anterior; só registra FIM se não havia falha.
        if (!s.falha) falhar('FIM', e?.prazo ? 'local=descarte_timeout' : sqlstateDe(e));
      }
    }
  }
  return s;
}
const textoFalha = (s, nomeSessao = s.nome) => ['ERRO_VERIFICACAO', nomeSessao, s.falha.rotulo, s.falha.codigo ?? 'sqlstate=indisponivel'].filter(Boolean).join(' ');

// ---------------------------------------------------------------- saída e código
/** Precedência 1 > 2 > 3 > 0. */
const RANK = {0: 0, 3: 1, 2: 2, 1: 3};
const pior = codigos => codigos.reduce((a, c) => (RANK[c] > RANK[a] ? c : a), 0);
function saida(ctx) {
  const linhas = [], codigos = [];
  return {
    linha(texto, codigo = 0) { linhas.push(texto); codigos.push(codigo); (ctx.out ?? (() => {}))(texto); },
    get linhas() { return linhas; },
    get codigo() { return pior(codigos); },
  };
}

// ---------------------------------------------------------------- diagnóstico --conferir-registro (§3.0)
async function conferirRegistro(ctx, {tentativas = [], ids = ORDEM}) {
  const o = saida(ctx);
  const amb = ctx.ambiente.nome;
  const p129 = carregar129(ctx.raiz).postcheck;
  const corposIds = Object.fromEntries(ids.filter(id => ORDEM.includes(id)).map(id => [id, carregarId(ctx.raiz, id)]));
  let pararTudo = false;
  const publicar = (s, itens) => {
    for (const f of s.fatos) o.linha(f.texto, f.codigo);
    if (s.identidadeRecusada) { o.linha('IDENTIDADE_RECUSADA ' + s.identidadeRecusada, 1); pararTudo = true; }
    if (s.recusa) o.linha(s.recusa, 1);
    if (s.falha) o.linha(textoFalha(s), 1);
    if (s.identidadeRecusada || s.recusa || s.falha) for (const item of itens) if (!s.respondidos.has(item)) o.linha('NAO_VERIFICADO ' + item, 1);
  };
  // Sessão Registro: trava da 129 primeiro; depois sondagem, estrutura, linha da 129 e uuids, cada uma só se a anterior concluiu.
  const itensRegistro = ['REGISTRO', ...tentativas.map(u => 'tentativa=' + u)];
  const sr = await abrirSessaoLeitura(ctx, 'REGISTRO', async s => {
    const t = await s.instrucao('TRAVA_129', SQL.travaTransacao, [chaveTrava(amb, '129')]);
    if (t.rows?.[0]?.ok !== true) {
      s.fato('REGISTRO_NAO_CONCLUSIVO EXECUTOR_ATIVO 129', 2); s.responder('REGISTRO');
      for (const u of tentativas) { s.fato('TENTATIVA_NAO_CONCLUSIVA tentativa=' + u, 2); s.responder('tentativa=' + u); }
      return;
    }
    const sd = await s.instrucao('SONDAGEM', SQL.sondagem);
    if (sd.rows?.[0]?.tabela == null) {
      s.fato('REGISTRO_AUSENTE', 3); s.responder('REGISTRO');
      for (const u of tentativas) { s.fato('REGISTRO_AUSENTE tentativa=' + u, 3); s.responder('tentativa=' + u); }
      return;
    }
    const est = await s.instrucao('ESTRUTURA', p129);
    let div;
    try { div = lerDivergencias(est); } catch (e) { throw new ErroLocal('lerDivergencias', e); }
    if (div.length) {
      s.fato('REGISTRO_INVALIDO ' + div.join('; '), 1); s.responder('REGISTRO');
      for (const u of tentativas) { s.fato(`TENTATIVA_NAO_CONSULTADA tentativa=${u} REGISTRO_INVALIDO`, 1); s.responder('tentativa=' + u); }
      return;
    }
    const l = (await s.instrucao('LINHA_129', SQL.ativa, [amb, '129'])).rows ?? [];
    if (l.length === 0) s.fato('REGISTRO_SEM_LINHA_129', 3);
    else if (l[0].situacao === 'CONCLUIDA') s.fato('REGISTRO_129 CONCLUIDA tentativa=' + l[0].tentativa, 0);
    else s.fato(`REGISTRO_PENDENTE 129 ${l[0].situacao} tentativa=${l[0].tentativa}`, 3);
    s.responder('REGISTRO');
    for (const u of tentativas) {
      const b = (await s.instrucao('TENTATIVA ' + u, SQL.buscaDiagnostica, [amb, u])).rows ?? [];
      if (b.length === 0) s.fato(`TENTATIVA_NAO_ENCONTRADA tentativa=${u} (concluir com --conferir-tentativa <id> --tentativa ${u})`, 3);
      else s.fato(`TENTATIVA ${u} migration=${b[0].migration} ${descreverLinha(b[0])}`, b[0].arquivada || b[0].situacao === 'CONCLUIDA' ? 0 : 3);
      s.responder('tentativa=' + u);
    }
  });
  publicar(sr, itensRegistro);
  // Uma sessão por id: sentinelas e, se presente, o postcheck como última instrução (a única que pode dar FALHOU).
  for (const id of ids) {
    if (pararTudo) { o.linha('NAO_VERIFICADO ESTADO ' + id, 1); continue; }
    if (!ORDEM.includes(id)) { o.linha('ID_FORA_DO_REGISTRO ' + id, 1); continue; }
    const itens = ['ESTADO ' + id, 'POSTCHECK ' + id];
    const si = await abrirSessaoLeitura(ctx, 'ESTADO ' + id, async s => {
      await estadoComPostcheck(ctx, s, id, corposIds[id]);
    });
    publicar(si, itens);
  }
  o.linha('DIAGNOSTICO_CODIGO ' + o.codigo + ' (0 nunca libera APLICAR nem novo bootstrap)', o.codigo);
  return {codigo: o.codigo, linhas: o.linhas};
}
/** Dentro de uma sessão: ESTADO <id> e, com presente, POSTCHECK <id> (instrução marcada, última da sessão). */
async function estadoComPostcheck(ctx, s, id, corpos) {
  const g = ctx.ganchos ?? {};
  const r = await s.instrucao('SENTINELAS', sqlEstadoDe(id));
  let e;
  try { e = lerEstadoDe(id, r.rows?.[0]); } catch (x) { throw new ErroLocal('lerEstado', x); }
  s.fato(`ESTADO ${id} ${e.situacao}${e.divergencias ? ' ' + e.divergencias.join(', ') : ''}`, e.situacao === 'parcial' ? 3 : 0);
  s.responder('ESTADO ' + id);
  if (e.situacao !== 'presente') { s.responder('POSTCHECK ' + id); return e; }
  const aux = g.auxiliar?.({sessao: s.nome, id});
  if (aux) await s.instrucao('AUXILIAR', aux);
  const p = await s.instrucao('POSTCHECK', corpos.postcheck, undefined, {ehPostcheck: true});
  let av;
  if (p?.falhou) av = {aprovado: false, motivo: p.falhou};
  else { try { av = (g.avaliar ?? avaliarPostcheck)(p, id); } catch (x) { throw new ErroLocal('avaliarPostcheck', x); } }
  s.fato(av.aprovado ? `POSTCHECK ${id} PASS` : `POSTCHECK ${id} FALHOU ${av.motivo}`, av.aprovado ? 0 : 3);
  s.responder('POSTCHECK ' + id);
  e.postcheck = av;
  return e;
}
function descreverLinha(l) {
  return l.arquivada ? `ARQUIVADA ${l.arquivada_motivo} substituida_por=${l.substituida_por ?? 'nenhuma'}`
    : `ATIVA ${l.situacao} versao=${l.versao} corpo=${l.tem_corpo ? 'sim' : 'nao'}`;
}

// ---------------------------------------------------------------- --conferir-tentativa (§3.2 passo 9)
async function conferirTentativa(ctx, {id, tentativa: u}) {
  const o = saida(ctx);
  const amb = ctx.ambiente.nome;
  const p129 = carregar129(ctx.raiz).postcheck;
  let resposta = null, achada = null;
  const rodada = async s => {
    const sd = await s.instrucao('SONDAGEM', SQL.sondagem);
    if (sd.rows?.[0]?.tabela == null) return {tabela: false};
    const est = await s.instrucao('ESTRUTURA', p129);
    let div;
    try { div = lerDivergencias(est); } catch (e) { throw new ErroLocal('lerDivergencias', e); }
    if (div.length) return {invalido: div};
    const b = (await s.instrucao('BUSCA', SQL.porUuid, [u])).rows ?? [];
    if (b.length === 0) return {tabela: true};
    const l = b[0];
    if (l.ambiente !== amb || l.migration !== id) return {outra: l};
    achada = l; // preservada mesmo que o histórico falhe
    const h = (await s.instrucao('HISTORICO', SQL.historico, [amb, id])).rows ?? [];
    return {linha: l, historico: h.map(x => `${x.tentativa}:${x.situacao}${x.arquivada ? ':ARQUIVADA' : ''}`).join(',')};
  };
  const responder = r => {
    if (r.invalido) { resposta = {texto: 'REGISTRO_INVALIDO ' + r.invalido.join('; '), codigo: 1}; return true; }
    if (r.outra) { resposta = {texto: `TENTATIVA_DE_OUTRA_MIGRATION tentativa=${u} ambiente=${r.outra.ambiente} migration=${r.outra.migration}`, codigo: 1}; return true; }
    if (r.linha) {
      resposta = {texto: `TENTATIVA ${u} migration=${id} ${descreverLinha(r.linha)} historico=${r.historico}`,
        codigo: r.linha.arquivada || r.linha.situacao === 'CONCLUIDA' ? 0 : 3};
      return true;
    }
    return false;
  };
  const s = await abrirSessaoLeitura(ctx, '', async s => {
    const r1 = await rodada(s);
    if (responder(r1, s)) return;
    const t = await s.instrucao('TRAVA', SQL.travaTransacao, [chaveTrava(amb, id)]);
    if (t.rows?.[0]?.ok !== true) { resposta = {texto: `AUSENTE_NAO_CONCLUSIVO EXECUTOR_ATIVO tentativa=${u}`, codigo: 2}; return; }
    const r2 = await rodada(s);
    if (responder(r2, s)) return;
    resposta = {texto: `AUSENTE tentativa=${u} migration=${id} historico=${r2.tabela ? 'nenhum' : 'tabela_ausente'}`, codigo: 3};
  }, {timeout: '30s'});
  if (resposta) o.linha(resposta.texto, resposta.codigo);
  else if (achada) { o.linha(`TENTATIVA ${u} migration=${id} ${descreverLinha(achada)}`, achada.arquivada || achada.situacao === 'CONCLUIDA' ? 0 : 3); o.linha('NAO_VERIFICADO historico', 1); }
  if (s.identidadeRecusada) o.linha('IDENTIDADE_RECUSADA ' + s.identidadeRecusada, 1);
  if (s.recusa) o.linha(s.recusa, 1);
  if (s.falha) o.linha(textoFalha(s), 1);
  if (!resposta && !achada && !s.falha && !s.recusa && !s.identidadeRecusada) o.linha('NAO_VERIFICADO tentativa=' + u, 1);
  return {codigo: o.codigo, linhas: o.linhas};
}

// ---------------------------------------------------------------- conexão C (APLICAR, bootstrap, arquivar, concluir)
function clienteC(ctx, id) {
  const db = new ctx.Client(ctx.ambiente.alvo(`kidmais-registro-${ctx.ambiente.nome}-${id}`));
  db.on?.('error', () => undefined);
  db.prazoRollbackC = ctx.prazoRollback ?? 10000;
  return db;
}
/** ROLLBACK de leitura em C com prazo local: estouro destrói C (db.destruido) e propaga o erro sem SQLSTATE. */
async function rollbackEmC(db) {
  try { await comPrazo(db.query('ROLLBACK'), db.prazoRollbackC ?? 10000, 'rollback_timeout'); }
  catch (x) { if (x?.prazo) { destruir(db); db.destruido = true; } throw x; }
}
/**
 * Leitura READ ONLY em C (a mesma conexão que segura a trava). ROLLBACK com prazo nos dois caminhos. Se a leitura falha
 * (ex.: P0001 do postcheck) e o ROLLBACK estoura, propaga o estouro (sem SQLSTATE, C destruída) com a falha como `cause`:
 * o chamador nunca confunde conexão perdida com reprovação normal.
 */
async function lerEmC(db, sql, params) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    for (const set of SET_LOCAL('60s')) await db.query(set);
    const r = await db.query(sql, params);
    await rollbackEmC(db);
    return r;
  } catch (e) {
    if (!db.destruido) {
      try { await rollbackEmC(db); } catch (x) { if (x?.prazo) { x.cause = e; throw x; } }
    }
    throw e;
  }
}
async function identidadeEmC(ctx, db) {
  const linha = (await lerEmC(db, ctx.ambiente.sqlIdentidade)).rows?.[0];
  try { return ctx.ambiente.identidade(linha); } catch (e) { throw Object.assign(new Error('IDENTIDADE_RECUSADA ' + curta(e)), {saida: 'IDENTIDADE_RECUSADA', codigo: 1}); }
}
const recusa = (texto, codigo) => Object.assign(new Error(texto), {saida: texto, codigo});
/** exigirRegistro (§3.1): tabela presente, estrutura íntegra e, fora do modo estrutural, a linha ativa da 129 CONCLUIDA. */
async function exigirRegistro(ctx, db, {estrutural = false} = {}) {
  if ((await lerEmC(db, SQL.sondagem)).rows?.[0]?.tabela == null) throw recusa('REGISTRO_INVALIDO tabela ausente', 1);
  const div = lerDivergencias(await lerEmC(db, carregar129(ctx.raiz).postcheck));
  if (div.length) throw recusa('REGISTRO_INVALIDO ' + div.join('; '), 1);
  if (estrutural) return null;
  const l = (await lerEmC(db, SQL.ativa, [ctx.ambiente.nome, '129'])).rows?.[0];
  if (l?.situacao !== 'CONCLUIDA') throw recusa('REGISTRO_INVALIDO linha da 129 ' + (l ? l.situacao : 'ausente'), 1);
  return l;
}
async function travar(ctx, db, id) {
  const ok = (await db.query(SQL.travaSessao, [chaveTrava(ctx.ambiente.nome, id)])).rows?.[0]?.ok;
  if (ok !== true) throw recusa(`EXECUTOR_ATIVO ${ctx.ambiente.nome}:${id}`, 1);
}
/** Postcheck READ ONLY em C → {aprovado, motivo}; P0001 = reprovação; outro erro propaga. */
async function postcheckEmC(db, corpos) {
  try { return avaliarPostcheck(await lerEmC(db, corpos.postcheck)); }
  catch (e) { if (sqlstateDe(e) === 'P0001') return {aprovado: false, motivo: curta(e)}; throw e; }
}
async function estadoEmC(db, id) { return lerEstadoDe(id, (await lerEmC(db, sqlEstadoDe(id))).rows?.[0]); }
const linhaTexto = (ctx, id, u, situacao, versao) => `REGISTRO_TENTATIVA ${ctx.ambiente.nome} ${id} tentativa=${u} situacao=${situacao}${versao ? ' versao=' + versao : ''} em=${(ctx.agora ?? (() => new Date()))().toISOString()}`;
/** Escrita pela regra (§3.2): filtro completo e rowCount=1, senão REGISTRO_DESATUALIZADO (código 2). */
async function escreverLinha(ctx, db, o, id, linha, novaSituacao, detalhe) {
  const r = await db.query(SQL.escrever, [ctx.ambiente.nome, id, linha.tentativa, linha.versao, linha.situacao, novaSituacao, JSON.stringify(detalhe ?? {})]);
  if (r.rowCount !== 1) { o.linha(`REGISTRO_DESATUALIZADO tentativa=${linha.tentativa}`, 2); return null; }
  const versao = r.rows[0].versao;
  o.linha(linhaTexto(ctx, id, linha.tentativa, novaSituacao, versao), 0);
  return {...linha, situacao: novaSituacao, versao};
}
/** Classificação do próprio id (passo 3), também usada pelo --conferir-<id>. */
function classificar(id, estado, linha, postcheck) {
  if (estado.situacao === 'presente') {
    if (!linha) return {texto: 'ESTADO_SEM_REGISTRO_REVISAR ' + id, codigo: 1};
    if (linha.situacao === 'CONCLUIDA') return postcheck?.aprovado
      ? {texto: 'JA_APLICADA_POSTCHECK_PASS ' + id, codigo: 0}
      : {texto: `DIVERGENCIA_REGISTRO_ESTADO ${linha.tentativa} POSTCHECK ${postcheck?.motivo ?? ''}`.trim(), codigo: 3};
    return {texto: `TENTATIVA_ANTERIOR_REVISAR ${linha.tentativa} ${linha.situacao}`, codigo: 1};
  }
  if (estado.situacao === 'parcial') return {texto: `ESTADO_PARCIAL_REVISAR ${id} ${(estado.divergencias ?? []).join(', ')}`.trim(), codigo: 1};
  if (linha && (linha.situacao === 'CONCLUIDA' || linha.tem_corpo || linha.tem_chave_corpo)) return {texto: `DIVERGENCIA_REGISTRO_ESTADO ${linha.tentativa}`, codigo: 3};
  if (linha) return {texto: `TENTATIVA_ANTERIOR_REVISAR ${linha.tentativa} ${linha.situacao}`, codigo: 1};
  return {texto: 'PRONTA_PARA_APLICAR ' + id, codigo: 0, reserva: true};
}

// ---------------------------------------------------------------- APLICAR 130+ (§3.2), conexão única C
async function aplicar(ctx, {id, backup, portao}) {
  const o = saida(ctx);
  const amb = ctx.ambiente.nome;
  const g = ctx.ganchos ?? {};
  const corpos = gen.carregar(ctx.raiz, id);
  const ant = ANTECESSORA[id];
  const corposAnt = carregarId(ctx.raiz, ant);
  const pt = PORTOES[id] ?? null;
  // Defesa além do modo(): id com portão sem a declaração (ou declaração para id sem portão) não conecta.
  const declarado = pt ? validarPortao(portao) : null;
  if (Boolean(pt) !== (portao !== undefined) || (pt && declarado === null)) { o.linha(pt ? `PORTAO_OBRIGATORIO ${id} (${pt.flag} "<registro da conferência>")` : 'PORTAO_FORA_DO_ID ' + id, 1); return fim(o); }
  if (pt) o.linha(`PORTAO_${id}_DECLARADO ${declarado}`, 0);
  const db = clienteC(ctx, id);
  try {
    await db.connect();
    await identidadeEmC(ctx, db);                       // 1
    await exigirRegistro(ctx, db);
    await travar(ctx, db, id);                          // 2 (de sessão, até o fim)
    // 3. Próprio id primeiro.
    const estado = await estadoEmC(db, id);
    const linha = (await lerEmC(db, SQL.ativa, [amb, id])).rows?.[0] ?? null;
    const pc = estado.situacao === 'presente' && linha?.situacao === 'CONCLUIDA' ? await postcheckEmC(db, corpos) : null;
    const cl = classificar(id, estado, linha, pc);
    if (!cl.reserva) { o.linha(cl.texto, cl.codigo); return fim(o); }
    // 4. Antecessora (só no caminho que reserva).
    const la = (await lerEmC(db, SQL.ativa, [amb, ant])).rows?.[0] ?? null;
    if (la?.situacao !== 'CONCLUIDA') { o.linha(`ANTECESSORA_PENDENTE ${ant} ${la ? la.situacao : 'sem linha'}`, 3); return fim(o); }
    const ea = await estadoEmC(db, ant);
    const pa = ea.situacao === 'presente' ? await postcheckEmC(db, corposAnt) : null;
    if (!pa?.aprovado) { o.linha(`ANTECESSORA_DIVERGENTE ${ant} estado=${ea.situacao}${pa ? ' postcheck=' + (pa.motivo ?? '') : ''}`, 3); return fim(o); }
    const priv = gen.lerPrivilegios(id, (await lerEmC(db, gen.sqlPrivilegios(id))).rows?.[0]);
    if (!priv.ok) { o.linha('PRIVILEGIO_INSUFICIENTE ' + priv.faltas.join('; '), 1); return fim(o); }
    // 5. Reserva numa transação própria; uuid impresso antes de enviar.
    const anterior = (await lerEmC(db, SQL.ultimaArquivada, [amb, id])).rows?.[0] ?? null;
    const u = (ctx.uuid ?? crypto.randomUUID)();
    o.linha(linhaTexto(ctx, id, u, 'RESERVANDO'), 0);
    let fase = 'reserva';
    try {
      await db.query('BEGIN');
      for (const set of SET_LOCAL('60s')) await db.query(set);
      await db.query(SQL.inserir, [amb, id, u, backup, JSON.stringify({reserva: {anterior: anterior?.tentativa ?? null, ...(pt ? {portao: declarado} : {})}})]);
      if (anterior) {
        await g.antesDoVinculo?.({id, anterior, u});
        const v = await db.query(SQL.vinculo, [amb, id, anterior.tentativa, anterior.versao, anterior.situacao, u]);
        if (v.rowCount !== 1) {
          await db.query('ROLLBACK').catch(() => {});
          o.linha(`VINCULO_DESATUALIZADO tentativa=${u} anterior=${anterior.tentativa}`, 1);
          return fim(o);
        }
      }
      await g.antesDoCommitReserva?.({id, u});
      fase = 'commit';
      const c = await commitComPrazo(ctx, db, 'commit_reserva_timeout');
      if (c?.command === 'ROLLBACK') throw Object.assign(new Error('COMMIT respondido como ROLLBACK'), {comoRollback: true});
    } catch (e) {
      if (fase === 'reserva' && !db.destruido) await db.query('ROLLBACK').catch(() => {});
      if (fase === 'reserva' && sqlstateDe(e) === '23505' && e.constraint === 'operacao_migration_tentativas_ativa_uk') {
        o.linha(`TENTATIVA_ANTERIOR_REVISAR reserva concorrente tentativa=${u}`, 1); return fim(o);
      }
      o.linha(`RESERVA_INDETERMINADA tentativa=${u} ${curta(e)} (decidir com --conferir-tentativa ${id} --tentativa ${u})`, 2);
      return fim(o); // o corpo nunca começa sem COMMIT de reserva confirmado
    }
    let atual = {tentativa: u, versao: 1, situacao: 'INICIADA'};
    o.linha(linhaTexto(ctx, id, u, 'INICIADA', 1), 0);
    await g.depoisDaReserva?.({id, u, db});
    // 6. Corpo com a evidência na mesma transação.
    fase = 'inicio';
    let commit;
    try {
      await db.query('BEGIN');
      for (const set of SET_LOCAL('60s')) await db.query(set);
      fase = 'identidade';
      try { ctx.ambiente.identidade((await db.query(ctx.ambiente.sqlIdentidade)).rows?.[0]); } catch (e) { if (sqlstateDe(e)) throw e; throw new Error('IDENTIDADE_RECUSADA ' + curta(e)); }
      if (pt) { fase = 'portao'; await db.query(pt.set); }
      fase = 'precheck'; gen.exigirAprovado(await db.query(corpos.precheck), `precheck ${id}`);
      fase = 'migration'; await db.query(corpos.migration);
      fase = 'postcheck'; gen.exigirAprovado(await db.query(corpos.postcheck), `postcheck ${id}`);
      fase = 'evidencia';
      const ev = await db.query(SQL.corpo, [amb, id, u, 1, 'INICIADA']);
      if (ev.rowCount !== 1) throw new Error('REGISTRO_DESATUALIZADO na evidência');
      await g.antesDoCommitCorpo?.({id, u, db});
      fase = 'commit';
      const c = await commitComPrazo(ctx, db, 'commit_timeout');
      if (c?.command === 'ROLLBACK') { commit = 'DESFEITA_PELO_SERVIDOR'; throw new Error('COMMIT respondido como ROLLBACK'); }
      commit = 'CONFIRMADO';
    } catch (e) {
      if (!commit) commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
      o.linha(`CORPO ${id} commit=${commit} fase=${fase} ${curta(e)}`, 2);
      if (commit === 'NAO_COMMITADA') {
        await db.query('ROLLBACK').catch(() => {});
        const w = await escreverLinha(ctx, db, o, id, atual, 'FALHA', {falha: {fase, motivo: curta(e), commit}}).catch(x => { o.linha('REGISTRO_NAO_ATUALIZADO ' + curta(x), 2); return null; });
        if (w) o.linha(`FALHA ${id} tentativa=${u} (arquivável com decisão de Felipe)`, 2);
      } else o.linha(`COMMIT_${commit} ${id} tentativa=${u} (decidir com --conferir-${id} e --conferir-tentativa ${id} --tentativa ${u}; não repetir)`, 2);
      return fim(o);
    }
    atual = {...atual, versao: 2, situacao: 'EM_ANDAMENTO'};
    o.linha(linhaTexto(ctx, id, u, 'EM_ANDAMENTO', 2), 0);
    // depoisDoCommitCorpo simula a MORTE do processo (teste); exceção na verificação é naVerificacaoPosCommit, dentro do try.
    await g.depoisDoCommitCorpo?.({id, u, db});
    // 7. Releitura e postcheck READ ONLY; CONCLUIDA só com PASS. Exceção aqui (corpo já COMMITADO) = código 2 com o uuid.
    let pf;
    try {
      await g.naVerificacaoPosCommit?.({id, u, db});
      const depois = await estadoEmC(db, id);
      pf = depois.situacao === 'presente' ? await postcheckEmC(db, corpos) : {aprovado: false, motivo: 'estado ' + depois.situacao};
    } catch (e) {
      await falhaPosCommit(ctx, db, o, id, atual, e);
      return fim(o);
    }
    if (pf.aprovado) {
      const w = await escreverPosCommit(ctx, db, o, id, atual, 'CONCLUIDA', {conclusao: {postcheck: 'PASS'}});
      if (w) o.linha('APLICADA_POSTCHECK_PASS ' + id, 0);
    } else {
      const w = await escreverPosCommit(ctx, db, o, id, atual, 'FALHA', {falha: {fase: 'postcheck_final', motivo: pf.motivo}});
      if (w) o.linha(`FALHA ${id} tentativa=${u} postcheck=${pf.motivo} (corpo preservado; ver --concluir-verificacao)`, 2);
    }
    return fim(o);
  } catch (e) {
    o.linha(e?.saida ? curta(e) : 'ERRO ' + curta(e), e?.codigo ?? 1);
    return fim(o);
  } finally { await encerrarC(ctx, db); }
}
const fim = o => ({codigo: o.codigo, linhas: o.linhas});
/**
 * Exceção na verificação depois do COMMIT do corpo (ou da 129): sempre código 2 com o uuid. Se C ainda responde, grava FALHA
 * (o corpo da evidência fica: detalhe || falha); senão, só indica a reconciliação. Nunca código 1 ("recusa antes de conectar").
 */
async function falhaPosCommit(ctx, db, o, id, linha, e) {
  const u = linha.tentativa;
  o.linha(`VERIFICACAO_POS_COMMIT_FALHOU ${id} tentativa=${u} ${curta(e)}`, 2);
  const reconciliar = `(corpo COMMITADO; reconciliar com --concluir-verificacao ${id} --tentativa ${u})`;
  // Sem SQLSTATE (erro local, asserção) a C pode estar viva: tenta gravar FALHA; se não responder, escreverPosCommit indica a reconciliação.
  if (db.destruido || (sqlstateDe(e) && fatal(e))) { o.linha(`REGISTRO_NAO_ATUALIZADO tentativa=${u} conexão perdida ${reconciliar}`, 2); return; }
  try { await comPrazo(db.query('ROLLBACK'), ctx.prazoRollback ?? 10000, 'rollback_timeout'); } catch (x) {
    if (x?.prazo) { destruir(db); db.destruido = true; o.linha(`REGISTRO_NAO_ATUALIZADO tentativa=${u} ${curta(x)} ${reconciliar}`, 2); return; }
  }
  const w = await escreverPosCommit(ctx, db, o, id, linha, 'FALHA', {falha: {fase: 'verificacao_pos_commit', motivo: curta(e)}});
  if (w) o.linha(`FALHA ${id} tentativa=${u} ${reconciliar}`, 2);
}
/**
 * Escrita no registro depois do COMMIT do corpo (ou da 129): prazo local; nunca lança e nunca vira código 1.
 * Depois do ENVIO do UPDATE, estouro do prazo ou perda de conexão sem confirmação (erro sem SQLSTATE ou fatal) =
 * REGISTRO_INDETERMINADO (código 2): o servidor pode ter confirmado, então a orientação é consultar --conferir-tentativa
 * primeiro. Só é REGISTRO_NAO_ATUALIZADO (código 2, concluir direto) o que comprovadamente não gravou: C já encerrada antes
 * do envio, ou erro do servidor não fatal (o UPDATE em autocommit foi desfeito).
 */
async function escreverPosCommit(ctx, db, o, id, linha, novaSituacao, detalhe) {
  const u = linha.tentativa;
  let enviado = false;
  try {
    const escrita = (async () => {
      await ctx.ganchos?.antesDaEscritaPosCommit?.({id, u, db, novaSituacao});
      if (db.destruido || db.connection?.stream?.destroyed === true) throw new Error('conexão C encerrada antes do envio do UPDATE');
      enviado = true;
      return escreverLinha(ctx, db, o, id, linha, novaSituacao, detalhe);
    })();
    return await comPrazo(escrita, ctx.prazoEscrita ?? 30000, 'escrita_registro_timeout');
  } catch (x) {
    if (x?.prazo) { destruir(db); db.destruido = true; }
    if (x?.prazo || (enviado && fatal(x))) {
      o.linha(`REGISTRO_INDETERMINADO tentativa=${u} ${novaSituacao} ${curta(x)} (corpo COMMITADO; a escrita pode ter sido confirmada: ` +
        `consultar primeiro --conferir-tentativa ${id} --tentativa ${u}; só então --concluir-verificacao ${id} --tentativa ${u})`, 2);
    } else o.linha(`REGISTRO_NAO_ATUALIZADO tentativa=${u} ${curta(x)} (corpo COMMITADO; reconciliar com --concluir-verificacao ${id} --tentativa ${u})`, 2);
    return null;
  }
}

// ---------------------------------------------------------------- bootstrap da 129 (§3.4)
async function bootstrap129(ctx, {backup, flagFranquia}) {
  const o = saida(ctx);
  const amb = ctx.ambiente.nome;
  const g = ctx.ganchos ?? {};
  const corpos = carregar129(ctx.raiz);
  const db = clienteC(ctx, '129');
  try {
    await db.connect();
    await identidadeEmC(ctx, db);                        // 1. identidade em C antes da trava e de qualquer DDL
    await travar(ctx, db, '129');                        // trava de sessão, até o processo terminar
    await g.depoisDaTrava129?.({db});
    // 2. antecessoras; a declaração da flag da franquia (já validada contra o ambiente em principal) só pesa no ramo de dados da 116.
    const ant = await (ctx.antecessoras ?? (() => require('./conferir-antecessoras.cjs').conferir({ambiente: amb, env: ctx.env, flagFranquia,
      deps: ctx.clientInjetado ? {Client: ctx.Client} : {}})))(amb, {flagFranquia});
    for (const l of ant?.linhas ?? []) o.linha('ANTECESSORA ' + l, 0);
    if (ant?.codigo !== 0) { o.linha('ANTECESSORAS_PENDENTES ' + (ant?.pendentes ?? []).join(','), 3); return fim(o); }
    const estado = await estadoEmC(db, '129');           // 3
    if (estado.situacao !== 'ausente') {
      const div = estado.situacao === 'presente' ? lerDivergencias(await lerEmC(db, corpos.postcheck)) : ['estado parcial'];
      if (div.length) { o.linha('ESTADO_PARCIAL_REVISAR 129 ' + div.join('; '), 1); return fim(o); }
      const l = (await lerEmC(db, SQL.ativa, [amb, '129'])).rows?.[0];
      if (!l) o.linha('DIVERGENCIA_REGISTRO_ESTADO 129 estrutura sem linha', 3);
      else if (l.situacao === 'CONCLUIDA') o.linha('JA_APLICADA_POSTCHECK_PASS 129 tentativa=' + l.tentativa, 0);
      else o.linha(`REGISTRO_PENDENTE 129 ${l.situacao} tentativa=${l.tentativa} (ver --concluir-verificacao 129)`, 3);
      return fim(o);
    }
    const u = (ctx.uuid ?? crypto.randomUUID)();       // 4. uuid impresso com a trava segura
    o.linha(linhaTexto(ctx, '129', u, 'RESERVANDO'), 0);
    let fase = 'inicio', commit;
    try {
      await db.query('BEGIN');
      for (const set of SET_LOCAL('60s')) await db.query(set);
      fase = 'identidade';
      try { ctx.ambiente.identidade((await db.query(ctx.ambiente.sqlIdentidade)).rows?.[0]); } catch (e) { if (sqlstateDe(e)) throw e; throw new Error('IDENTIDADE_RECUSADA ' + curta(e)); }
      fase = 'precheck'; gen.exigirAprovado(await db.query(corpos.precheck), 'precheck 129');
      fase = 'migration'; await db.query(corpos.migration);
      fase = 'postcheck'; gen.exigirAprovado(await db.query(corpos.postcheck), 'postcheck 129');
      fase = 'linha'; await db.query(SQL.inserir129, [amb, '129', u, backup]);
      await g.antesDoCommit129?.({db, u});
      fase = 'commit';
      const c = await commitComPrazo(ctx, db, 'commit_timeout');
      if (c?.command === 'ROLLBACK') { commit = 'DESFEITA_PELO_SERVIDOR'; throw new Error('COMMIT respondido como ROLLBACK'); }
      commit = 'CONFIRMADO';
    } catch (e) {
      if (!commit) commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
      if (commit === 'NAO_COMMITADA' && !db.destruido) await db.query('ROLLBACK').catch(() => {});
      o.linha(`BOOTSTRAP_129 commit=${commit} fase=${fase} tentativa=${u} ${curta(e)}` +
        (commit === 'NAO_COMMITADA' ? '' : ` (decidir com --conferir-tentativa 129 --tentativa ${u}; não repetir)`), 2);
      return fim(o);
    }
    o.linha(linhaTexto(ctx, '129', u, 'VERIFICACAO_PENDENTE', 1), 0);
    await g.depoisDoCommit129?.({db, u});
    // 5. Releitura: a linha tem de ser a recém-inserida (uuid, VERIFICACAO_PENDENTE, versão 1, corpo estruturado); estrutura e
    // postcheck READ ONLY ⇒ CONCLUIDA. Exceção aqui (já COMMITADO) = código 2 com o uuid.
    let linha, pf;
    try {
      await g.naVerificacaoPosCommit?.({id: '129', u, db});
      linha = (await lerEmC(db, SQL.ativa, [amb, '129'])).rows?.[0];
      pf = await postcheckEmC(db, corpos);
    } catch (e) {
      await falhaPosCommit(ctx, db, o, '129', {tentativa: u, versao: 1, situacao: 'VERIFICACAO_PENDENTE'}, e);
      return fim(o);
    }
    const confere = linha?.tentativa === u && linha.situacao === 'VERIFICACAO_PENDENTE' && linha.versao === 1 && linha.tem_corpo === true;
    if (!confere) o.linha(`REGISTRO_DESATUALIZADO tentativa=${u} linha da 129 não confere (${linha ? `${linha.tentativa} ${linha.situacao} versao=${linha.versao} corpo=${linha.tem_corpo ? 'sim' : 'nao'}` : 'ausente'})`, 2);
    else if (pf.aprovado) {
      const w = await escreverPosCommit(ctx, db, o, '129', linha, 'CONCLUIDA', {conclusao: {postcheck: 'PASS'}});
      if (w) o.linha('APLICADA_POSTCHECK_PASS 129', 0);
    } else {
      const w = await escreverPosCommit(ctx, db, o, '129', linha, 'FALHA', {falha: {fase: 'postcheck_final', motivo: pf.motivo}});
      if (w) o.linha(`FALHA 129 tentativa=${u} postcheck=${pf.motivo} (ver --concluir-verificacao 129)`, 2);
    }
    return fim(o);
  } catch (e) {
    o.linha(e?.saida ? curta(e) : 'ERRO ' + curta(e), e?.codigo ?? 1);
    return fim(o);
  } finally { await encerrarC(ctx, db); }
}

// ---------------------------------------------------------------- leitura da tupla (arquivar e concluir)
async function lerTupla(ctx, db, o, id, u) {
  const l = (await lerEmC(db, SQL.porUuid, [u])).rows?.[0];
  if (!l) { o.linha('TENTATIVA_AUSENTE tentativa=' + u, 1); return null; }
  if (l.ambiente !== ctx.ambiente.nome || l.migration !== id) { o.linha(`TENTATIVA_DE_OUTRA_MIGRATION tentativa=${u} ambiente=${l.ambiente} migration=${l.migration}`, 1); return null; }
  if (l.arquivada) { o.linha(`TENTATIVA_ARQUIVADA tentativa=${u} substituida_por=${l.substituida_por ?? 'nenhuma'}`, 1); return null; }
  return l;
}

// ---------------------------------------------------------------- --arquivar-tentativa (§3.3)
async function arquivar(ctx, {id, tentativa: u, motivo}) {
  const o = saida(ctx);
  const db = clienteC(ctx, id);
  try {
    await db.connect();
    await identidadeEmC(ctx, db);
    await exigirRegistro(ctx, db, {estrutural: id === '129'});
    if (id === '129') { o.linha('LINHA_129_NAO_ARQUIVA', 1); return fim(o); }
    await travar(ctx, db, id);
    const l = await lerTupla(ctx, db, o, id, u);
    if (!l) return fim(o);
    const estado = await estadoEmC(db, id);
    if (estado.situacao === 'parcial') { o.linha('ESTADO_PARCIAL_REVISAR ' + id, 1); return fim(o); }
    if (l.tem_corpo || l.tem_chave_corpo || l.situacao === 'CONCLUIDA') {
      o.linha(estado.situacao === 'presente' ? (l.situacao === 'CONCLUIDA' ? 'TENTATIVA_CONCLUIDA_NAO_ARQUIVA ' + u : 'USAR_CONCLUIR_VERIFICACAO ' + u) : 'DIVERGENCIA_REGISTRO_ESTADO ' + u,
        estado.situacao === 'presente' ? 1 : 3);
      return fim(o);
    }
    if (estado.situacao !== 'ausente') { o.linha('ESTADO_SEM_REGISTRO_REVISAR ' + id, 1); return fim(o); }
    if (!['INICIADA', 'FALHA'].includes(l.situacao)) { o.linha(`ARQUIVAMENTO_RECUSADO ${u} ${l.situacao}`, 1); return fim(o); }
    const r = await db.query(SQL.arquivar, [ctx.ambiente.nome, id, u, l.versao, l.situacao, motivo, JSON.stringify({reconciliacao: {arquivada: true, situacao: l.situacao}})]);
    if (r.rowCount !== 1) { o.linha('REGISTRO_DESATUALIZADO tentativa=' + u, 2); return fim(o); }
    o.linha(`${linhaTexto(ctx, id, u, l.situacao, r.rows[0].versao)} ARQUIVADA`, 0);
    return fim(o);
  } catch (e) {
    o.linha(e?.saida ? curta(e) : 'ERRO ' + curta(e), e?.codigo ?? 1);
    return fim(o);
  } finally { await encerrarC(ctx, db); }
}

// ---------------------------------------------------------------- --concluir-verificacao (§3.3a)
async function concluirVerificacao(ctx, {id, tentativa: u}) {
  const o = saida(ctx);
  const db = clienteC(ctx, id);
  try {
    await db.connect();
    await identidadeEmC(ctx, db);
    await exigirRegistro(ctx, db, {estrutural: id === '129'});
    await travar(ctx, db, id);
    const l = await lerTupla(ctx, db, o, id, u);
    if (!l) return fim(o);
    // Evidência estruturada em TODOS os caminhos, inclusive a 129 em VERIFICACAO_PENDENTE ({"corpo":null} não serve).
    const comEvidencia = l.tem_corpo === true && (['EM_ANDAMENTO', 'FALHA'].includes(l.situacao) || (id === '129' && l.situacao === 'VERIFICACAO_PENDENTE'));
    if (!comEvidencia) { o.linha(`CONCLUSAO_RECUSADA ${u} ${l.situacao} corpo=${l.tem_corpo ? 'sim' : 'nao'}`, 1); return fim(o); }
    const corpos = carregarId(ctx.raiz, id);
    const estado = await estadoEmC(db, id);
    if (estado.situacao === 'ausente') { o.linha('DIVERGENCIA_REGISTRO_ESTADO ' + u, 3); return fim(o); }
    if (estado.situacao === 'parcial') { o.linha('ESTADO_PARCIAL_REVISAR ' + id, 1); return fim(o); }
    const pc = await postcheckEmC(db, corpos);
    if (!pc.aprovado) { o.linha(`POSTCHECK ${id} FALHOU ${pc.motivo}`, 3); return fim(o); }
    const w = await escreverLinha(ctx, db, o, id, l, 'CONCLUIDA', {conclusao: {postcheck: 'PASS', de: l.situacao, por: 'concluir-verificacao'}});
    if (w) o.linha(`CONCLUIDA ${id} tentativa=${u}`, 0);
    return fim(o);
  } catch (e) {
    o.linha(e?.saida ? curta(e) : 'ERRO ' + curta(e), e?.codigo ?? 1);
    return fim(o);
  } finally { await encerrarC(ctx, db); }
}

// ---------------------------------------------------------------- --conferir-<id> (§3.2 passo 9), sessões de leitura
async function conferirId(ctx, {id}) {
  const o = saida(ctx);
  const amb = ctx.ambiente.nome;
  const corpos = gen.carregar(ctx.raiz, id);
  const ant = ANTECESSORA[id];
  const p129 = carregar129(ctx.raiz).postcheck;
  const publicar = s => {
    for (const f of s.fatos) o.linha(f.texto, f.codigo);
    if (s.identidadeRecusada) o.linha('IDENTIDADE_RECUSADA ' + s.identidadeRecusada, 1);
    if (s.recusa) o.linha(s.recusa, 1);
    if (s.falha) o.linha(textoFalha(s), 1);
  };
  let registroOk = false;
  const sr = await abrirSessaoLeitura(ctx, 'REGISTRO', async s => {
    const sd = await s.instrucao('SONDAGEM', SQL.sondagem);
    if (sd.rows?.[0]?.tabela == null) { s.fato('REGISTRO_INVALIDO tabela ausente', 1); return; }
    let div;
    try { div = lerDivergencias(await s.instrucao('ESTRUTURA', p129)); } catch (e) { if (e === PARADA) throw e; throw new ErroLocal('lerDivergencias', e); }
    if (div.length) { s.fato('REGISTRO_INVALIDO ' + div.join('; '), 1); return; }
    const l = (await s.instrucao('LINHA_129', SQL.ativa, [amb, '129'])).rows?.[0];
    if (l?.situacao !== 'CONCLUIDA') { s.fato(l ? `REGISTRO_PENDENTE 129 ${l.situacao}` : 'REGISTRO_SEM_LINHA_129', 3); return; }
    registroOk = true;
  });
  publicar(sr);
  if (!registroOk || sr.falha) return fim(o);
  let linha = null;
  const si = await abrirSessaoLeitura(ctx, 'CONFERIR ' + id, async s => {
    linha = (await s.instrucao('LINHA', SQL.ativa, [amb, id])).rows?.[0] ?? null;
    s.fato(linha ? `LINHA_ATIVA ${id} tentativa=${linha.tentativa} ${descreverLinha(linha)}` : `LINHA_ATIVA ${id} nenhuma`, 0);
    const t = await s.instrucao('TRAVA', SQL.travaOcupada, [chaveTrava(amb, id)]);
    s.fato(`TRAVA ${amb}:${id} ${t.rows?.[0]?.ocupada ? 'OCUPADA' : 'livre'}`, 0);
    const e = await estadoComPostcheck(ctx, s, id, corpos);
    const cl = classificar(id, e, linha, e.postcheck ?? null);
    s.fato(cl.texto, cl.codigo);
  });
  publicar(si);
  if (si.identidadeRecusada) return fim(o);
  const sa = await abrirSessaoLeitura(ctx, 'ANTECESSORA ' + ant, async s => {
    const la = (await s.instrucao('LINHA', SQL.ativa, [amb, ant])).rows?.[0] ?? null;
    if (la?.situacao !== 'CONCLUIDA') { s.fato(`ANTECESSORA ${ant} PENDENTE ${la ? la.situacao : 'sem linha'} (informativo)`, 0); return; }
    if (ant === '129') { s.fato('ANTECESSORA 129 CONCLUIDA estrutura=PASS (informativo)', 0); return; }
    const e = await estadoComPostcheck(ctx, s, ant, gen.carregar(ctx.raiz, ant));
    s.fato(`ANTECESSORA ${ant} CONCLUIDA estado=${e.situacao}${e.postcheck ? ' postcheck=' + (e.postcheck.aprovado ? 'PASS' : 'FALHOU') : ''} (informativo)`, 0);
  });
  // Informativo: só os erros de verificação contam no código, os fatos da antecessora não (POSTCHECK FALHOU dela vira 0).
  for (const f of sa.fatos) o.linha(f.texto, 0);
  if (sa.identidadeRecusada) o.linha('IDENTIDADE_RECUSADA ' + sa.identidadeRecusada, 1);
  if (sa.recusa) o.linha(sa.recusa, 1);
  if (sa.falha) o.linha(textoFalha(sa), 1);
  return fim(o);
}

// ---------------------------------------------------------------- argumentos
function modo(argv) {
  const a = [...argv];
  assert.ok(a[0] === '--ambiente' && AMBIENTES_VALIDOS.includes(a[1]), 'AMBIENTE_OBRIGATORIO');
  const ambiente = a[1];
  const r = a.slice(2);
  const exigirId = (id, flag) => {
    if (ORDEM.includes(id)) return id;
    if (id === '129' && ESCOPO_129.includes(flag)) return id;
    throw recusa('ID_FORA_DO_REGISTRO ' + id, 1);
  };
  const exigirUuid = u => { assert.match(String(u ?? ''), UUID, 'TENTATIVA_INVALIDA'); return u; };
  if (r[0] === '--conferir-registro') {
    const tentativas = [];
    let ids = [...ORDEM];
    for (let i = 1; i < r.length; i += 2) {
      if (r[i] === '--tentativa') tentativas.push(exigirUuid(r[i + 1]));
      else if (r[i] === '--ids') { assert.match(String(r[i + 1] ?? ''), /^[0-9]{3}[a-z]?(,[0-9]{3}[a-z]?)*$/, 'IDS_INVALIDOS'); ids = r[i + 1].split(','); }
      else assert.fail('ARGUMENTOS_RECUSADOS');
    }
    return {ambiente, modo: 'conferir-registro', tentativas, ids};
  }
  if (r[0] === '--conferir-tentativa' && r.length === 4 && r[2] === '--tentativa') return {ambiente, modo: 'conferir-tentativa', id: exigirId(r[1], r[0]), tentativa: exigirUuid(r[3])};
  if (r[0] === '--concluir-verificacao' && r.length === 4 && r[2] === '--tentativa') return {ambiente, modo: 'concluir', id: exigirId(r[1], r[0]), tentativa: exigirUuid(r[3])};
  if (r[0] === '--arquivar-tentativa' && r.length === 6 && r[2] === '--tentativa' && r[4] === '--motivo') {
    const motivo = String(r[5]);
    assert.ok(motivo.length >= 10 && motivo.length <= 300 && !/[\u0000-\u001f]/.test(motivo), 'MOTIVO_INVALIDO');
    return {ambiente, modo: 'arquivar', id: exigirId(r[1], r[0]), tentativa: exigirUuid(r[3]), motivo};
  }
  if (r[0] === '--aplicar-129-bootstrap-autorizado') {
    assert.ok((r.length === 3 || r.length === 5) && r[1] === '--backup', 'BACKUP_OBRIGATORIO');
    assert.match(r[2], BACKUP, 'BACKUP_INVALIDO');
    if (r.length === 3) return {ambiente, modo: 'bootstrap', backup: r[2]};
    assert.ok(r[3] === '--franquia-flag-ligada', 'ARGUMENTOS_RECUSADOS');
    return {ambiente, modo: 'bootstrap', backup: r[2], flagFranquia: r[4]};
  }
  let m = /^--aplicar-([0-9]{3}[a-z]?)(?:-autorizado)?$/.exec(r[0] ?? '');
  if (m) {
    if (!ORDEM.includes(m[1])) throw recusa('ID_FORA_DO_REGISTRO ' + m[1], 1);
    const pt = PORTOES[m[1]];
    assert.ok(r[0] === `--aplicar-${m[1]}-autorizado` && r.length >= 3 && r[1] === '--backup', 'BACKUP_OBRIGATORIO');
    assert.match(r[2], BACKUP, 'BACKUP_INVALIDO');
    if (!pt) { assert.ok(r.length === 3, 'ARGUMENTOS_RECUSADOS'); return {ambiente, modo: 'aplicar', id: m[1], backup: r[2]}; }
    if (r.length !== 5 || r[3] !== pt.flag) throw recusa(`PORTAO_OBRIGATORIO ${m[1]} (${pt.flag} "<registro da conferência>")`, 1);
    const declarado = validarPortao(r[4]);
    assert.ok(declarado !== null, 'PORTAO_INVALIDO');
    return {ambiente, modo: 'aplicar', id: m[1], backup: r[2], portao: declarado};
  }
  m = /^--conferir-([0-9]{3}[a-z]?)$/.exec(r[0] ?? '');
  if (m && r.length === 1) {
    if (!ORDEM.includes(m[1])) throw recusa('ID_FORA_DO_REGISTRO ' + m[1], 1);
    return {ambiente, modo: 'conferir-id', id: m[1]};
  }
  assert.fail('ARGUMENTOS_RECUSADOS');
}

async function principal(argv, env, deps = {}) {
  let m;
  try { m = modo(argv); } catch (e) { const t = e?.saida ?? 'RECUSADO ' + curta(e); (deps.out ?? (() => {}))(t); return {codigo: 1, linhas: [t]}; }
  let ctx;
  try {
    // §8.1: declaração da flag presa ao ambiente da chamada e do alvo; diferente = recusa antes de conectar (código 1).
    if (m.flagFranquia !== undefined) require('./conferir-antecessoras.cjs').lerDeclaracaoFlag(m.flagFranquia, m.ambiente, env);
    ctx = {env, raiz: deps.raiz ?? raizPadrao, Client: deps.Client ?? require('pg').Client, ambiente: ambienteDe(m.ambiente, env, deps), ganchos: deps.ganchos,
      out: deps.out, uuid: deps.uuid, agora: deps.agora, antecessoras: deps.antecessoras, prazoRollback: deps.prazoRollback, prazoDescarte: deps.prazoDescarte,
      prazoLiquidacao: deps.prazoLiquidacao, prazoCommit: deps.prazoCommit, prazoEscrita: deps.prazoEscrita, clientInjetado: Boolean(deps.Client)};
    ctx.ambiente.alvo(`kidmais-registro-${m.ambiente}-alvo`); // valida o alvo antes de conectar
  } catch (e) { const t = 'RECUSADO ' + curta(e); (deps.out ?? (() => {}))(t); return {codigo: 1, linhas: [t]}; }
  switch (m.modo) {
    case 'conferir-registro': return conferirRegistro(ctx, m);
    case 'conferir-tentativa': return conferirTentativa(ctx, m);
    case 'conferir-id': return conferirId(ctx, m);
    case 'aplicar': return aplicar(ctx, m);
    case 'bootstrap': return bootstrap129(ctx, m);
    case 'arquivar': return arquivar(ctx, m);
    case 'concluir': return concluirVerificacao(ctx, m);
    default: assert.fail('MODO');
  }
}
function cli() {
  principal(process.argv.slice(2), process.env, {out: t => console.log(t)})
    .then(({codigo}) => { console.log('CODIGO ' + codigo); process.exitCode = codigo; })
    .catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
if (require.main === module) cli();
module.exports = {ORDEM, chaveTrava, CHAVES_TRAVA, ANTECESSORA, PORTOES, PORTAO_TEXTO, validarPortao, ARQUIVOS_129, SQL, BACKUP, carregar129, lerDivergencias, avaliarPostcheck, sqlstateDe, fatal, abrirSessaoLeitura,
  conferirRegistro, conferirTentativa, conferirId, aplicar, bootstrap129, arquivar, concluirVerificacao, classificar, modo, principal, ambienteDe, cli,
  /** Só para testes unitários (cliente falso). */
  _teste: {lerEmC, postcheckEmC}};
