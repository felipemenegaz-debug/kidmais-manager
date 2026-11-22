/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual das antecessoras da 129 que staging nunca recebeu (120, 121, 110, 111, 115), SOMENTE no PostgreSQL do
// web de staging, no Web Shell do srv-daif418ae00c73e8k2gg, DEPOIS do deploy do código que traz este aplicador e os SQL.
// Plano "Staging em dia antes da 129" (vault, 22/11/2026), §3.1 com as correções 7.1, 7.3, 7.4 e 8.3, e as da Astra r1 do
// código: a 111 segura também a trava da 110 antes de lê-la (no conferir e no aplicar), plano com as paradas do §7.6/7.7,
// backup pelo mesmo validador nas duas entradas e end() com prazo também depois de um connect() rejeitado.
// Núcleo: o aplicador genérico de production (scripts/migration-generico-production.cjs: lista fechada com o sha256 LF,
// sentinelas, privilégios, precheck → migration → postcheck numa transação, situação do COMMIT). Aqui mudam o alvo
// (validação rígida do adaptador da 116 de staging), a identidade (scripts/conexao-staging.cjs) e o registro:
// SEM marcador em disco (o disco de staging foi removido; D-SED-1 A). A exclusão entre executores é a trava advisory de
// SESSÃO da mesma família do registro de migrations (chave staging:<id>), pega antes de qualquer leitura; a saída
// (uma linha JSON por etapa e o JSON final) é o registro da tentativa e fica no diário do Felipe.
//   node scripts/migration-generico-staging.cjs                                              → plano, sem conexão
//   node scripts/migration-generico-staging.cjs --conferir <id>                              → somente leitura (com a trava)
//   node scripts/migration-generico-staging.cjs --aplicar-autorizado <id> --backup "<registro>" → uma vez
// Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar; 2 FALHA ou NAO_CONCLUSIVO; 3 RECUSARIA, EXECUTOR_ATIVO
// ou ANTECESSORA_PENDENTE. FALHA com commit INDETERMINADO: não repetir; rodar --conferir <id> e colar a saída.
const assert = require('node:assert/strict');
const path = require('node:path');
const gen = require('./migration-generico-production.cjs');
const stg = require('./conexao-staging.cjs');
const s116 = require('./migration-116-staging.cjs');
const reg = require('./registro-migrations-banco.cjs');

const AMBIENTE = 'staging';
/** Lista fechada, na ordem de aplicação do plano (§3.1). Fora dela: ID_FORA_DA_LISTA (código 1). */
const IDS = Object.freeze(['120', '121', '110', '111', '115']);
/** Antecessora exigida dentro desta lista: a 111 só com a 110 JA_APLICADA_POSTCHECK_PASS. */
const EXIGE = Object.freeze({'111': '110'});
const ALVO = s116.ALVO;
const FLAG_CONFERIR = '--conferir';
const FLAG_APLICAR = '--aplicar-autorizado';
const FLAG_BACKUP = '--backup';
const BACKUP = /^[A-Za-z0-9:._/ -]{6,120}$/;
const CODIGO = Object.freeze({...gen.CODIGO, NAO_CONCLUSIVO: 2, EXECUTOR_ATIVO: 3, ANTECESSORA_PENDENTE: 3});
const SQL = Object.freeze({
  trava: reg.SQL.travaSessao,
  destrava: "SELECT pg_advisory_unlock(hashtext('kidmais-migration'), hashtext($1::text)) AS ok",
});
const chave = id => reg.chaveTrava(AMBIENTE, id);
/** Chaves que este adaptador trava: insumo do teste de colisão de hashtext com as do registro (8.4). */
const CHAVES_TRAVA = Object.freeze(IDS.map(chave));
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);
const raizPadrao = path.resolve(__dirname, '..');
const agoraPadrao = () => new Date();

/** Mesma validação do adaptador da 116 de staging (serviço, ambiente, host, banco, porta, PG* herdadas, controle, TLS). */
function alvo(env) {
  const cfg = s116.alvo(env);
  cfg.application_name = 'kidmais-migration-generico-staging';
  return cfg;
}
const identidadeDe = env => linha => {
  try { return stg.conferirIdentidade(linha, env); } catch (e) { assert.fail('IDENTIDADE_RECUSADA ' + String(e?.message ?? '').slice(0, 40)); }
};
function exigirId(id) { if (!IDS.includes(id)) assert.fail('ID_FORA_DA_LISTA ' + String(id).slice(0, 20)); return id; }
/**
 * Registro do backup, o MESMO validador na CLI e na chamada direta (Astra r1 do código): string, sem espaço nas pontas, na
 * regex e com pelo menos um caractere alfanumérico (seis espaços ou "------" não registram backup nenhum).
 */
