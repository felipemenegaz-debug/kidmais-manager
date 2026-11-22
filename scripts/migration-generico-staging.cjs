/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual das antecessoras da 129 que staging nunca recebeu (120, 121, 110, 111, 115), SOMENTE no PostgreSQL do
// web de staging, no Web Shell do srv-daif418ae00c73e8k2gg, DEPOIS do deploy do código que traz este aplicador e os SQL.
// Plano "Staging em dia antes da 129" (vault, 22/11/2026), §3.1 com as correções 7.1, 7.3, 7.4 e 8.3.
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

function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 2 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir', id: exigirId(argv[1])};
  if (argv[0] === FLAG_APLICAR && argv.length >= 2) exigirId(argv[1]);
  if (argv.length === 4 && argv[0] === FLAG_APLICAR && argv[2] === FLAG_BACKUP) {
    assert.match(argv[3], BACKUP, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', id: argv[1], backup: argv[3]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

function plano({raiz = raizPadrao} = {}) {
  return {resultado: 'PLANO', conecta: false, ambiente: AMBIENTE, alvo: ALVO, registro: 'saída do aplicador (sem marcador em disco)',
    trava: 'pg_try_advisory_lock de sessão, chave staging:<id> (mesma família do registro de migrations)',
    ids: IDS.map(id => {
      const def = gen.MIGRATIONS[id]; gen.carregar(raiz, id);
      return {id, escopo: def.escopo, arquivos: def.arquivos.map(([etapa, arquivo, hash]) => ({etapa, arquivo, sha256: hash})),
        sentinelas: def.criados.map(([n]) => n), ...(EXIGE[id] ? {exige: EXIGE[id]} : {})};
    }),
    modos: {conferir: `${FLAG_CONFERIR} <id>`, aplicar: `${FLAG_APLICAR} <id> ${FLAG_BACKUP} <registro-do-backup>`},
    ordem: ['árvore implantada no web de staging com este aplicador e os SQL (conferir o commit implantado)',
      'backup de staging registrado', 'sim de Felipe para a lista em staging',
      ...IDS.map(id => `${id}: ${FLAG_CONFERIR} ${id} → ${FLAG_APLICAR} ${id} ${FLAG_BACKUP} "<registro>" → ${FLAG_CONFERIR} ${id}`)],
    paradas: ['qualquer código ≠ 0: parar e colar a saída inteira; não repetir',
      'FALHA com commit INDETERMINADO: não repetir; rodar --conferir <id> e colar',
      'EXECUTOR_ATIVO: outro executor tem a trava; esperar e conferir'],
    nuncaExecuta: ['down', 'outra migration', '129/130/131 (registro de migrations)', 'alteração de env', 'deploy', 'restart', 'production']};
}

/**
 * Uma conexão, a trava de sessão antes de qualquer leitura (7.1) e, no finally, unlock e end cada um no seu try/catch:
 * erro de limpeza vira o campo `limpeza` e nunca substitui o resultado (8.3).
 */
async function comTrava({opts, Client, id, ocupada, acao, falha}) {
  const db = new Client(opts); db.on?.('error', () => undefined);
  const limpeza = [];
  let conectada = false, travada = false, saida;
  try {
    await db.connect(); conectada = true;
    const ok = (await db.query(SQL.trava, [chave(id)])).rows?.[0]?.ok;
    if (ok !== true) saida = ocupada();
    else { travada = true; saida = await acao(db); }
  } catch (e) {
    if (conectada) await db.query('ROLLBACK').catch(() => {});
    saida = falha(e);
  } finally {
    if (travada) {
      try {
        const u = (await db.query(SQL.destrava, [chave(id)])).rows?.[0]?.ok;
        if (u !== true) limpeza.push('UNLOCK_SEM_TRAVA ' + chave(id));
      } catch (e) { limpeza.push('UNLOCK ' + curta(e)); }
    }
    // Conexão que não abriu: o pg já fechou o socket (mesma regra dos outros aplicadores).
    if (conectada) { try { await db.end(); } catch (e) { limpeza.push('END ' + curta(e)); } }
  }
  return limpeza.length ? {...saida, limpeza: limpeza.join('; ')} : saida;
}

async function conferir({env, id, raiz = raizPadrao, Client = require('pg').Client}) {
  exigirId(id);
  const opts = alvo(env);
  gen.carregar(raiz, id);
  const base = {modo: 'conferencia', ambiente: AMBIENTE, id};
  return comTrava({opts, Client, id,
    ocupada: () => ({...base, resultado: 'NAO_CONCLUSIVO', motivo: 'EXECUTOR_ATIVO ' + id}),
    acao: db => gen.conferirNoCliente(db, {id, raiz, sqlIdentidade: stg.SQL_IDENTIDADE, identidade: identidadeDe(env)}).then(r => ({...base, ...r})),
    falha: e => ({...base, resultado: 'FALHA', mensagem: curta(e)})});
}

const commitDe = r => [...(r?.etapas ?? [])].reverse().find(x => x.commit)?.commit;

async function executar({env, id, backup, raiz = raizPadrao, Client = require('pg').Client, agora = agoraPadrao, out = () => {}}) {
  // 7.3: tudo validado antes de criar o cliente; cada recusa lança (código 1) sem conexão.
  exigirId(id);
  assert.match(String(backup ?? ''), BACKUP, 'BACKUP_OBRIGATORIO');
  const opts = alvo(env);
  gen.carregar(raiz, id);
  const ident = {sqlIdentidade: stg.SQL_IDENTIDADE, identidade: identidadeDe(env)};
  const base = () => ({ambiente: AMBIENTE, id, em: agora().toISOString(), backup});
  let ultimo = null, estadoAntes;
  return comTrava({opts, Client, id,
    ocupada: () => ({...base(), resultado: 'EXECUTOR_ATIVO', motivo: 'EXECUTOR_ATIVO ' + id, commit: 'NAO_COMMITADA'}),
    acao: async db => {
      if (EXIGE[id]) {
        const a = await gen.conferirNoCliente(db, {id: EXIGE[id], raiz, ...ident});
        if (a.resultado !== 'JA_APLICADA_POSTCHECK_PASS') {
          return {...base(), resultado: 'ANTECESSORA_PENDENTE', motivo: `ANTECESSORA_PENDENTE ${EXIGE[id]} ${a.resultado}${a.motivo ? ' ' + a.motivo : ''}`.slice(0, 300),
            commit: 'NAO_COMMITADA'};
        }
      }
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
module.exports = {AMBIENTE, IDS, EXIGE, ALVO, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, CODIGO, SQL, CHAVES_TRAVA, chave, alvo, modo, plano,
  comTrava, conferir, executar, principal, cli};
