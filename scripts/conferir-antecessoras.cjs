/* eslint-disable @typescript-eslint/no-require-imports */
// Conferência das ANTECESSORAS da 129 (plano "Registro de migrations no banco 20261120", §3.6). SOMENTE LEITURA e SEM
// DISCO: para cada id da tabela fixa abaixo chama a conferência READ ONLY já existente (genérico, adaptadores de staging,
// módulos -production/-staging, principal da 122) com conexões próprias de cada módulo, e aceita só o resultado exato
// indicado. Nenhum caminho daqui confere o disco persistente; se uma conferência acusar o disco, o id sai CONFERENCIA_EXIGE_DISCO
// (pendente). Erro inesperado num id deixa só esse id pendente, com o motivo, e o relatório segue para os demais.
//   117: regra especial (§3.6): JA_APLICADA_POSTCHECK_PASS = OK; chave LIGADA, ou chave DESLIGADA com rodízio histórico
//        (D-REG-4: postcheck falhou exatamente em MOTIVO_RODIZIO), passa pela conferência ESTRUTURAL na MESMA conexão
//        identificada: r.estado devolvido (m117 presente, nenhum índice inválido) e database/checks/20261104_117_estrutura.sql
//        (o postcheck sem o bloco do rodízio vazio, sha256 fixado). Qualquer outra recusa = pendente com o motivo original.
//   116: regra especial (plano "Staging em dia antes da 129", §7.2, §8.1, §8.2): JA_APLICADA_POSTCHECK_PASS = OK sem olhar a
//        declaração. Só no ramo de DADOS (RECUSARIA, m116 presente, postcheck FALHOU com motivo igual a um de MOTIVOS_DADOS_116)
//        a declaração da flag é exigida: sem ela, 116 PENDENTE FLAG_NAO_DECLARADA <motivo>; com ela, roda na MESMA conexão
//        identificada o database/checks/20261103_116_operacao.sql (postcheck com os blocos estruturais inteiros e só a anomalia
//        de pendência de contratação não confirmada; sha256 fixado) e, com aprovado, 116 PRESENTE_OPERACAO_PASS flag=declarada.
//        A declaração "<ambiente> <registro>" tem de ser do ambiente da chamada e do alvo (KIDMAIS_DEPLOY_ENV e serviço);
//        diferente = FLAG_DECLARADA_OUTRO_AMBIENTE, recusa antes de conectar (código 1).
//   110, 111, 115, 120, 121 em staging: conferir do adaptador scripts/migration-generico-staging.cjs (com a trava de sessão;
//        trava ocupada = NAO_CONCLUSIVO, pendente).
//   node scripts/conferir-antecessoras.cjs --ambiente production|staging [--franquia-flag-ligada "<ambiente> <registro>"]
// Saída: uma linha por id e, no fim, ANTECESSORAS_OK (código 0) ou ANTECESSORAS_PENDENTES <ids> (código 3); argumentos
// recusados = código 1. O bootstrap da 129 (scripts/registro-migrations-banco.cjs) chama conferir({ambiente, env}).
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const AMBIENTES = Object.freeze(['production', 'staging']);
const raizPadrao = path.resolve(__dirname, '..');
const OK = 'JA_APLICADA_POSTCHECK_PASS';
/** Texto exato que curta() do núcleo da 117 produz para a exceção do rodízio (postcheck, linha 69); fixado por teste contra o PG. */
const MOTIVO_RODIZIO = '117 postcheck: rodízio não está vazio';
const MOTIVO_CHAVE_LIGADA = 'CHAVE_MULTIEMPRESA_NAO_DESLIGADA LIGADA';
const ESTRUTURA_117 = Object.freeze(['estrutura 117', 'database/checks/20261104_117_estrutura.sql', '8499e952697a4dea5a93cea84c3f6e6627116ac1bdb049b76821ef4fcc2fbde1']);
/** Textos exatos que curta() do núcleo da 116 produz para os dois blocos de dados do postcheck (:108–113); fixados por teste contra o PG. */
const MOTIVOS_DADOS_116 = Object.freeze([
  '116 postcheck: ia_credito_franquias_ciclo deveria estar vazia (flag desligada)',
  '116 postcheck: pendência de franquia não legítima (processada, com tentativa/motivo ou de contratação não confirmada)',
]);
const OPERACAO_116 = Object.freeze(['operacao 116', 'database/checks/20261103_116_operacao.sql', 'bb7d461b10a71ac4280ee9ffcebd3d3f53238036fd89899d59af6b2671a8ae0a']);
const FLAG_FRANQUIA = '--franquia-flag-ligada';
const REGISTRO_FLAG = /^[A-Za-z0-9:._/ -]{6,120}$/;
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').slice(0, 300);