function exigirBackup(backup, erro) {
  if (typeof backup !== 'string' || backup !== backup.trim() || !BACKUP.test(backup) || !/[A-Za-z0-9]/.test(backup)) assert.fail(erro);
  return backup;
}
/** Ids cuja trava a operação pega, na ordem: o próprio e a antecessora exigida (a 111 também segura a 110 antes de lê-la). */
const travasDe = id => (EXIGE[id] ? [id, EXIGE[id]] : [id]);

function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 2 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir', id: exigirId(argv[1])};
  if (argv[0] === FLAG_APLICAR && argv.length >= 2) exigirId(argv[1]);
  if (argv.length === 4 && argv[0] === FLAG_APLICAR && argv[2] === FLAG_BACKUP) {
    return {modo: 'aplicar', id: argv[1], backup: exigirBackup(argv[3], 'BACKUP_INVALIDO')};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

const passo = id => `${id}: ${FLAG_CONFERIR} ${id} → ${FLAG_APLICAR} ${id} ${FLAG_BACKUP} "<registro>" → ${FLAG_CONFERIR} ${id}`;
/** Consulta só de leitura das três tabelas da satisfação (§7.6), para colar no mesmo Shell depois da 110 e da 111. */
const SQL_CONTAGENS_SATISFACAO = 'SELECT (SELECT count(*) FROM satisfacao_envios) AS envios, (SELECT count(*) FROM satisfacao_entregas) AS entregas, ' +
  '(SELECT count(*) FROM satisfacao_respostas) AS respostas';
const CONTAGENS = quando => `PARADA contagens depois da ${quando} (§7.6): ${SQL_CONTAGENS_SATISFACAO} ⇒ as três = 0; qualquer linha ⇒ parar antes do passo seguinte`;
/**
 * Sequência do plano §7.7 com as paradas objetivas do §7.6 entre as migrations (Astra r1 do código): quem segue esta saída
 * para nas envs da satisfação antes da 110, no financeiro depois da 121 e nas contagens depois da 110 e da 111.
 */
const ORDEM = Object.freeze([
  'árvore implantada no web de staging com este aplicador e os SQL (conferir o commit implantado)',
  'backup de staging registrado', 'sim de Felipe para a lista em staging',
  'PARADA satisfação (§7.6): printenv SATISFACAO_PESQUISA_ENABLED no web de staging e a mesma env no cron de marketing/automações de staging; ' +
    'valor diferente de vazio ou false em qualquer um ⇒ parar sem aplicar nada; registrar valor e onde foi lido',
  'financeiro antes da 120 (§7.6): anotar o esperado para a empresa SMOKE-STAGING (hoje, sem as tabelas, saldo nulo)',
  passo('120'), passo('121'),
  'PARADA financeiro depois da 121 (§7.6): SMOKE-STAGING com saldoInicialCentavos null, saldoFinalCentavos null, motivoSaldo SEM_ABERTURA, ' +
    'tela do financeiro sem erro e financeiro_aberturas com 0 linhas; divergência ⇒ parar antes da 110',
  passo('110'), CONTAGENS('110'),
  passo('111'), CONTAGENS('111'),
  passo('115'),
]);

function plano({raiz = raizPadrao} = {}) {
  return {resultado: 'PLANO', conecta: false, ambiente: AMBIENTE, alvo: ALVO, registro: 'saída do aplicador (sem marcador em disco)',
    trava: 'pg_try_advisory_lock de sessão, chave staging:<id> (mesma família do registro de migrations)',
    ids: IDS.map(id => {
      const def = gen.MIGRATIONS[id]; gen.carregar(raiz, id);
      return {id, escopo: def.escopo, arquivos: def.arquivos.map(([etapa, arquivo, hash]) => ({etapa, arquivo, sha256: hash})),
        sentinelas: def.criados.map(([n]) => n), ...(EXIGE[id] ? {exige: EXIGE[id]} : {})};
    }),
    modos: {conferir: `${FLAG_CONFERIR} <id>`, aplicar: `${FLAG_APLICAR} <id> ${FLAG_BACKUP} <registro-do-backup>`},
    ordem: ORDEM,
    paradas: ['qualquer código ≠ 0: parar e colar a saída inteira; não repetir',
      'qualquer conferência das envs de satisfação, do financeiro ou das contagens fora do critério: parar antes do passo seguinte',
      'FALHA com commit INDETERMINADO: não repetir; rodar --conferir <id> e colar',
      'EXECUTOR_ATIVO: outro executor tem a trava; esperar e conferir'],
    nuncaExecuta: ['down', 'outra migration', '129/130/131 (registro de migrations)', 'alteração de env', 'deploy', 'restart', 'production']};
}

const PRAZO_END_MS = 5000;
/** end() com prazo: depois de um connect() rejeitado o pg pode nunca resolver; o prazo vira diagnóstico de limpeza. */
function encerrar(db, prazo = PRAZO_END_MS) {
  let t;
  const tempo = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('END_SEM_RESPOSTA')), prazo); t.unref?.(); });
  return Promise.race([Promise.resolve().then(() => db.end()), tempo]).finally(() => clearTimeout(t));
}

