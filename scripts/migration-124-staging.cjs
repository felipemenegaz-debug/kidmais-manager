/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 124 (assinatura do cliente em papel, PAPEL_CLIENTE; exige 061, 122 e 123) SOMENTE no PostgreSQL do web de staging,
// no Web Shell do srv-daif418ae00c73e8k2gg, DEPOIS do deploy do código que traz este aplicador e os SQL. Adaptador fino: o núcleo é o do
// aplicador genérico de production (scripts/migration-generico-production.cjs: lista fechada com o sha256 LF da 124,
// sentinelas, privilégios, precheck → migration → postcheck numa transação, situação do COMMIT); aqui só mudam o alvo
// (validação rígida do adaptador da 116 de staging), a identidade e o disco (scripts/conexao-staging.cjs) e a pasta do
// marcador. Production continua pelo genérico (último da lista IDS, depois da 123), com autorização própria.
//   node scripts/migration-124-staging.cjs                                                → plano, sem conexão
//   node scripts/migration-124-staging.cjs --conferir-124                                 → somente leitura
//   node scripts/migration-124-staging.cjs --aplicar-124-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
// Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar; 2 FALHA registrada; 3 conferência RECUSARIA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gen = require('./migration-generico-production.cjs');
const stg = require('./conexao-staging.cjs');
const s116 = require('./migration-116-staging.cjs');

const ID = '124';
const ALVO = s116.ALVO;
const DIR = path.posix.join(stg.DISCO, 'assinatura-papel-124-staging');
const FLAG_CONFERIR = '--conferir-124';
const FLAG_APLICAR = '--aplicar-124-autorizado';
const FLAG_BACKUP = '--backup';
const BACKUP = /^[A-Za-z0-9:._/ -]{6,120}$/;
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);
const raizPadrao = path.resolve(__dirname, '..');

/** Mesma validação do adaptador da 116 de staging (serviço, ambiente, host, banco, porta, PG* herdadas, controle, TLS). */
function alvo(env) {
  const cfg = s116.alvo(env);
  cfg.application_name = 'kidmais-migration-124-staging';
  return cfg;
}
/** Identidade lida no servidor: banco exato e TLS conforme DATABASE_SSL (sem TLS, só em endereço privado). */
const identidadeDe = env => linha => {
  try { return stg.conferirIdentidade(linha, env); } catch (e) { assert.fail('IDENTIDADE_RECUSADA ' + String(e?.message ?? '').slice(0, 40)); }
};