/**
 * Tabela fixa, na ordem da cadeia de promoção (scripts/promocao-production-ordem.cjs). tipo:
 *   generico  — production: gen.conferir (alvo/identidade de production); staging: conferir({env, id}) do adaptador
 *               scripts/migration-generico-staging.cjs (uma conexão, trava de sessão staging:<id>, identidade de staging);
 *   adaptador — production: gen.conferir; staging: conferir({env}) de migration-<id>-staging.cjs;
 *   modulo    — conferir({env}) de migration-<id>-<ambiente>.cjs;
 *   p122      — principal(['--conferir-122'], env) de migration-122-<ambiente>.cjs (código 0 E JA_APLICADA_POSTCHECK_PASS);
 *   m116, m117 — regras especiais (ver o cabeçalho).
 */
const TABELA = Object.freeze([
  ['114', 'modulo'], ['112', 'modulo'], ['116', 'm116'], ['117', 'm117'], ['118', 'modulo'],
  ['120', 'generico'], ['121', 'generico'], ['110', 'generico'], ['111', 'generico'], ['115', 'generico'],
  ['123', 'adaptador'], ['122', 'p122'], ['124', 'adaptador'], ['125', 'adaptador'], ['126', 'adaptador'], ['127', 'adaptador'], ['128', 'adaptador'],
].map(([id, tipo]) => Object.freeze({id, tipo})));
const IDS = Object.freeze(TABELA.map(t => t.id));

/** Deps do pg: só repassa Client quando injetado (sem ele, cada módulo usa o padrão dele). */
const comClient = deps => (deps.Client ? {Client: deps.Client} : {});
const ClientDe = deps => deps.Client ?? require('pg').Client;

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

/** Staging (110, 111, 115, 120, 121): conferir do adaptador genérico de staging, que pega a trava de sessão staging:<id>. */
async function genericoStaging({id, env, deps}) {
  return require('./migration-generico-staging.cjs').conferir({env, id, raiz: deps.raiz ?? raizPadrao, ...comClient(deps)});
}

/**
 * Declaração da flag da franquia (§7.2, §8.1): "<ambiente> <registro>", com o registro na mesma regex do backup. O ambiente
 * declarado tem de ser o da chamada e o provado pelo alvo (KIDMAIS_DEPLOY_ENV e RENDER_SERVICE_ID do serviço da 116 daquele
 * ambiente). Sem declaração = null. Recusa lança antes de qualquer conexão.
 */
function lerDeclaracaoFlag(texto, ambiente, env = {}) {
  if (texto === undefined || texto === null) return null;
  const m = /^(production|staging) (.+)$/.exec(String(texto));
  if (!m || !REGISTRO_FLAG.test(m[2]) || m[2] !== m[2].trim()) throw new Error('FLAG_DECLARACAO_INVALIDA (uso: ' + FLAG_FRANQUIA + ' "<ambiente> <registro>")');
  const servico = require(`./migration-116-${m[1]}.cjs`).ALVO.servico;
  if (m[1] !== ambiente || env.KIDMAIS_DEPLOY_ENV !== m[1] || env.RENDER_SERVICE_ID !== servico)
    throw new Error(`FLAG_DECLARADA_OUTRO_AMBIENTE declarada=${m[1]} chamada=${String(ambiente).slice(0, 20)} alvo=${String(env.KIDMAIS_DEPLOY_ENV ?? 'ausente').slice(0, 20)}`);
  return Object.freeze({ambiente: m[1], registro: m[2], texto: m[0]});
}