/**
 * Uma conexão; as travas de sessão de `ids` (o próprio id e a antecessora exigida), na ordem, antes de qualquer leitura (7.1);
 * a primeira ocupada encerra sem ler. No finally, cada unlock e o end no seu try/catch, inclusive quando o connect() falhou:
 * erro de limpeza vira o campo `limpeza` e nunca substitui o resultado nem o código (8.3).
 */
async function comTrava({opts, Client, ids, ocupada, acao, falha, prazoEnd}) {
  const db = new Client(opts); db.on?.('error', () => undefined);
  const limpeza = [], travadas = [];
  let conectada = false, saida;
  try {
    await db.connect(); conectada = true;
    let busy = null;
    for (const id of ids) {
      const ok = (await db.query(SQL.trava, [chave(id)])).rows?.[0]?.ok;
      if (ok !== true) { busy = id; break; }
      travadas.push(id);
    }
    saida = busy ? ocupada(busy) : await acao(db);
  } catch (e) {
    if (conectada) await db.query('ROLLBACK').catch(() => {});
    saida = falha(e);
  } finally {
    for (const id of [...travadas].reverse()) {
      try {
        const u = (await db.query(SQL.destrava, [chave(id)])).rows?.[0]?.ok;
        if (u !== true) limpeza.push('UNLOCK_SEM_TRAVA ' + chave(id));
      } catch (e) { limpeza.push('UNLOCK ' + curta(e)); }
    }
    try { await encerrar(db, prazoEnd); } catch (e) { limpeza.push('END ' + curta(e)); }
  }
  return limpeza.length ? {...saida, limpeza: limpeza.join('; ')} : saida;
}

/**
 * Antecessora exigida (a 111 exige a 110), a MESMA regra no conferir e no aplicar, lida já com a trava da antecessora:
 * null = sem exigência ou JA_APLICADA_POSTCHECK_PASS; senão o motivo ANTECESSORA_PENDENTE.
 */
async function antecessoraPendente(db, id, {raiz, ident}) {
  if (!EXIGE[id]) return null;
  const a = await gen.conferirNoCliente(db, {id: EXIGE[id], raiz, ...ident});
  if (a.resultado === 'JA_APLICADA_POSTCHECK_PASS') return null;
  return `ANTECESSORA_PENDENTE ${EXIGE[id]} ${a.resultado}${a.motivo ? ' ' + a.motivo : ''}`.slice(0, 300);
}

async function conferir({env, id, raiz = raizPadrao, Client = require('pg').Client, prazoEnd}) {
  exigirId(id);
  const opts = alvo(env);
  for (const x of travasDe(id)) gen.carregar(raiz, x);
  const ident = {sqlIdentidade: stg.SQL_IDENTIDADE, identidade: identidadeDe(env)};
  const base = {modo: 'conferencia', ambiente: AMBIENTE, id};
  return comTrava({opts, Client, ids: travasDe(id), prazoEnd,
    ocupada: x => ({...base, resultado: 'NAO_CONCLUSIVO', motivo: 'EXECUTOR_ATIVO ' + x}),
    acao: async db => {
      const ant = await antecessoraPendente(db, id, {raiz, ident});
      if (ant) return {...base, resultado: 'ANTECESSORA_PENDENTE', motivo: ant};
      return {...base, ...(await gen.conferirNoCliente(db, {id, raiz, ...ident}))};
    },
    falha: e => ({...base, resultado: 'FALHA', mensagem: curta(e)})});
}