function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === FLAG_BACKUP) {
    assert.match(argv[2], BACKUP, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', backup: argv[2]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

function plano({raiz = raizPadrao} = {}) {
  const def = gen.MIGRATIONS[ID];
  return {resultado: 'PLANO', conecta: false, ambiente: 'staging', alvo: ALVO, registro: DIR, id: ID, escopo: def.escopo, marcador: gen.marcadorDe(ID),
    arquivos: def.arquivos.map(([etapa, arquivo, hash]) => { gen.carregar(raiz, ID); return {etapa, arquivo, sha256: hash}; }),
    sentinelas: def.criados.map(([n]) => n),
    modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`},
    ordem: ['árvore implantada no web de staging com este aplicador e os SQL (conferir o commit implantado)',
      `${FLAG_CONFERIR}: PRONTA_PARA_APLICAR (JA_APLICADA_POSTCHECK_PASS = não aplicar)`,
      'backup de staging registrado', 'sim de Felipe para a 124 em staging',
      `${FLAG_APLICAR} ${FLAG_BACKUP} "<registro>"`, `${FLAG_CONFERIR}: JA_APLICADA_POSTCHECK_PASS`],
    paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
      'FALHA com commit INDETERMINADO: reconciliar com a conferência antes de decidir',
      'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar)'],
    nuncaExecuta: ['down da 124', 'outra migration', 'alteração de env', 'deploy', 'restart', 'production']};
}

async function conectar(opts, Client) {
  const db = new Client(opts); db.on?.('error', () => undefined);
  await db.connect();
  return db;
}

async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
  const opts = alvo(env);
  let db;
  try {
    db = await conectar(opts, Client);
    return await gen.conferirNoCliente(db, {id: ID, raiz, sqlIdentidade: stg.SQL_IDENTIDADE, identidade: identidadeDe(env)});
  } catch (e) { await db?.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', id: ID, resultado: 'FALHA', mensagem: curta(e)}; }
  finally { await db?.end().catch(() => {}); }
}

const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => [ID, x.commit]));
const commitadas = r => Object.entries(situacoes(r)).filter(([, c]) => c === 'CONFIRMADO').map(([id]) => id);

async function executar({env, backup, dir = DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => stg.exigirDisco()}) {
  const opts = alvo(env); disco();
  assert.match(String(backup ?? ''), BACKUP, 'BACKUP_OBRIGATORIO');
  gen.carregar(raiz, ID);
  // Antes do marcador: identidade, estado, privilégios e precheck em READ ONLY. Recusa lança e nada é gravado no disco.
  {
    let pre;
    try {
      pre = await conectar(opts, Client);
      const c = await gen.conferirNoCliente(pre, {id: ID, raiz, sqlIdentidade: stg.SQL_IDENTIDADE, identidade: identidadeDe(env)});
      assert.ok(['PRONTA_PARA_APLICAR', 'JA_APLICADA_POSTCHECK_PASS'].includes(c.resultado), 'PREFLIGHT_RECUSOU ' + (c.motivo ?? c.resultado));
    } catch (e) { await pre?.query('ROLLBACK').catch(() => {}); throw e; }
    finally { await pre?.end().catch(() => {}); }
  }
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const marcador = path.join(dir, gen.marcadorDe(ID));
  const anteriores = fs.readdirSync(dir).filter(n => n.startsWith(`migration-${ID}.`) && n.endsWith('.json') && n !== gen.marcadorDe(ID)).sort();
  const registro = {inicio: new Date().toISOString(), ambiente: 'staging', id: ID, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
  try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
  catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
  const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
  let ultimo = {id: ID};
  let db;
  try {
    db = await conectar(opts, Client);
    const r = await gen.aplicarNoCliente(db, {id: ID, raiz, sqlIdentidade: stg.SQL_IDENTIDADE, identidade: identidadeDe(env),
      registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
    salvar({...r, situacao: 'CONCLUIDA', commits: situacoes(r), commitadas: commitadas(r)});
    return {resultado: r.resultado, id: ID, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
      etapas: r.etapas.map(e => e.nome), commits: situacoes(r), commitadas: commitadas(r)};
  } catch (e) {
    // Já passou do marcador: sempre FALHA (código 2) com a situação do COMMIT, mesmo se o marcador não puder ser regravado.
    const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
    const situacao = {commits: situacoes(ultimo), commitadas: commitadas(ultimo), reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir`};
    let marcadorAtualizado = true, erroMarcador;
    try { salvar({...ultimo, situacao: 'FALHA', falha, ...situacao}); } catch (e2) { marcadorAtualizado = false; erroMarcador = curta(e2); }
    return {resultado: 'FALHA', id: ID, marcador, falha, ...situacao, marcadorAtualizado,
      ...(marcadorAtualizado ? {} : {erroMarcador, aviso: 'MARCADOR_DESATUALIZADO: copiar esta saída (é o único registro do COMMIT); não repetir'})};
  } finally { await db?.end().catch(() => {}); }
}

async function principal(argv, env, deps = {}) {
  const m = modo(argv);
  if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
  const s = m.modo === 'conferir' ? await conferir({env, ...deps}) : await executar({env, backup: m.backup, ...deps});
  return {codigo: gen.CODIGO[s.resultado] ?? 2, saida: s};
}
function cli() {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
if (require.main === module) cli();
module.exports = {ID, ALVO, DIR, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, alvo, modo, plano, conferir, executar, principal, cli};