/** Conferência padrão por id e ambiente (deps.conferencias[id] substitui, para testes). Devolve o objeto do módulo. */
async function conferenciaPadrao({id, tipo, ambiente, env, deps}) {
  const raiz = deps.raiz ?? raizPadrao;
  if ((tipo === 'generico' || tipo === 'adaptador') && ambiente === 'production')
    return require('./migration-generico-production.cjs').conferir({env, id, raiz, ...comClient(deps)});
  if (tipo === 'generico') return genericoStaging({id, env, deps});
  if (tipo === 'adaptador') return require(`./migration-${id}-staging.cjs`).conferir({env, raiz, ...comClient(deps)});
  if (tipo === 'modulo') return require(`./migration-${id}-${ambiente}.cjs`).conferir({env, raiz, ...comClient(deps)});
  if (tipo === 'p122') return require(`./migration-122-${ambiente}.cjs`).principal(['--conferir-122'], env, comClient(deps));
  throw new Error('TIPO_DESCONHECIDO ' + tipo);
}

const exigeDisco = texto => /DISCO_PERSISTENTE_AUSENTE/.test(texto);
const pendente = (id, texto) => ({ok: false, linha: exigeDisco(texto) ? `${id} CONFERENCIA_EXIGE_DISCO ${texto}` : `${id} PENDENTE ${texto}`});

/** Resultado de um id comum (não 117): só o resultado exato aceito. */
function avaliar(id, tipo, r) {
  if (tipo === 'p122') {
    if (r?.codigo === 0 && r?.saida?.resultado === OK) return {ok: true, linha: `${id} ${OK}`};
    return pendente(id, `codigo=${r?.codigo} ${r?.saida?.resultado ?? 'SEM_RESULTADO'} ${curta(r?.saida?.falha?.mensagem ?? '')}`.trim());
  }
  if (r?.resultado === OK) return {ok: true, linha: `${id} ${OK}`};
  return pendente(id, `${r?.resultado ?? 'SEM_RESULTADO'} ${curta(r?.motivo ?? r?.mensagem ?? '')}`.trim());
}

/**
 * Conferência estrutural da 117, READ ONLY, no MESMO db em que conferirNoCliente acabou de rodar: usa o r.estado devolvido
 * (a leitura privada de estado do núcleo não é chamada) e roda o 117_estrutura.sql (sha256 fixado) nesse db.
 */
async function estrutural117(db, r, ramo, {raiz, corpoSomenteLeitura}) {
  const s = r.estado;
  if (s?.m117 !== 'presente') return {ok: false, linha: `117 DIVERGENCIA_ESQUEMA ESTADO_117 ${s?.m117 ?? 'ilegivel'}`};
  if (!Array.isArray(s.indices_invalidos) || s.indices_invalidos.length !== 0)
    return {ok: false, linha: `117 DIVERGENCIA_ESQUEMA INDICE_INVALIDO_117 ${Array.isArray(s.indices_invalidos) ? s.indices_invalidos.join(' ') : 'ilegivel'}`};
  const [nome, arquivo, hash] = ESTRUTURA_117;
  let res;
  try { res = await somenteLeitura(db, corpoSomenteLeitura(lerRevisado(raiz, arquivo, hash), nome)); }
  catch (e) { return {ok: false, linha: `117 DIVERGENCIA_ESQUEMA ${curta(e)}`}; }
  const linhas = [].concat(res ?? []).flatMap(x => x?.rows ?? []);
  if (!linhas.some(l => l?.aprovado === true)) return {ok: false, linha: '117 DIVERGENCIA_ESQUEMA ESTRUTURA_SEM_APROVADO'};
  return {ok: true, linha: `117 PRESENTE_ESTRUTURA_PASS ${ramo}`};
}

/** Ramo da 117 por igualdade completa (§3.6); null = pendente com o motivo original. */
function ramo117(r) {
  if (r?.resultado !== 'RECUSARIA') return null;
  if (r.chave === 'LIGADA' && r.motivo === MOTIVO_CHAVE_LIGADA) return 'chave=LIGADA';
  if (r.chave === 'DESLIGADA' && r.estado?.m117 === 'presente' && r.checks?.['postcheck 117'] === 'FALHOU' && r.motivo === MOTIVO_RODIZIO)
    return 'chave=DESLIGADA rodizio=historico';
  return null;
}