const commitDe = r => [...(r?.etapas ?? [])].reverse().find(x => x.commit)?.commit;

async function executar({env, id, backup, raiz = raizPadrao, Client = require('pg').Client, agora = agoraPadrao, out = () => {}, prazoEnd}) {
  // 7.3: tudo validado antes de criar o cliente; cada recusa lança (código 1) sem conexão.
  exigirId(id);
  exigirBackup(backup, 'BACKUP_OBRIGATORIO');
  const opts = alvo(env);
  for (const x of travasDe(id)) gen.carregar(raiz, x);
  const ident = {sqlIdentidade: stg.SQL_IDENTIDADE, identidade: identidadeDe(env)};
  const base = () => ({ambiente: AMBIENTE, id, em: agora().toISOString(), backup});
  let ultimo = null, estadoAntes;
  return comTrava({opts, Client, ids: travasDe(id), prazoEnd,
    ocupada: x => ({...base(), resultado: 'EXECUTOR_ATIVO', motivo: 'EXECUTOR_ATIVO ' + x, commit: 'NAO_COMMITADA'}),
    acao: async db => {
      const ant = await antecessoraPendente(db, id, {raiz, ident});
      if (ant) return {...base(), resultado: 'ANTECESSORA_PENDENTE', motivo: ant, commit: 'NAO_COMMITADA'};
      const c = await gen.conferirNoCliente(db, {id, raiz, ...ident});
      estadoAntes = c.estado;
      if (c.resultado === 'JA_APLICADA_POSTCHECK_PASS') {
        return {...base(), resultado: c.resultado, estadoAntes: c.estado, estadoDepois: c.estado, commit: 'NAO_APLICAVEL', checks: c.checks};
      }
      if (c.resultado !== 'PRONTA_PARA_APLICAR') {
        return {...base(), resultado: 'RECUSARIA', motivo: c.motivo ?? c.resultado, estadoAntes: c.estado, commit: 'NAO_COMMITADA', checks: c.checks};
      }
      const r = await gen.aplicarNoCliente(db, {id, raiz, ...ident, registrar: x => {
        ultimo = JSON.parse(JSON.stringify(x));
        try { out(JSON.stringify({etapa: ultimo.etapas?.at(-1)?.nome ?? 'conferencia', id, commit: commitDe(ultimo) ?? null, em: agora().toISOString()})); } catch { /* saída é informativa */ }
      }});
      return {...base(), resultado: r.resultado, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        commit: commitDe(r) ?? 'NAO_APLICAVEL', etapas: r.etapas.map(e => e.nome)};
    },
    // 7.4: exceção depois de começar a aplicar = FALHA (código 2) com a situação do COMMIT do último registro.
    falha: e => {
      const commit = commitDe(ultimo) ?? 'NAO_COMMITADA';
      return {...base(), resultado: 'FALHA', mensagem: curta(e), etapa: ultimo?.etapas?.at(-1)?.nome ?? 'CONEXAO',
        ...(estadoAntes ? {estadoAntes} : {}), commit, ...(ultimo ? {ultimo} : {}),
        reconciliar: commit === 'NAO_COMMITADA' ? 'nada confirmado; conferir antes de decidir' : `não repetir; rodar ${FLAG_CONFERIR} ${id} e colar`};
    }});
}

async function principal(argv, env, deps = {}) {
  const m = modo(argv);
  if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
  const s = m.modo === 'conferir' ? await conferir({env, id: m.id, ...deps}) : await executar({env, id: m.id, backup: m.backup, ...deps});
  return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
}
function cli() {
  principal(process.argv.slice(2), process.env, {out: l => console.log(l)}).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
if (require.main === module) cli();
module.exports = {AMBIENTE, IDS, EXIGE, ALVO, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, CODIGO, SQL, CHAVES_TRAVA, ORDEM, SQL_CONTAGENS_SATISFACAO,
  chave, alvo, modo, plano, exigirBackup, travasDe, comTrava, encerrar, conferir, executar, principal, cli};