/** 117: conexão aberta aqui com alvo/identidade/SQL_IDENTIDADE do módulo do ambiente; núcleo de migration-117-comum.cjs. */
async function conferir117({ambiente, env, deps}) {
  const comum = require('./migration-117-comum.cjs');
  const conferirNoCliente = deps.conferirNoCliente117 ?? comum.conferirNoCliente;
  const corpoSomenteLeitura = comum.corpoSomenteLeitura;
  const m = deps.ambiente117?.[ambiente] ?? require(`./migration-117-${ambiente}.cjs`);
  const raiz = deps.raiz ?? raizPadrao;
  const cfg = m.alvo(env);
  const Client = ClientDe(deps);
  const db = new Client(cfg); db.on?.('error', () => undefined);
  try {
    await db.connect();
    const chave = comum.estadoChave(env);
    const r = await conferirNoCliente(db, {raiz, sqlIdentidade: m.SQL_IDENTIDADE, identidade: l => m.identidade(l, env), chave});
    if (r?.resultado === OK) return {ok: true, linha: `117 ${OK} chave=${r.chave ?? chave}`};
    const ramo = ramo117(r);
    if (!ramo) return pendente('117', `${r?.resultado ?? 'SEM_RESULTADO'} chave=${r?.chave ?? chave} ${curta(r?.motivo ?? r?.mensagem ?? '')}`.trim());
    return await estrutural117(db, r, ramo, {raiz, corpoSomenteLeitura});
  } finally { await db.end().catch(() => {}); }
}

async function conferirId({id, tipo, ambiente, env, deps, flag}) {
  try {
    if (tipo === 'm117' && !deps.conferencias?.['117']) return await conferir117({ambiente, env, deps});
    if (tipo === 'm116' && !deps.conferencias?.['116']) return await conferir116({ambiente, env, deps, flag});
    const f = deps.conferencias?.[id];
    const r = f ? await f({id, tipo, ambiente, env, flag}) : await conferenciaPadrao({id, tipo, ambiente, env, deps});
    if (tipo === 'm117' || tipo === 'm116') return r?.linha ? {ok: r.ok === true, linha: r.linha} : avaliar(id, tipo, r);
    return avaliar(id, tipo, r);
  } catch (e) { return pendente(id, `ERRO ${curta(e)}`); }
}

/** Ramo de DADOS da 116 por igualdade completa (§7.2): RECUSARIA, os objetos presentes, postcheck FALHOU num dos dois motivos de dados. */
function ramoDados116(r) {
  return r?.resultado === 'RECUSARIA' && r.estado?.m116 === 'presente' && r.checks?.['postcheck 116'] === 'FALHOU' && MOTIVOS_DADOS_116.includes(r.motivo);
}

/** 116_operacao.sql (sha256 fixado), READ ONLY, no MESMO db em que conferirNoCliente acabou de rodar. */
async function operacao116(db, flag, {raiz, corpoSomenteLeitura}) {
  const [nome, arquivo, hash] = OPERACAO_116;
  let res;
  try { res = await somenteLeitura(db, corpoSomenteLeitura(lerRevisado(raiz, arquivo, hash), nome)); }
  catch (e) { return pendente('116', curta(e)); }
  const linhas = [].concat(res ?? []).flatMap(x => x?.rows ?? []);
  if (!linhas.some(l => l?.aprovado === true)) return pendente('116', 'OPERACAO_SEM_APROVADO');
  return {ok: true, linha: `116 PRESENTE_OPERACAO_PASS flag=declarada "${flag.texto}"`};
}

/** 116: conexão aberta aqui com alvo/identidade/SQL_IDENTIDADE do módulo do ambiente; núcleo de migration-116-comum.cjs. */
async function conferir116({ambiente, env, deps, flag}) {
  const comum = require('./migration-116-comum.cjs');
  const conferirNoCliente = deps.conferirNoCliente116 ?? comum.conferirNoCliente;
  const m = deps.ambiente116?.[ambiente] ?? require(`./migration-116-${ambiente}.cjs`);
  const raiz = deps.raiz ?? raizPadrao;
  const cfg = m.alvo(env);
  const Client = ClientDe(deps);
  const db = new Client(cfg); db.on?.('error', () => undefined);
  try {
    await db.connect();
    const r = await conferirNoCliente(db, {raiz, sqlIdentidade: m.SQL_IDENTIDADE, identidade: l => m.identidade(l, env)});
    // §8.2: íntegra = OK sem olhar a declaração.
    if (r?.resultado === OK) return {ok: true, linha: `116 ${OK}`};
    if (!ramoDados116(r)) return pendente('116', `${r?.resultado ?? 'SEM_RESULTADO'} ${curta(r?.motivo ?? r?.mensagem ?? '')}`.trim());
    if (!flag) return {ok: false, linha: `116 PENDENTE FLAG_NAO_DECLARADA ${r.motivo}`};
    return await operacao116(db, flag, {raiz, corpoSomenteLeitura: comum.corpoSomenteLeitura});
  } finally { await db.end().catch(() => {}); }
}

/** Entrada do bootstrap da 129 e da CLI: {codigo 0|1|3, linhas (uma por id), pendentes, final}. */
async function conferir({ambiente, env = {}, deps = {}, flagFranquia} = {}) {
  const recusado = t => ({codigo: 1, linhas: ['RECUSADO ' + t], pendentes: [...IDS], final: `ANTECESSORAS_PENDENTES ${IDS.join(',')}`});
  if (!AMBIENTES.includes(ambiente)) return recusado(`AMBIENTE_RECUSADO ${String(ambiente).slice(0, 20)}`);
  let flag;
  try { flag = lerDeclaracaoFlag(flagFranquia, ambiente, env); } catch (e) { return recusado(curta(e)); }
  const linhas = [], pendentes = [];
  for (const {id, tipo} of TABELA) {
    const v = await conferirId({id, tipo, ambiente, env, deps, flag});
    linhas.push(v.linha);
    if (!v.ok) pendentes.push(id);
  }
  const final = pendentes.length ? `ANTECESSORAS_PENDENTES ${pendentes.join(',')}` : 'ANTECESSORAS_OK';
  return {codigo: pendentes.length ? 3 : 0, linhas, pendentes, final};
}

function modo(argv) {
  if (argv.length === 2 && argv[0] === '--ambiente' && AMBIENTES.includes(argv[1])) return {ambiente: argv[1]};
  if (argv.length === 4 && argv[0] === '--ambiente' && AMBIENTES.includes(argv[1]) && argv[2] === FLAG_FRANQUIA) return {ambiente: argv[1], flagFranquia: argv[3]};
  throw new Error(`ARGUMENTOS_RECUSADOS (uso: --ambiente production|staging [${FLAG_FRANQUIA} "<ambiente> <registro>"])`);
}
async function principal(argv, env, deps = {}) {
  let m;
  try { m = modo(argv); } catch (e) { return {codigo: 1, linhas: ['RECUSADO ' + curta(e)]}; }
  const r = await conferir({ambiente: m.ambiente, env, deps, flagFranquia: m.flagFranquia});
  return {codigo: r.codigo, linhas: [...r.linhas, r.final], pendentes: r.pendentes};
}
function cli() {
  principal(process.argv.slice(2), process.env).then(({codigo, linhas}) => {
    for (const l of linhas) (codigo === 0 ? console.log : console.error)(l);
    process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
if (require.main === module) cli();
module.exports = {AMBIENTES, TABELA, IDS, MOTIVO_RODIZIO, MOTIVO_CHAVE_LIGADA, ESTRUTURA_117, MOTIVOS_DADOS_116, OPERACAO_116, FLAG_FRANQUIA,
  lerDeclaracaoFlag, ramoDados116, operacao116, conferir116, ramo117, avaliar, estrutural117, conferir117, conferir, modo, principal, cli};
