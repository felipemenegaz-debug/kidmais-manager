/* eslint-disable @typescript-eslint/no-require-imports */
// B-5 do plano de promoção (25/10/2026), AMPLIADO pela §9.2.7 do plano (rodada 34): conferência SOMENTE LEITURA agregada do
// banco de PRODUÇÃO, entregue ao Web Shell do srv-dak77m2d0e5s73b8rkkg por bloco autossuficiente (o artefato publicado no
// E1/E2c ainda é o antigo, sem estes arquivos).
//   - estado de 089–097, 099 e 100 pelas MESMAS funções de estado dos aplicadores (SQL_ESTADO + lerEstado de cada núcleo;
//     a 092–094 pelo núcleo do B-1, a 099 pelo do B-2, a 100 pelo do B-3). A 098 não tem núcleo (PAUSADA): o estado dela
//     sai da classificação dos combinados abaixo;
//   - B-5 ampliado (§9.2.7): estado de 102–109, 112, 114, 116 e 117 pelos núcleos dos aplicadores de staging (mesma régua do
//     CONFERIR de cada um; a 109 pelo contrato do cron, lib/assinatura/renovacao-schema.ts) e da 118 por catálogo. 110, 111,
//     113 e 115 não existem na árvore. Prefixo esperado ANTES DO E3 (§9.2.2): só 099 e 105 além da base; qualquer outro estado
//     = PARAR (a candidata roda sem elas; B-19);
//   - B-21 (rodada 19 do plano): estado dos salões combinados pelo MESMO critério da candidata (lib/agenda/estado-combinados.ts:
//     mesmo SQL de catálogo, mesma classificação). Esperado AUSENTE; ANTIGA (098 histórica), PARCIAL, NOVA (108, fora desta
//     promoção — reconciliar o escopo) ou linha ilegível = PARAR, nos dois modos;
//   - matriz da §9.2.2 (objetos de cobrança, créditos e cadastro): estrutura e contagens agregadas numa fotografia
//     REPEATABLE READ READ ONLY. NÃO emite o veredito G-VAZIO (é do conferidor B-26, com hashes, auditoria, prefixo por
//     marcadores e regra de fechamento): aqui só as paradas que as contagens decidem sozinhas;
//   - B-15 reescopado (§9.2.7): inventário legado com DV inválido pela regra da função `kidmais_091_documento_valido`
//     (empresa_assinaturas.documento_teste, assinatura_fundadores.documento_beneficiario; no ramo VAZIO o resultado é vazio e
//     a prova artificial de documento legado fica não aplicável), compatibilidade estrutural da 091 (o precheck dela, lido do
//     catálogo, e o formato dos documentos que os CHECKs novos validam) e origens futuras (cadastros_empresas,
//     solicitacoes_acesso_empresa, plataforma_empresas_cadastro). Os documentos ficam só na memória do processo: a saída tem
//     contagens;
//   - Fundador SEM provedor: o B-5 NUNCA lê ASAAS_* nem chama o Asaas (§9.2.4, L1: `ASAAS_API_KEY` ausente). Sem concessão
//     confirmada, a parte Fundador sai vazia e não lê mais nada. Com concessão confirmada, o núcleo não está vazio (ramo
//     COM-DADOS, fora desta promoção): datas só dos registros de renovação já gravados, e PARAR. A conta do provedor é
//     conferência SEPARADA (§9.2.2: declaração de Felipe sem conta; painel ou GET com autorização própria, chave fora do web,
//     com conta); o operador declara o ramo em KIDMAIS_B5_RAMO_PROVEDOR e a saída o registra.
// Banco: cada consulta em BEGIN TRANSACTION READ ONLY com lock_timeout/statement_timeout; trava de alvo, TLS e identidade de
// produção do B-1 (scripts/migration-092-094-production.cjs). Nunca grava no banco, no disco ou em serviço externo.
//   node scripts/conferencia-b5-producao.cjs                       → plano, sem conexão
//   node --experimental-strip-types scripts/conferencia-b5-producao.cjs --conferir-b5         → E1
//   node --experimental-strip-types scripts/conferencia-b5-producao.cjs --conferir-b5-estado  → E2c (091/094 ausentes)
//   node --experimental-strip-types scripts/conferencia-b5-producao.cjs --conferir-b5-estado-pos-e3 → E5b (E2c-RECONFERIR:
//     prefixo depois do E3, 089/092/093 completas; 091/094 e 118 ausentes; B-29 na opção (c) de D-ESC-8)
// Códigos: 0 CONFERIDO; 1 recusa antes de conectar; 2 FALHA (conexão, identidade, consulta); 3 PARAR (motivos nomeados).
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const prod = require('./migration-092-094-production.cjs');
const ret108 = require('./migration-108-retrato.cjs');

const FLAG_COMPLETO = '--conferir-b5';
const FLAG_ESTADO = '--conferir-b5-estado';
/** E5b (E2c-RECONFERIR, B-29 na opção (c) de D-ESC-8, rodada 43): o mesmo modo estado, com o prefixo DEPOIS do E3. */
const FLAG_ESTADO_POS_E3 = '--conferir-b5-estado-pos-e3';
/** [rótulo, núcleo, campos de estado]. Ordem da numeração; a 098 nunca entra. */
const MIGRACOES = Object.freeze([
  ['089', './migration-089-comum.cjs', ['m089']], ['090', './migration-090-comum.cjs', ['m090']], ['091', './migration-091-comum.cjs', ['m091']],
  ['092-094', './migration-092-094-comum.cjs', ['m092', 'm093', 'm094']], ['095', './migration-095-comum.cjs', ['m095']],
  ['096', './migration-096-comum.cjs', ['m096']], ['097', './migration-097-comum.cjs', ['m097']], ['099', './migration-099-comum.cjs', ['m099']],
  ['100', './migration-100-comum.cjs', ['m100']]]);
const EXCLUIDAS = Object.freeze({'098': 'SEM_NUCLEO_VER_COMBINADOS'});
/** B-5 ampliado (§9.2.7): núcleos dos aplicadores (staging) de 102–117, na ordem da numeração. */
const AMPLIADAS = Object.freeze([
  ['102-103', './migration-102-103-comum.cjs', ['m102', 'm103']], ['104-106', './migration-104-106-comum.cjs', ['m104', 'm106']],
  ['105', './migration-105-comum.cjs', ['m105']], ['107-108', './migration-107-108-comum.cjs', ['m107', 'm108']],
  ['109', './migration-109-comum.cjs', ['m109']], ['112', './migration-112-comum.cjs', ['m112']], ['114', './migration-114-comum.cjs', ['m114']],
  ['116', './migration-116-comum.cjs', ['m116']], ['117', './migration-117-comum.cjs', ['m117']]]);
/** Números da faixa 106–117 sem migration na árvore (nada a ler). */
const SEM_MIGRATION = Object.freeze({'110': 'SEM_MIGRATION_NA_ARVORE', '111': 'SEM_MIGRATION_NA_ARVORE', '113': 'SEM_MIGRATION_NA_ARVORE',
  '115': 'SEM_MIGRATION_NA_ARVORE'});
/**
 * Prefixo efetivo ANTES DO E3 (§9.2.2, linha "Antes do E3, ou F-A": nada além de 099 e 105). Valores = vocabulário de cada
 * núcleo (a 108 em maiúsculas, como classificar108). A 118 está na árvore (staging 9691392c) mas fora do plano r34: detectada
 * por catálogo, esperada ausente.
 */
/**
 * Parte antiga do mesmo prefixo (revisão Astra r1, P1): 089–097 ausentes, 099 completa (aplicada em 31/10, rodada 21) e a
 * 100 no estado de partida "sem_094". A 098 não tem núcleo: é o B-21 (combinados AUSENTE). Divergência = PARAR; reconciliar
 * só com indicação explícita do plano antes de prosseguir.
 */
const ESPERADO_BASE_ANTES_DO_E3 = Object.freeze({'089': 'ausente', '090': 'ausente', '091': 'ausente', '092': 'ausente', '093': 'ausente', '094': 'ausente',
  '095': 'ausente', '096': 'ausente', '097': 'ausente', '099': 'completa', '100': 'sem_094'});
/**
 * Corpos de production antes do E3 das 2 funções que a 114 regrava (revisão Astra r1, P1): lock = 019 (o mesmo par "antes"
 * do núcleo), revisão = 062 (a 094/098/108 ainda não entraram). Hash do prosrc sem CR, conferido contra o texto das
 * migrations no teste e contra o PostgreSQL descartável (base 088 + 099 + 105) na sonda.
 */
const CORPOS_114_ANTES_DO_E3 = Object.freeze({lock: 'eb5f187f7ef5e7a499413d71cc1a0c5023d65080920997248a7f5d1947460880',
  revisao: '830dd6a376f1dceadab9f20ad606665ec7b4692bfd531881c3da42f1e3d0b2ad'});
const ESPERADO_ANTES_DO_E3 = Object.freeze({'102': 'ausente', '103': 'ausente', '104': 'ausente', '105': 'completa', '106': 'ausente', '107': 'ausente',
  '108': 'AUSENTE', '109': 'ausente', '112': 'ausente', '114': 'ausente', '116': 'ausente', '117': 'ausente', '118': 'ausente'});
/**
 * Prefixo DEPOIS do E3 (B-29, D-ESC-8 = (c), rodada 43 do plano): o E3 aplica 089, 092 e 093; o resto da base fica como
 * antes (091 e 094 ausentes, 100 em "sem_094"). Faixa 102–118 igual à de antes do E3: na opção (c) a 118 só entra na E6
 * (A7), então ela continua AUSENTE no E5b; presente aqui = PARAR (alguém aplicou fora da janela).
 */
const ESPERADO_BASE_POS_E3 = Object.freeze({...ESPERADO_BASE_ANTES_DO_E3, '089': 'completa', '092': 'completa', '093': 'completa'});
const ESPERADO_POS_E3 = ESPERADO_ANTES_DO_E3;
/** Prefixo por modo: E1 e E2c antes do E3; E5b depois do E3. */
const PREFIXOS = Object.freeze({
  completo: {base: ESPERADO_BASE_ANTES_DO_E3, ampliado: ESPERADO_ANTES_DO_E3, rotulo: 'ANTES_DO_E3 (§9.2.2: alem da base, so 099 e 105)'},
  estado: {base: ESPERADO_BASE_ANTES_DO_E3, ampliado: ESPERADO_ANTES_DO_E3, rotulo: 'ANTES_DO_E3 (§9.2.2: alem da base, so 099 e 105)'},
  estadoPosE3: {base: ESPERADO_BASE_POS_E3, ampliado: ESPERADO_POS_E3,
    rotulo: 'POS_E3 (B-29, D-ESC-8 = (c): 089, 092 e 093 completas; 091 e 094 ausentes; 118 ausente ate a E6)'}});
const RAMOS_PROVEDOR = Object.freeze({'sem-conta': 'SEM_CONTA', 'com-conta': 'COM_CONTA'});
/**
 * Únicas variáveis de ambiente lidas (alvo do B-1, previsão do papel trocado, ramo do provedor). Nenhuma ASAAS_*: o
 * ambiente recebido é reduzido a esta lista antes de qualquer outra coisa.
 */
const ENV_LIDAS = Object.freeze(['RENDER', 'RENDER_SERVICE_ID', 'KIDMAIS_DEPLOY_ENV', 'DATABASE_SSL', 'DATABASE_SSL_REJECT_UNAUTHORIZED', 'DATABASE_URL',
  'KIDMAIS_B5_PAPEL_TROCADO_ESPERADO', 'KIDMAIS_B5_RAMO_PROVEDOR']);
const DATA = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Constantes do código (lib/assinatura/renovacao-fundador.ts e plano B-9): aviso 30 dias, janela antecipada 3, margem 14.
 * Prazo do B-9 = menor primeiraDataRegular − (30 + 3 + 14) = −47 (D-COM-5, Felipe 27/10/2026): a margem conta da abertura
 * da janela de aviso (−33), não do limite (−30).
 */
const AVISO_DIAS = 30, ANTECIPADO_DIAS = 3, MARGEM_B9_DIAS = 14;

/**
 * Mensagens públicas = LISTA FECHADA dos códigos que este agregador e a trava de produção do B-1 lançam, comparados por
 * igualdade, sem complemento (re-revisão do B-5, P3: um filtro por formato deixava passar texto externo com cara de código).
 * Qualquer outra mensagem vira ERRO_INESPERADO, com o SQLSTATE quando `e.code` tiver exatamente 5 caracteres [0-9A-Z].
 */
const CODIGOS_PUBLICOS = Object.freeze(new Set([
  // trava de alvo e identidade de produção (scripts/migration-092-094-production.cjs)
  'FORA_DO_RENDER', 'SERVICO_RECUSADO', 'AMBIENTE_RECUSADO', 'TLS_OBRIGATORIO', 'URL_RECUSADA', 'HOST_RECUSADO', 'BANCO_RECUSADO',
  'PORTA_RECUSADA', 'CONNECTION_QUERY_REJECTED', 'BANCO_DIVERGENTE', 'SEM_TLS', 'TLS_VERSAO_RECUSADA', 'SERVIDOR_FORA_DA_REDE_PRIVADA',
  // este agregador
  'ARGUMENTOS_RECUSADOS', 'RAMO_PROVEDOR_NAO_DECLARADO', 'FUNDADOR_TOTAL_ILEGIVEL', 'ORIGEM_INESPERADA', 'MATRIZ_ILEGIVEL', 'B15_CATALOGO_ILEGIVEL',
  'CONTRATO_109_DIVERGENTE', 'CONTRATO_109_INDISPONIVEL', 'ESTADO_118_ILEGIVEL', 'INTEGRIDADE_105_DIVERGENTE']));
function curta(e) {
  const m = String(e?.message ?? '');
  if (CODIGOS_PUBLICOS.has(m)) return m;
  const codigo = String(e?.code ?? '');
  return 'ERRO_INESPERADO' + (/^[0-9A-Z]{5}$/.test(codigo) ? ' SQLSTATE ' + codigo : '');
}
/** Só as variáveis da lista; nenhuma outra chave do ambiente é sequer consultada. */
const envLido = env => Object.fromEntries(ENV_LIDAS.map(k => [k, env?.[k]]));

// ---------- regras puras (testadas contra o código e a função da 091) ----------
/** Mesma regra de `kidmais_091_documento_valido(text)` (migration 091, linhas 44–64). */
function documentoValido091(doc) {
  if (/^[0-9]{11}$/.test(doc)) {
    if (/^(.)\1{10}$/.test(doc)) return false;
    let soma = 0; for (let i = 1; i <= 9; i++) soma += (doc.charCodeAt(i - 1) - 48) * (11 - i);
    let d1 = (soma * 10) % 11; if (d1 === 10) d1 = 0;
    soma = 0; for (let i = 1; i <= 10; i++) soma += (doc.charCodeAt(i - 1) - 48) * (12 - i);
    let d2 = (soma * 10) % 11; if (d2 === 10) d2 = 0;
    return d1 === doc.charCodeAt(9) - 48 && d2 === doc.charCodeAt(10) - 48;
  }
  if (/^[0-9A-Z]{12}[0-9]{2}$/.test(doc)) {
    let soma = 0, peso = 2;
    for (let i = 12; i >= 1; i--) { soma += (doc.charCodeAt(i - 1) - 48) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const d1 = soma % 11 <= 1 ? 0 : 11 - soma % 11;
    soma = d1 * 2; peso = 3;
    for (let i = 12; i >= 1; i--) { soma += (doc.charCodeAt(i - 1) - 48) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const d2 = soma % 11 <= 1 ? 0 : 11 - soma % 11;
    return d1 === doc.charCodeAt(12) - 48 && d2 === doc.charCodeAt(13) - 48;
  }
  return false;
}
/** Formato que os CHECKs de documento da 091 exigem (`^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$`). */
const formato091 = d => /^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$/.test(d);
/** Mesmas regras de dataValida / diasAntes / diaBrasil (renovacao-fundador.ts). */
const dataValida = d => typeof d === 'string' && DATA.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
function diasAntes(data, dias) {
  if (!dataValida(data)) throw new Error('Data de renovação inválida.');
  return new Date(Date.parse(data) - dias * 86400000).toISOString().slice(0, 10);
}
const diaBrasil = data => new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'}).format(data);

// ---------- banco (somente leitura) ----------
/**
 * Uma leitura numa transação READ ONLY própria. `sql` pode ser uma função (contrato da 109, que faz as próprias consultas no
 * mesmo cliente): aí a transação também fixa o search_path, como o núcleo da 109.
 */
async function somenteLeitura(db, sql, params = [], tempo = '30s') {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query(`SET LOCAL statement_timeout = '${tempo}'`);
    if (typeof sql === 'function') await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = typeof sql === 'function' ? await sql() : await db.query(sql, params);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}

/** Contrato do cron da renovação (o mesmo que o núcleo da 109 importa), conferido por sha256 antes do import. */
async function carregarContrato109(raiz = path.resolve(__dirname, '..'), importar = url => import(url)) {
  const n109 = require('./migration-109-comum.cjs');
  const {lerRevisado} = require('./migration-092-094-comum.cjs');
  try { for (const [arquivo, hash] of n109.CONTRATO) lerRevisado(raiz, arquivo, hash); } catch { throw new Error('CONTRATO_109_DIVERGENTE'); }
  let m;
  try { m = await importar(pathToFileURL(path.join(raiz, 'lib/assinatura/renovacao-schema.ts')).href); } catch { throw new Error('CONTRATO_109_INDISPONIVEL'); }
  if (typeof m?.capacidadeRenovacao !== 'function') throw new Error('CONTRATO_109_INDISPONIVEL');
  return m;
}

/**
 * 105 (revisão Astra r2, A): o núcleo classifica "completa" por presença (6 tabelas, função e gatilho homônimos). Com
 * "completa", o B-5 roda também a integridade SOMENTE DE CATÁLOGO do próprio aplicador (database/checks/
 * 20261027_105_integridade.sql, conferida pelo sha256 do aplicador: colunas e restrições por tabela, os 11 índices com
 * mcp_oauth_concessoes_ativa_uk ÚNICO e PARCIAL, corpo da função e gatilho na relação certa) e exige o índice único parcial
 * válido, pronto e vivo. Qualquer falta = "incompleta", que diverge do prefixo (PARAR).
 */
const INTEGRIDADE_105 = Object.freeze(require('./migration-105-comum.cjs').ETAPAS.find(e => e[0] === 'integridade 105'));
// Estrutura da 105 (revisões Astra r3–r7) em módulo próprio desde a rodada 8: definição do índice e do gatilho, função, NOT NULL,
// colunas e o catálogo inteiro da relação (SQL_RELACAO_105, com search_path = pg_catalog na mesma fotografia).
const {INDICE_105_DEF, GATILHO_105_DEF, CORPO_105, NAO_NULAS_105, COLUNAS_105, SQL_ESTRUTURA_105, SQL_RELACAO_105, RELACAO_105} = require('./conferencia-b5-105.cjs');
function sqlIntegridade105(raiz = path.resolve(__dirname, '..')) {
  const {lerRevisado} = require('./migration-092-094-comum.cjs');
  try { return lerRevisado(raiz, INTEGRIDADE_105[1], INTEGRIDADE_105[2]); } catch { throw new Error('INTEGRIDADE_105_DIVERGENTE'); }
}
async function integridade105(db, sql = sqlIntegridade105()) {
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '30s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const integra = (await db.query(sql)).rows?.[0]?.integra_105;
    const e = (await db.query(SQL_ESTRUTURA_105)).rows?.[0];
    await db.query('SET LOCAL search_path = pg_catalog');
    const relacao = (await db.query(SQL_RELACAO_105)).rows?.[0]?.relacao;
    await db.query('ROLLBACK');
    assert.ok(typeof integra === 'boolean' && typeof e?.indice_flags === 'boolean' && typeof e.gatilho_funcao === 'boolean' && Number.isInteger(e.gatilhos)
      && Number.isInteger(e.gatilhos_relacao) && Number.isInteger(e.regras)
      && [e.indice_def, e.gatilho_def, e.nao_nulas, e.nao_nulas_declaradas, e.colunas, relacao].every(v => v === null || typeof v === 'string'), 'ESTADO_ILEGIVEL integridade 105');
    return integra && e.indice_flags && e.gatilho_funcao && e.gatilhos === 1 && e.indice_def === INDICE_105_DEF && e.gatilho_def === GATILHO_105_DEF
      && e.nao_nulas === NAO_NULAS_105 && e.nao_nulas_declaradas === NAO_NULAS_105 && e.gatilhos_relacao === 1 && e.regras === 0
      && e.colunas === COLUNAS_105 && relacao === RELACAO_105;
  } catch (x) { await db.query('ROLLBACK').catch(() => {}); throw x; }
}

/** Um núcleo: SQL_ESTADO + lerEstado; a 109 com a capacidade do contrato; a 102–103 lê a linha SERVICOS se puder. */
async function lerNucleo(db, rotulo, nucleo, ctx) {
  const linha = (await somenteLeitura(db, nucleo.SQL_ESTADO)).rows[0];
  if (rotulo === '109') {
    const contrato = await ctx.contrato109();
    return nucleo.lerEstado(linha, await somenteLeitura(db, () => contrato.capacidadeRenovacao(db)));
  }
  const s = nucleo.lerEstado(linha);
  // Revisão Astra r3 (C): a sentinela da 103 (linha SERVICOS) só é lida com tipo, privilégio e RLS conferidos; senão, indeterminada.
  // Revisão Astra r4 (B): a mesma classificação quando a falta já aparece no primeiro retrato (dependência ou SELECT):
  // 103 indeterminada com motivo M103_*, nunca o "nao_lida" genérico.
  // Revisão Astra r5 (B): o motivo do primeiro retrato é sempre preservado; presença e tipo das DUAS relações são conferidos
  // sempre (uma view estável em public.adicionais passa no to_regclass do núcleo); SELECT e RLS só em adicional_categorias.
  if (rotulo === '102-103') {
    const vis = [];
    if (!s.d103) vis.push('M103_DEPENDENCIA_AUSENTE');
    else if (!s.ler_103) vis.push('M103_SEM_PRIVILEGIO_LEITURA adicional_categorias');
    for (const m of await visibilidade(db, ['adicional_categorias', 'adicionais'], 'M103')) {
      if (m.endsWith(' adicionais') && !/^M103_(AUSENTES|NAO_E_TABELA) /.test(m)) continue;
      if (!vis.includes(m)) vis.push(m);
    }
    if (vis.length) { s.m103 = 'indeterminada'; s.visibilidade = vis; }
    else s.m103 = nucleo.lerCategoria((await somenteLeitura(db, nucleo.SQL_CATEGORIA_103)).rows[0]);
  }
  if (rotulo === '114') s.m114 = estado114(nucleo, linha, s.m114);
  if (rotulo === '105' && s.m105 === 'completa' && !(await integridade105(db, ctx.sqlIntegridade105?.()))) s.m105 = 'incompleta';
  return s;
}
/**
 * O núcleo da 114 só chama de "ausente" o par ANTERIOR de staging (revisão da 098/108). Antes do E3, production tem o par
 * comprovado CORPOS_114_ANTES_DO_E3 (019 + 062), que o núcleo chama de "divergente". Revisão Astra r1 (P1): só esse par
 * exato, sem a função nova e sem o corpo dela, vira "ausente"; corpo ausente, desconhecido ou misturado continua
 * "divergente". O "ausente" do núcleo (par de staging) é outro prefixo (098/108 presente): rótulo próprio, que diverge.
 */
function estado114(nucleo, linha, m114) {
  const par = c => linha.hash_lock === c.lock && linha.hash_revisao === c.revisao;
  const semNova = linha.f114 === false && linha.hash_exigir === null;
  if (m114 === 'ausente') return semNova && par(CORPOS_114_ANTES_DO_E3) ? 'ausente' : 'ausente_par_de_staging';
  if (m114 !== 'divergente') return m114;
  return semNova && par(CORPOS_114_ANTES_DO_E3) ? 'ausente' : 'divergente';
}
/** Lê uma lista de núcleos. ESTADO_ILEGIVEL/AssertionError = ILEGIVEL (PARAR); qualquer outro erro sobe (FALHA). */
async function lerLista(db, lista, carregar, ctx) {
  const r = {}, motivos = [], papeis = [];
  for (const [rotulo, modulo, campos] of lista) {
    const nucleo = carregar(modulo);
    let s;
    try { s = await lerNucleo(db, rotulo, nucleo, ctx); }
    catch (e) {
      if (!/ESTADO_ILEGIVEL|AssertionError/.test(String(e?.name) + String(e?.message))) throw e;
      for (const c of campos) r[c.slice(1)] = 'ILEGIVEL';
      motivos.push('ESTADO_ILEGIVEL ' + rotulo); papeis.push('ilegivel'); continue;
    }
    papeis.push(typeof s.papel_trocado === 'boolean' ? s.papel_trocado : 'ilegivel');
    if (Array.isArray(s.visibilidade)) motivos.push(...s.visibilidade);
    for (const c of campos) {
      const v = s[c];
      r[c.slice(1)] = typeof v === 'string' ? v : 'ILEGIVEL';
      if (v === 'parcial' || v === 'PARCIAL') motivos.push('APLICACAO_PARCIAL ' + c.slice(1));
      if (typeof v !== 'string') motivos.push('ESTADO_ILEGIVEL ' + c.slice(1));
    }
  }
  return {r, motivos, papeis};
}

/** 118 (importação em lote, cotas): sem núcleo de leitura na árvore; os 7 objetos dela pelo catálogo. */
const OBJETOS_118 = 7;
const SQL_ESTADO_118 = `SELECT
  (SELECT count(*)::int FROM unnest(ARRAY['ia_importacao_cotas', 'ia_importacao_usos']) t WHERE to_regclass('public.' || t) IS NOT NULL) AS tabelas,
  (SELECT count(*)::int FROM unnest(ARRAY['kidmais_118_janela_migracao(timestamp with time zone,timestamp with time zone)',
     'kidmais_118_periodo_mensal(timestamp with time zone)', 'kidmais_118_guarda()']) f WHERE to_regprocedure('public.' || f) IS NOT NULL) AS funcoes,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('ia_importacao_cotas_118_guarda', 'ia_importacao_usos_118_guarda')
     AND tgrelid IN (SELECT to_regclass('public.' || t) FROM unnest(ARRAY['ia_importacao_cotas', 'ia_importacao_usos']) t)) AS gatilhos`;
function lerEstado118(l) {
  for (const k of ['tabelas', 'funcoes', 'gatilhos']) assert.ok(Number.isInteger(l?.[k]) && l[k] >= 0, 'ESTADO_118_ILEGIVEL');
  const n = l.tabelas + l.funcoes + l.gatilhos;
  return n === 0 ? 'ausente' : n === OBJETOS_118 ? 'presente' : 'parcial';
}

/**
 * Estado de cada migration pelo núcleo do aplicador; "parcial", ilegível ou 100 "divergente" = parar.
 * `papel_trocado` (session_user <> current_user, que todos os núcleos devolvem; revisão do B-5, P2-1) é preservado:
 * leitura divergente entre núcleos ou ausente = parar; papel trocado só passa com previsão explícita do operador
 * (`KIDMAIS_B5_PAPEL_TROCADO_ESPERADO=sim` exportada antes de colar, conforme o CONFERIR anterior de produção).
 * B-5 ampliado: os núcleos de 102–117 entram na mesma leitura de papel, e o estado de cada um é comparado com o prefixo
 * esperado antes do E3.
 */
async function estados(db, carregar = m => require(m), env = {}, ctx = {contrato109: () => carregarContrato109()}) {
  const base = await lerLista(db, MIGRACOES, carregar, ctx);
  const amp = await lerLista(db, AMPLIADAS, carregar, ctx);
  // 108: o estado do prefixo é o da regra da candidata (B-21, classificarCombinados), que conhece o corpo da revisão recriado
  // pela 114; o classificar108 do núcleo (staging) não conhece e dá PARCIAL com a 114 aplicada (sonda PG, 08/11). O valor
  // do núcleo fica como diagnóstico; os motivos de parcial/ilegível dele saem só se o B-21 também não for AUSENTE.
  if (ctx.combinados108 !== undefined) {
    amp.r.nucleo108 = amp.r['108'];
    amp.r['108'] = ctx.combinados108;
    amp.motivos = amp.motivos.filter(m => !(/^(APLICACAO_PARCIAL|ESTADO_ILEGIVEL) 108$/.test(m) && ctx.combinados108 !== 'AUSENTE'));
  }
  const motivos = [...base.motivos, ...amp.motivos];
  if (base.r['100'] === 'divergente') motivos.push('CORPO_DIVERGENTE 100 (098 presente ou deriva)');
  try { amp.r['118'] = lerEstado118((await somenteLeitura(db, SQL_ESTADO_118)).rows[0]); }
  catch (e) { if (String(e?.message) !== 'ESTADO_118_ILEGIVEL') throw e; amp.r['118'] = 'ILEGIVEL'; }
  const prefixo = ctx.prefixo ?? PREFIXOS.completo;
  for (const [id, esperado] of Object.entries(prefixo.base)) {
    if (base.r[id] !== esperado) motivos.push(`PREFIXO_DIVERGENTE ${id}:${base.r[id]} (esperado ${esperado})`);
  }
  for (const [id, esperado] of Object.entries(prefixo.ampliado)) {
    if (amp.r[id] !== esperado) motivos.push(`PREFIXO_DIVERGENTE ${id}:${amp.r[id]} (esperado ${esperado})`);
  }
  const papeis = new Set([...base.papeis, ...amp.papeis]);
  const papelTrocado = papeis.size === 1 && typeof [...papeis][0] === 'boolean' ? [...papeis][0] : 'INCONSISTENTE';
  if (papelTrocado === 'INCONSISTENTE') motivos.push('PAPEL_TROCADO_ILEGIVEL_OU_INCONSISTENTE');
  else if (papelTrocado && env.KIDMAIS_B5_PAPEL_TROCADO_ESPERADO !== 'sim') motivos.push('PAPEL_TROCADO_INESPERADO');
  else if (!papelTrocado && env.KIDMAIS_B5_PAPEL_TROCADO_ESPERADO === 'sim') motivos.push('PAPEL_TROCADO_ESPERADO_MAS_AUSENTE');
  return {estados: {...base.r, ...EXCLUIDAS}, ampliados: {...amp.r, ...SEM_MIGRATION}, papelTrocado, motivos};
}
/** Presentes = qualquer migration fora do estado de partida (ausente; para a 100, "sem_094" ou "ausente"). */
const presentes = s => Object.entries(s).filter(([k, v]) => !(k in EXCLUIDAS) && v !== 'ausente' && !(k === '100' && v === 'sem_094')).map(([k, v]) => `${k}:${v}`);

// ---------- B-21: salões combinados (098 histórica / 108) ----------
/**
 * A candidata RECUSA a agenda com os combinados em ANTIGA (098 histórica) ou PARCIAL e só habilita em NOVA (108), que está
 * fora desta promoção (D-ESC-6). Constantes do detector: as de scripts/migration-108-retrato.cjs (NOVA, conferidas contra o
 * .ts) e o corpo da regra de conflito da 098. SQL_COMBINADOS é o TEXTO de lerCatalogoCombinados e classificarCombinados é a
 * mesma regra (o teste compara os dois com o .ts). Diferença deliberada: sem linha ou linha ilegível = PARAR (o detector
 * trata "sem linha" como AUSENTE; aqui a ausência só vale lida do catálogo).
 */
const CONFLITO_098 = 'a3b9bcb198adbe4cd0595c56a5def99aff8463f96f0c192554f42099029ca05a';
// Liberar agenda com mais de um salão (D-LIB-6): com o marcador da 114, só o corpo da revisão recriado por ela vale.
const REVISAO_114 = 'dcbfd2b296635249273d36a2593baf15eefb27fa9628523357df4b56476638a1';
const TOTAL_FUNCOES_COMBINADOS = Object.keys(ret108.NOVA.funcoes).length;
const corpoCombinados = assinatura =>
  `(SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.${assinatura}'))`;
const SQL_COMBINADOS = (() => {
  const funcoes = Object.entries(ret108.NOVA.funcoes).map(([n, h]) => `('${n}', '${h}')`).join(", ");
  const gatilhos = ret108.NOVA.gatilhos.map(([n, t, f, tipo, dif, col]) => `('${n}', '${t}', '${f}', ${tipo}, ${dif}, ${col ? `'${col}'` : "NULL::text"})`).join(", ");
  return `SELECT (SELECT count(*)::int FROM (VALUES ${funcoes}) AS e(nome, h) JOIN pg_proc p ON p.proname = e.nome AND p.pronamespace = 'public'::regnamespace
              WHERE encode(sha256(convert_to(replace(p.prosrc, E'\\r', ''), 'UTF8')), 'hex') = e.h) AS funcoes,
            (SELECT count(DISTINCT p.proname)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'kidmais098\\_%') AS funcoes_qualquer,
            EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.agenda_saloes') AND attname = 'combinado' AND NOT attisdropped) AS combinado,
            EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.agenda_saloes') AND attname = 'membros' AND NOT attisdropped) AS membros,
            EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.agenda_saloes') AND conname = 'agenda_saloes_098_membros_check'
                     AND contype = 'c' AND convalidated AND NOT connoinherit
                     AND regexp_replace(replace(pg_get_constraintdef(oid), 'public.', ''), '[\\s()]', '', 'g') = '${ret108.NOVA.checkMembros}') AS check_ok,
            (SELECT count(*)::int FROM (VALUES ${gatilhos}) AS g(nome, tabela, funcao, tipo, diferido, coluna)
              WHERE EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                             WHERE t.tgname = g.nome AND t.tgrelid = to_regclass('public.' || g.tabela) AND NOT t.tgisinternal
                               AND t.tgenabled = 'O' AND p.proname = g.funcao AND p.pronamespace = 'public'::regnamespace
                               AND t.tgtype = g.tipo AND t.tgdeferrable = g.diferido AND t.tginitdeferred = g.diferido
                               AND t.tgnargs = 0 AND t.tgqual IS NULL
                               -- tgattr é int2vector (base 0): compara pelo texto dos números de coluna, não por igualdade de arrays.
                               AND array_to_string(t.tgattr::int2[], ',') = coalesce((SELECT a.attnum::text FROM pg_attribute a
                                     WHERE a.attrelid = t.tgrelid AND a.attname = g.coluna AND NOT a.attisdropped), ''))) AS gatilhos_ok,
            (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%\\_098\\_%') AS gatilhos_qualquer,
            ${corpoCombinados("kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)")} AS conflito,
            ${corpoCombinados("kidmais019_validar_contrato()")} AS contrato,
            ${corpoCombinados("kidmais_validar_agenda_revisao()")} AS revisao,
            to_regprocedure('public.kidmais108_instalada()') IS NOT NULL AS marcador,
            to_regprocedure('public.kidmais114_exigir_configuracao(uuid)') IS NOT NULL AS marcador114`;
})();
/** Linha do catálogo → objeto do detector (CatalogoCombinados). Tipos conferidos: qualquer desvio = ilegível (PARAR). */
function lerCombinados(l) {
  for (const k of ['funcoes', 'funcoes_qualquer', 'gatilhos_ok', 'gatilhos_qualquer']) assert.ok(Number.isInteger(l?.[k]) && l[k] >= 0, 'COMBINADOS_ILEGIVEIS');
  for (const k of ['combinado', 'membros', 'check_ok', 'marcador', 'marcador114']) assert.equal(typeof l[k], 'boolean', 'COMBINADOS_ILEGIVEIS');
  // typeof antes da regex: RegExp.test converte para texto, e array, Buffer ou String objeto passariam (P2 da revisão do B-21).
  for (const k of ['conflito', 'contrato', 'revisao']) assert.ok(l[k] === null || (typeof l[k] === 'string' && /^[0-9a-f]{64}$/.test(l[k])), 'COMBINADOS_ILEGIVEIS');
  return {funcoes: l.funcoes, funcoesQualquer: l.funcoes_qualquer, colunaCombinado: l.combinado, colunaMembros: l.membros, checkValidado: l.check_ok,
    gatilhosOk: l.gatilhos_ok, gatilhosQualquer: l.gatilhos_qualquer, conflito: l.conflito, contrato: l.contrato, revisao: l.revisao, marcador108: l.marcador, marcador114: l.marcador114};
}
/** Mesma regra de classificarCombinados (lib/agenda/estado-combinados.ts). */
function classificarCombinados(c) {
  const algum = c.funcoesQualquer > 0 || c.colunaCombinado || c.colunaMembros || c.gatilhosQualquer > 0 || c.marcador108;
  if (!algum) return 'AUSENTE';
  const nucleo = c.funcoes === TOTAL_FUNCOES_COMBINADOS && c.funcoesQualquer === TOTAL_FUNCOES_COMBINADOS && c.colunaCombinado && c.colunaMembros
    && c.checkValidado && c.gatilhosOk === ret108.NOVA.gatilhos.length && c.gatilhosQualquer === ret108.NOVA.gatilhos.length
    && c.contrato === ret108.NOVA.hashes.contrato && c.revisao === (c.marcador114 ? REVISAO_114 : ret108.NOVA.hashes.revisao);
  if (nucleo && c.marcador108 && c.conflito === ret108.NOVA.hashes.conflito108) return 'NOVA';
  if (nucleo && !c.marcador108 && c.conflito === CONFLITO_098) return 'ANTIGA';
  return 'PARCIAL';
}
const MOTIVO_COMBINADOS = Object.freeze({ANTIGA: 'COMBINADOS_ANTIGA (098 historica presente)', PARCIAL: 'COMBINADOS_PARCIAL',
  NOVA: 'COMBINADOS_NOVA (108 presente: reconciliar o escopo, D-ESC-6)'});
/** Estado e catálogo (só contagens, booleanos e corpos de função; nenhum dado de negócio). */
async function combinados(db) {
  const linhas = (await somenteLeitura(db, SQL_COMBINADOS)).rows;
  let c;
  try { assert.equal(linhas?.length, 1, 'COMBINADOS_ILEGIVEIS'); c = lerCombinados(linhas[0]); }
  catch { return {combinados: {estado: 'ILEGIVEL'}, motivos: ['COMBINADOS_ILEGIVEIS']}; }
  const estado = classificarCombinados(c);
  return {combinados: {estado, catalogo: c}, motivos: estado === 'AUSENTE' ? [] : [MOTIVO_COMBINADOS[estado]]};
}

// ---------- matriz da §9.2.2 (contagens agregadas; o veredito G-VAZIO é do B-26) ----------
/**
 * [objeto, migration, grupo, estrutura]. Estrutura: OBRIGATORIA (núcleo e classificados da base: ausente = PARAR),
 * SE_PRESENTE (ausente é o esperado antes do E3), PROIBIDA (fora do escopo: presente = PARAR). Domínio: VAZIA para os grupos
 * de cobrança e créditos (linha = PARAR: ramo COM-DADOS ou barreira perdida); CLASSIFICADA só conta, com as paradas que a
 * contagem decide sozinha (exceção vigente de tipo revogável, continuidade não concluída, histórico de cadastro com linha).
 */
const MATRIZ = Object.freeze([
  ['empresa_assinaturas', '067', 'NUCLEO', 'OBRIGATORIA'], ['cobranca_eventos', '068', 'NUCLEO', 'OBRIGATORIA'],
  ['assinatura_fundadores', '074a', 'NUCLEO', 'OBRIGATORIA'], ['assinatura_contratacoes', '074a', 'NUCLEO', 'OBRIGATORIA'],
  ['assinatura_renovacoes', '075', 'NUCLEO', 'OBRIGATORIA'], ['assinatura_avisos', '087', 'NUCLEO', 'OBRIGATORIA'],
  ['assinatura_encerramentos', '089', 'ENCERRAMENTO_CONTRATACAO', 'SE_PRESENTE'], ['assinatura_comprovantes', '096', 'ENCERRAMENTO_CONTRATACAO', 'SE_PRESENTE'],
  ['assinatura_arrependimentos', '097', 'ENCERRAMENTO_CONTRATACAO', 'SE_PRESENTE'], ['assinatura_campanhas', '090', 'CAMPANHA', 'SE_PRESENTE'],
  ...['pedidos', 'cobrancas', 'devolucoes'].map(t => [`ia_credito_${t}`, '095', 'CREDITOS_PAGOS', 'SE_PRESENTE']),
  ...['carteiras', 'lotes', 'lancamentos', 'reservas', 'reserva_lotes', 'cortesias', 'cortes', 'notificacoes'].map(t => [`ia_credito_${t}`, '095', 'CREDITOS_GERAIS', 'SE_PRESENTE']),
  ['ia_credito_franquias_ciclo', '116', 'FORA_DO_ESCOPO', 'PROIBIDA'], ['ia_credito_franquia_pendencias', '116', 'FORA_DO_ESCOPO', 'PROIBIDA'],
  ['assinatura_isencoes', '074a', 'CLASSIFICADA', 'OBRIGATORIA'], ['empresa_excecoes_comerciais', '067', 'CLASSIFICADA', 'OBRIGATORIA'],
  ['empresa_documento_continuidades', '091', 'CLASSIFICADA', 'SE_PRESENTE'], ['cadastros_empresas', '069', 'CLASSIFICADA', 'OBRIGATORIA'],
  ['cadastros_publicos', '069', 'CLASSIFICADA', 'OBRIGATORIA']].map(Object.freeze));
const GRUPOS_VAZIOS = Object.freeze(['NUCLEO', 'ENCERRAMENTO_CONTRATACAO', 'CAMPANHA', 'CREDITOS_PAGOS', 'CREDITOS_GERAIS']);
const SQL_MATRIZ_CATALOGO = `SELECT o.nome, (c.oid IS NOT NULL) AS presente, coalesce(c.relkind::text, '') AS tipo,
    coalesce(c.relrowsecurity, false) AS rls, coalesce(c.relforcerowsecurity, false) AS rls_forcada,
    coalesce(has_table_privilege(current_user, c.oid, 'SELECT'), false) AS ler
  FROM unnest($1::text[]) WITH ORDINALITY AS o(nome, ordem) LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || o.nome)
  ORDER BY o.ordem`;
const SQL_MATRIZ_PAPEL = 'SELECT rolsuper AS superusuario, rolbypassrls AS ignora_rls FROM pg_roles WHERE rolname = current_user';
/** Contagem por objeto; os classificados com os recortes que decidem paradas (tudo agregado). */
const CONTAGEM_EXTRA = Object.freeze({
  empresa_excecoes_comerciais: ", count(*) FILTER (WHERE revogada_em IS NULL AND valida_ate > now() AND tipo <> 'EXTENSAO_TESTE')::text AS vigentes_revogaveis",
  empresa_documento_continuidades: ", count(*) FILTER (WHERE situacao <> 'CONCLUIDA')::text AS nao_concluidas",
  cadastros_publicos: ", count(*) FILTER (WHERE situacao = 'PENDENTE')::text AS pendentes, count(*) FILTER (WHERE situacao = 'CONFIRMADO')::text AS confirmados"
    + ", count(*) FILTER (WHERE situacao = 'SUBSTITUIDO')::text AS substituidos"
    + ", count(*) FILTER (WHERE situacao = 'PENDENTE' AND expira_em > now())::text AS pendentes_nao_expirados",
  // §9.2.2 (revisão Astra r1, P2-E): com linha, abrir a origem do lote (compra ou vínculo a pedido × franquia, cortesia, legado).
  ia_credito_lotes: ", count(*) FILTER (WHERE origem = 'COMPRA')::text AS origem_compra, count(*) FILTER (WHERE origem = 'FRANQUIA')::text AS origem_franquia"
    + ", count(*) FILTER (WHERE origem = 'CORTESIA')::text AS origem_cortesia, count(*) FILTER (WHERE origem = 'LEGADO')::text AS origem_legado"
    + ", count(*) FILTER (WHERE pedido_id IS NOT NULL)::text AS com_pedido"});
const sqlContagem = t => { assert.match(t, /^[a-z_]+$/, 'MATRIZ_ILEGIVEL'); return `SELECT count(*)::text AS linhas${CONTAGEM_EXTRA[t] ?? ''} FROM public.${t}`; };
const inteiro = v => { assert.ok(typeof v === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(v), 'MATRIZ_ILEGIVEL'); return Number(v); };
/** Fotografia coerente: catálogo, papel e contagens numa só transação REPEATABLE READ READ ONLY. */
async function matriz(db) {
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    const cat = (await db.query(SQL_MATRIZ_CATALOGO, [MATRIZ.map(m => m[0])])).rows;
    assert.ok(Array.isArray(cat) && cat.length === MATRIZ.length && cat.every((l, i) => l?.nome === MATRIZ[i][0]), 'MATRIZ_ILEGIVEL');
    const papel = (await db.query(SQL_MATRIZ_PAPEL)).rows;
    assert.ok(papel?.length === 1 && typeof papel[0].superusuario === 'boolean' && typeof papel[0].ignora_rls === 'boolean', 'MATRIZ_ILEGIVEL');
    const objetos = {}, motivos = [];
    for (const [i, [nome, migracao, grupo, estrutura]] of MATRIZ.entries()) {
      const l = cat[i];
      for (const k of ['presente', 'rls', 'rls_forcada', 'ler']) assert.ok(typeof l[k] === 'boolean', 'MATRIZ_ILEGIVEL');
      const o = objetos[nome] = {migracao, grupo, estrutura: l.presente ? 'PRESENTE' : 'AUSENTE'};
      if (!l.presente) {
        if (estrutura === 'OBRIGATORIA') motivos.push('MATRIZ_ESTRUTURA_AUSENTE ' + nome);
        continue;
      }
      if (estrutura === 'PROIBIDA') motivos.push('MATRIZ_FORA_DO_ESCOPO_PRESENTE ' + nome);
      if (!['r', 'p'].includes(l.tipo)) { motivos.push('MATRIZ_NAO_E_TABELA ' + nome); continue; }
      if (!l.ler) { motivos.push('MATRIZ_SEM_PRIVILEGIO_LEITURA ' + nome); continue; }
      o.rls = l.rls; o.rlsForcada = l.rls_forcada;
      // RLS que possa induzir zero é FALHA (§9.2.2): só não vale para superusuário ou papel com BYPASSRLS.
      // Revisão Astra r2 (F): com RLS que pode induzir zero, a contagem não é lida (INDETERMINADA), nem vira zero.
      if (l.rls && !papel[0].superusuario && !papel[0].ignora_rls) { motivos.push('MATRIZ_RLS_PODE_INDUZIR_ZERO ' + nome); o.linhas = null; o.contagem = 'INDETERMINADA_RLS'; continue; }
      const c = (await db.query(sqlContagem(nome))).rows;
      assert.ok(c?.length === 1, 'MATRIZ_ILEGIVEL');
      for (const [k, v] of Object.entries(c[0])) o[k.replace(/_([a-z])/g, (_, x) => x.toUpperCase())] = inteiro(v);
      if (GRUPOS_VAZIOS.includes(grupo) && o.linhas > 0) motivos.push(`MATRIZ_VAZIA_COM_LINHAS ${nome} ${o.linhas}`);
    }
    const ex = objetos.empresa_excecoes_comerciais, ct = objetos.empresa_documento_continuidades, ce = objetos.cadastros_empresas;
    if (ex?.vigentesRevogaveis > 0) motivos.push('MATRIZ_EXCECAO_VIGENTE_NAO_TERMINAL ' + ex.vigentesRevogaveis);
    if (ct?.naoConcluidas > 0) motivos.push('MATRIZ_CONTINUIDADE_NAO_CONCLUIDA ' + ct.naoConcluidas);
    if (ce?.linhas > 0) motivos.push('MATRIZ_CADASTRO_EMPRESA_EXIGE_EXPLICACAO_P1 ' + ce.linhas);
    await db.query('ROLLBACK');
    return {matriz: {protocolo: 'REPEATABLE READ READ ONLY', papel: {superusuario: papel[0].superusuario, ignoraRls: papel[0].ignora_rls}, objetos,
      veredito: 'NAO_EMITIDO: G-VAZIO e do conferidor B-26 (hashes, auditoria, prefixo por marcadores, regra de fechamento)'}, motivos};
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}

// ---------- B-15 reescopado (§9.2.7) ----------
/** Precheck estrutural da 091 (migration 091, linhas 20–37), lido do catálogo: as mesmas tabelas, os mesmos 5 CHECKs (contagem literal). */
const CHECKS_091 = Object.freeze(['empresa_assinaturas_documento_teste_check', 'assinatura_fundadores_documento_beneficiario_check', 'cadastros_empresas_documento_check',
  'solicitacoes_documento_check', 'empresa_representacoes_qualificacao_check']);
const TABELAS_091 = Object.freeze(['empresa_assinaturas', 'assinatura_fundadores', 'cadastros_empresas', 'solicitacoes_acesso_empresa', 'empresa_representacoes',
  'usuarios_administrativos']);
const SQL_COMPATIBILIDADE_091 = `SELECT
  (SELECT count(*)::int FROM unnest(ARRAY[${TABELAS_091.map(t => `'${t}'`).join(', ')}]) t WHERE to_regclass('public.' || t) IS NOT NULL) AS tabelas,
  (SELECT count(*)::int FROM pg_constraint WHERE contype = 'c' AND conname IN (${CHECKS_091.map(c => `'${c}'`).join(', ')})) AS checks,
  (to_regprocedure('public.kidmais_091_documento_valido(text)') IS NOT NULL OR to_regprocedure('public.kidmais_091_documento_guarda()') IS NOT NULL
    OR to_regclass('public.empresa_documento_continuidades') IS NOT NULL OR to_regprocedure('public.kidmais_091_continuidade_guarda()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('empresa_assinaturas_091_documento', 'assinatura_fundadores_091_documento'))) AS objetos_091,
  (to_regclass('public.plataforma_empresas_cadastro') IS NOT NULL) AS plataforma`;
/**
 * Revisão Astra r1 (P2-F): além da contagem literal, cada CHECK na SUA relação de public, validado, na coluna certa e com a
 * definição da base (067/068/069/074a): o padrão de 14 posições, sem o formato novo da 091 (que aceita 11 dígitos) e, na
 * qualificação, sem TITULAR_PF. Trechos de pg_get_constraintdef, conferidos no PostgreSQL descartável. [nome, tabela, coluna,
 * trechos exigidos, trechos proibidos].
 */
// Revisão Astra r2 (C): a definição INTEIRA de pg_get_constraintdef(oid, false), sob search_path fixo, igual à referência
// produzida pelas migrations da base no PostgreSQL 18 descartável (sonda); outra versão maior = sem referência (PARAR).
const VERSAO_MAIOR_REFERENCIA_091 = 18;
const DEF_PADRAO = col => `CHECK ((${col} ~ '^[0-9A-Z]{12}[0-9]{2}$'::text))`;
const CHECKS_BASE_091 = Object.freeze([
  ['empresa_assinaturas_documento_teste_check', 'empresa_assinaturas', 'documento_teste',
    "CHECK (((documento_teste IS NULL) OR (documento_teste ~ '^[0-9A-Z]{12}[0-9]{2}$'::text)))"],
  ['assinatura_fundadores_documento_beneficiario_check', 'assinatura_fundadores', 'documento_beneficiario', DEF_PADRAO('documento_beneficiario')],
  ['cadastros_empresas_documento_check', 'cadastros_empresas', 'documento', DEF_PADRAO('documento')],
  ['solicitacoes_documento_check', 'solicitacoes_acesso_empresa', 'documento', DEF_PADRAO('documento')],
  ['empresa_representacoes_qualificacao_check', 'empresa_representacoes', 'qualificacao',
    "CHECK ((qualificacao = ANY (ARRAY['SOCIO_ADMINISTRADOR'::text, 'PROCURADOR'::text, 'RESPONSAVEL_INDICADO'::text])))"],
].map(Object.freeze));
const SQL_VERSAO_PG = "SELECT current_setting('server_version_num')::int AS versao_pg";
const SQL_CHECKS_091 = `SELECT c.conname::text AS nome, n.nspname::text AS esquema, cl.relname::text AS tabela, c.convalidated AS validado,
    pg_get_constraintdef(c.oid, false) AS definicao,
    (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) AS colunas
  FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
  WHERE c.contype = 'c' AND c.conname = ANY ($1::text[])
  ORDER BY 1, 2, 3`;
/** Divergências por CHECK (vazio = conforme). Linha fora do formato = B15_CATALOGO_ILEGIVEL (FALHA). */
function checksPorRelacao(linhas) {
  assert.ok(Array.isArray(linhas), 'B15_CATALOGO_ILEGIVEL');
  for (const l of linhas) {
    for (const k of ['nome', 'esquema', 'tabela', 'definicao']) assert.ok(typeof l?.[k] === 'string', 'B15_CATALOGO_ILEGIVEL');
    assert.ok(typeof l.validado === 'boolean' && Array.isArray(l.colunas) && l.colunas.every(c => typeof c === 'string'), 'B15_CATALOGO_ILEGIVEL');
  }
  const divergentes = [];
  for (const [nome, tabela, coluna, definicao] of CHECKS_BASE_091) {
    const certos = linhas.filter(l => l.nome === nome && l.esquema === 'public' && l.tabela === tabela);
    const outros = linhas.filter(l => l.nome === nome && !(l.esquema === 'public' && l.tabela === tabela));
    const l = certos[0];
    const ok = certos.length === 1 && outros.length === 0 && l.validado && l.colunas.length === 1 && l.colunas[0] === coluna && l.definicao === definicao;
    if (!ok) divergentes.push(nome);
  }
  return divergentes;
}
const SQL_DOCUMENTOS = `SELECT 'empresa_assinaturas' AS origem, a.documento_teste AS doc,
    EXISTS (SELECT 1 FROM public.assinatura_fundadores f WHERE f.empresa_id = a.empresa_id) AS tem_concessao
  FROM public.empresa_assinaturas a
  UNION ALL
  SELECT 'assinatura_fundadores', f.documento_beneficiario, true FROM public.assinatura_fundadores f`;
/** B-15: só contagens. Documento nulo não é recusado pelo gatilho (doc IS NOT NULL) nem pelos CHECKs novos. */
function inventarioDocumentos(linhas) {
  const base = () => ({total: 0, nulos: 0, cpf11: 0, cnpj14: 0, outroFormato: 0, foraDoFormato091: 0, dvInvalido: 0});
  const r = {empresa_assinaturas: base(), assinatura_fundadores: base(), empresasSemConcessaoComDvInvalido: 0};
  for (const l of linhas) {
    const t = r[l.origem]; assert.ok(t, 'ORIGEM_INESPERADA');
    t.total++;
    if (l.doc === null || l.doc === undefined) { t.nulos++; continue; }
    const d = String(l.doc);
    if (/^[0-9]{11}$/.test(d)) t.cpf11++; else if (/^[0-9A-Z]{12}[0-9]{2}$/.test(d)) t.cnpj14++; else t.outroFormato++;
    if (!formato091(d)) t.foraDoFormato091++;
    if (!documentoValido091(d)) { t.dvInvalido++; if (l.origem === 'empresa_assinaturas' && l.tem_concessao === false) r.empresasSemConcessaoComDvInvalido++; }
  }
  r.dvInvalidoTotal = r.empresa_assinaturas.dvInvalido + r.assinatura_fundadores.dvInvalido;
  return r;
}
/** Origens dos documentos que a 091 valida (CHECKs novos) ou que um dia entram nas tabelas do gatilho de INSERT dela. Qualificadas. */
const ORIGENS_091 = Object.freeze(['cadastros_empresas', 'solicitacoes_acesso_empresa', 'plataforma_empresas_cadastro']);
const SQL_ORIGENS_091 = `SELECT 'cadastros_empresas' AS origem, documento AS doc FROM public.cadastros_empresas
  UNION ALL SELECT 'solicitacoes_acesso_empresa', documento FROM public.solicitacoes_acesso_empresa
  UNION ALL SELECT 'plataforma_empresas_cadastro', documento_fiscal FROM public.plataforma_empresas_cadastro`;
/**
 * Visibilidade de relações lidas fora da matriz (origens: revisão Astra r1, P2-F; legado e Fundador: r2, F): presença,
 * privilégio de leitura e RLS sem bypass. Qualquer falta = nenhuma leitura daquela parte (INDETERMINADA) e parada nomeada.
 */
async function visibilidade(db, tabelas, prefixo) {
  const cat = (await somenteLeitura(db, SQL_ORIGENS_CATALOGO, [tabelas])).rows;
  assert.ok(Array.isArray(cat) && cat.length === tabelas.length && cat.every((x, i) => x?.nome === tabelas[i]
    && ['presente', 'rls', 'ler', 'ignora_rls'].every(k => typeof x[k] === 'boolean') && typeof x.tipo === 'string'), 'B15_CATALOGO_ILEGIVEL');
  const motivos = [];
  for (const x of cat) {
    if (!x.presente) motivos.push(`${prefixo}_AUSENTES ${x.nome}`);
    else if (!['r', 'p'].includes(x.tipo)) motivos.push(`${prefixo}_NAO_E_TABELA ${x.nome}`);
    else if (!x.ler) motivos.push(`${prefixo}_SEM_PRIVILEGIO_LEITURA ${x.nome}`);
    else if (x.rls && !x.ignora_rls) motivos.push(`${prefixo}_RLS_PODE_INDUZIR_ZERO ${x.nome}`);
  }
  return motivos;
}
const SQL_ORIGENS_CATALOGO = `SELECT o.nome, (c.oid IS NOT NULL) AS presente, coalesce(c.relkind::text, '') AS tipo, coalesce(c.relrowsecurity, false) AS rls,
    coalesce(has_table_privilege(current_user, c.oid, 'SELECT'), false) AS ler,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS ignora_rls
  FROM unnest($1::text[]) WITH ORDINALITY AS o(nome, ordem) LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || o.nome)
  ORDER BY o.ordem`;
function inventarioOrigens(linhas) {
  const r = Object.fromEntries(ORIGENS_091.map(o => [o, {total: 0, nulos: 0, foraDoFormato091: 0, dvInvalido: 0}]));
  for (const l of linhas) {
    const t = r[l.origem]; assert.ok(t, 'ORIGEM_INESPERADA');
    t.total++;
    if (l.doc === null || l.doc === undefined) { t.nulos++; continue; }
    const d = String(l.doc);
    if (!formato091(d)) t.foraDoFormato091++;
    if (!documentoValido091(d)) t.dvInvalido++;
  }
  return r;
}
const NAO_COBERTO_B15 = Object.freeze(['preservação do APLICAR da 091 (aplicador, migration-091-comum.cjs)', 'classificação do COMMIT e down da 091 (aplicador e §10)',
  'efeito do LOCK das cinco tabelas sob carga (ensaio do aplicador em PG isolado)', 'decisão D-OP-4 (Felipe, no E1; confirmada no E5b)',
  'precheck PASSARIA = só o precheck literal + CHECKs da base por relação; não prova o APLICAR inteiro']);
/**
 * Inventário legado, compatibilidade estrutural da 091 e origens futuras. Só contagens. `matrizParou`: o rótulo da prova
 * artificial fica condicionado ao G-VAZIO do P1 (B-26) e não vale se a própria matriz já mandou parar.
 */
const LEGADO_091 = Object.freeze(['empresa_assinaturas', 'assinatura_fundadores']);
async function b15(db, estado091, matrizParou = false) {
  const visLegado = await visibilidade(db, LEGADO_091, 'B15_LEGADO');
  const legado = visLegado.length ? null : inventarioDocumentos((await somenteLeitura(db, SQL_DOCUMENTOS, [], '60s')).rows);
  const l = (await somenteLeitura(db, SQL_COMPATIBILIDADE_091)).rows[0];
  for (const k of ['tabelas', 'checks']) assert.ok(Number.isInteger(l?.[k]) && l[k] >= 0, 'B15_CATALOGO_ILEGIVEL');
  for (const k of ['objetos_091', 'plataforma']) assert.ok(typeof l?.[k] === 'boolean', 'B15_CATALOGO_ILEGIVEL');
  const motivos = [...visLegado];
  const aplicavel = estado091 === 'ausente';
  let divergentes = null, versaoPg = null;
  if (aplicavel) {
    const lido = await somenteLeitura(db, async () => ({rows: (await db.query(SQL_CHECKS_091, [CHECKS_091])).rows,
      versao: (await db.query(SQL_VERSAO_PG)).rows?.[0]?.versao_pg}));
    assert.ok(Number.isInteger(lido.versao) && lido.versao > 0, 'B15_CATALOGO_ILEGIVEL');
    versaoPg = lido.versao;
    divergentes = checksPorRelacao(lido.rows);
  }
  const semReferencia = versaoPg !== null && Math.floor(versaoPg / 10000) !== VERSAO_MAIOR_REFERENCIA_091;
  const precheck = l.tabelas === TABELAS_091.length && l.checks === CHECKS_091.length && !l.objetos_091;
  const compat = {tabelas: `${l.tabelas}/${TABELAS_091.length}`, checks: `${l.checks}/${CHECKS_091.length}`, objetos091Presentes: l.objetos_091,
    precheckEstrutural: aplicavel ? (precheck ? 'PASSARIA' : 'FALHARIA') : 'NAO_SE_APLICA_091_' + String(estado091).toUpperCase(),
    checksDaBasePorRelacao: !aplicavel ? 'NAO_SE_APLICA' : semReferencia ? 'SEM_REFERENCIA_PG_' + Math.floor(versaoPg / 10000) : divergentes.length ? 'DIVERGENTE' : 'CONFORME',
    versaoPg};
  if (compat.precheckEstrutural === 'FALHARIA') motivos.push('B15_091_PRECHECK_ESTRUTURAL_FALHARIA');
  if (semReferencia) motivos.push('B15_091_DEFINICAO_SEM_REFERENCIA_PG ' + versaoPg);
  else for (const c of divergentes ?? []) motivos.push('B15_091_CHECK_BASE_DIVERGENTE ' + c);
  if (aplicavel && legado) {
    for (const t of ['empresa_assinaturas', 'assinatura_fundadores']) {
      if (legado[t].foraDoFormato091 > 0) motivos.push(`B15_091_CHECK_FALHARIA ${t} ${legado[t].foraDoFormato091}`);
    }
  }
  let origens = null;
  if (l.tabelas === TABELAS_091.length && l.plataforma) {
    const visOrigens = (await visibilidade(db, ORIGENS_091, 'B15_ORIGEM')).map(m => m.replace('B15_ORIGEM_AUSENTES ', 'B15_ORIGENS_AUSENTES '));
    if (visOrigens.length) motivos.push(...visOrigens);
    else {
      origens = inventarioOrigens((await somenteLeitura(db, SQL_ORIGENS_091, [], '60s')).rows);
      if (aplicavel) {
        for (const t of ['cadastros_empresas', 'solicitacoes_acesso_empresa']) {
          if (origens[t].foraDoFormato091 > 0) motivos.push(`B15_091_CHECK_FALHARIA ${t} ${origens[t].foraDoFormato091}`);
        }
      }
    }
  } else motivos.push('B15_ORIGENS_AUSENTES');
  const vazio = legado !== null && legado.empresa_assinaturas.total === 0 && legado.assinatura_fundadores.total === 0;
  const prova = legado === null ? 'INDETERMINADA (legado sem visibilidade completa: nada lido)' : !vazio ? 'EXIGIDA (ramo COM-DADOS)'
    : matrizParou ? 'INDETERMINADA (inventario legado vazio, mas a matriz parou: ramo VAZIO nao comprovado)'
      : 'NAO_APLICAVEL_SE_G_VAZIO_P1 (§9.2.7: inventario legado vazio; condicionado ao veredito G-VAZIO do B-26 no P1; nao vale como prova geral)';
  return {b15: {legado, inventarioLegado: legado === null ? 'INDETERMINADO' : vazio ? 'VAZIO' : 'COM_LINHAS', provaArtificialDocumentoLegado: prova,
    compatibilidade091: compat, origensFuturas: origens, naoCoberto: NAO_COBERTO_B15}, motivos};
}

// ---------- Fundador (sem provedor) ----------
const SQL_RENOVACAO_INSTALADA = "SELECT to_regclass('public.assinatura_renovacoes') IS NOT NULL AS instalada";
/** Sem identificadores do provedor nem valores: só o que decide a data registrada e a cobertura. */
const sqlConcessoes = renovacao => `SELECT (c.id IS NOT NULL) AS tem_contratacao, (c.id = a.contratacao_atual_id) AS atual,
    ${renovacao ? '(SELECT r.primeira_data_regular::text FROM public.assinatura_renovacoes r WHERE r.contratacao_id = c.id)' : 'NULL::text'} AS registrada,
    count(*) OVER (PARTITION BY f.id) AS linhas_da_concessao
  FROM public.assinatura_fundadores f
  LEFT JOIN public.assinatura_contratacoes c ON c.empresa_id = f.empresa_id AND c.fundador_id = f.id AND c.estado = 'CONFIRMADA'
  LEFT JOIN public.empresa_assinaturas a ON a.empresa_id = f.empresa_id
  WHERE f.estado = 'CONFIRMADA'`;
const SQL_TOTAL_CONFIRMADAS = "SELECT count(*)::int AS n FROM public.assinatura_fundadores WHERE estado = 'CONFIRMADA'";

/**
 * Fundador sem provedor (§9.2.4 L1 e §9.2.7). Primeiro a contagem: zero = parte vazia, nenhuma outra leitura. Com
 * concessão confirmada (núcleo não vazio = ramo COM-DADOS, fora desta promoção): só as datas já registradas em
 * assinatura_renovacoes (a do código prevalece), sem consultar o Asaas; as demais ficam sem data e a conferência PARA.
 */
const TABELAS_FUNDADOR = Object.freeze(['assinatura_fundadores', 'assinatura_contratacoes', 'empresa_assinaturas']);
async function fundador(db, agora = new Date()) {
  const vis = await visibilidade(db, TABELAS_FUNDADOR, 'FUNDADOR');
  if (vis.length) return {fundador: {ramo: 'INDETERMINADO (sem visibilidade completa: nada lido)', confirmadas: null, consultasAsaas: 0}, motivos: vis};
  const total = (await somenteLeitura(db, SQL_TOTAL_CONFIRMADAS)).rows[0]?.n;
  assert.ok(Number.isInteger(total) && total >= 0, 'FUNDADOR_TOTAL_ILEGIVEL');
  const hoje = diaBrasil(agora);
  const c = {confirmadas: total, calculadas: 0, registradas: 0, semRegistroProvedorNaoConsultado: 0, contratacaoAusenteOuMultipla: 0, contratacaoNaoAtual: 0,
    consultasAsaas: 0};
  if (total === 0) {
    return {fundador: {...c, ramo: 'SEM_CONCESSAO_CONFIRMADA', hoje, menorPrimeiraDataRegular: null, inicioJanelaAviso: null, limiteAviso: null, prazoB9: null,
      janelasPerdidas: 0, janelasAbertas: 0}, motivos: []};
  }
  const renovacao = (await somenteLeitura(db, SQL_RENOVACAO_INSTALADA)).rows[0]?.instalada === true;
  if (renovacao) {
    const v = await visibilidade(db, ['assinatura_renovacoes'], 'FUNDADOR');
    if (v.length) return {fundador: {ramo: 'INDETERMINADO (datas nao lidas: assinatura_renovacoes sem visibilidade completa; so o total foi lido)', confirmadas: total, consultasAsaas: 0}, motivos: v};
  }
  const datas = [];
  for (const l of (await somenteLeitura(db, sqlConcessoes(renovacao))).rows) {
    if (l.tem_contratacao !== true || Number(l.linhas_da_concessao) !== 1) { c.contratacaoAusenteOuMultipla++; continue; }
    if (l.atual !== true) c.contratacaoNaoAtual++;
    if (dataValida(l.registrada)) { c.registradas++; c.calculadas++; datas.push(l.registrada); continue; }
    c.semRegistroProvedorNaoConsultado++;
  }
  datas.sort();
  const menor = datas[0] ?? null;
  const r = {...c, ramo: 'COM_CONCESSAO_CONFIRMADA', hoje, menorPrimeiraDataRegular: menor,
    inicioJanelaAviso: menor && diasAntes(menor, AVISO_DIAS + ANTECIPADO_DIAS), limiteAviso: menor && diasAntes(menor, AVISO_DIAS),
    prazoB9: menor && diasAntes(menor, AVISO_DIAS + ANTECIPADO_DIAS + MARGEM_B9_DIAS),
    janelasPerdidas: datas.filter(d => hoje > diasAntes(d, AVISO_DIAS)).length,
    janelasAbertas: datas.filter(d => hoje >= diasAntes(d, AVISO_DIAS + ANTECIPADO_DIAS) && hoje <= diasAntes(d, AVISO_DIAS)).length};
  const motivos = [`FUNDADOR_CONFIRMADAS_RAMO_COM_DADOS ${total} (nucleo nao vazio; datas sem provedor)`];
  if (c.calculadas !== c.confirmadas) motivos.push(`FUNDADOR_COBERTURA_INCOMPLETA ${c.calculadas}/${c.confirmadas}`);
  if (r.prazoB9 && hoje > r.prazoB9) motivos.push('PRAZO_B9_VENCIDO');
  if (r.janelasPerdidas > 0) motivos.push('JANELAS_DE_AVISO_PERDIDAS ' + r.janelasPerdidas);
  return {fundador: r, motivos};
}
/** Registro do ramo do provedor declarado pelo operador; a conferência dele é separada (§9.2.2). */
function provedor(ramo) {
  return {ramoDeclarado: RAMOS_PROVEDOR[ramo], conferencia: 'SEPARADA (§9.2.2), registrada por ponto: '
    + (ramo === 'sem-conta' ? 'declaracao de Felipe de que a conta nao existe, com data e o que foi olhado'
      : 'conta, ambiente e escopo; assinaturas, cobrancas e checkouts em todas as situacoes; webhooks, fila e reentregas; por painel ou GET com autorizacao propria e chave FORA do web'),
  chaveAsaasLida: false, consultasAsaas: 0};
}

// ---------- execução ----------
function modo(argv) {
  if (argv.length === 0) return 'plano';
  if (argv.length === 1 && argv[0] === FLAG_COMPLETO) return 'completo';
  if (argv.length === 1 && argv[0] === FLAG_ESTADO) return 'estado';
  if (argv.length === 1 && argv[0] === FLAG_ESTADO_POS_E3) return 'estadoPosE3';
  assert.fail('ARGUMENTOS_RECUSADOS');
}
function plano() {
  return {resultado: 'PLANO', conecta: false, alvo: prod.ALVO, modos: {E1: FLAG_COMPLETO, E2c: FLAG_ESTADO, E5b: FLAG_ESTADO_POS_E3},
    migracoes: MIGRACOES.map(([m, n]) => ({migration: m, nucleo: n.replace('./', 'scripts/')})), excluidas: EXCLUIDAS,
    ampliadas: [...AMPLIADAS.map(([m, n]) => ({migration: m, nucleo: n.replace('./', 'scripts/')})), {migration: '118', nucleo: 'catalogo (SQL_ESTADO_118)'}],
    semMigration: SEM_MIGRATION, prefixoEsperadoAntesDoE3: {...ESPERADO_BASE_ANTES_DO_E3, ...ESPERADO_ANTES_DO_E3},
    prefixoEsperadoPosE3: {...ESPERADO_BASE_POS_E3, ...ESPERADO_POS_E3}, matriz: MATRIZ.map(([o, m, g, e]) => ({objeto: o, migracao: m, grupo: g, estrutura: e})),
    ambiente: {lidas: ENV_LIDAS, E1: 'KIDMAIS_B5_RAMO_PROVEDOR=sem-conta|com-conta obrigatoria; nenhuma ASAAS_* e lida'},
    leituras: ['banco: BEGIN TRANSACTION READ ONLY (lock_timeout 5s, statement_timeout 30s; documentos 60s)', 'matriz: uma fotografia REPEATABLE READ READ ONLY',
      'combinados (B-21): só catálogo, o mesmo SQL de lib/agenda/estado-combinados.ts', '109: contrato do cron (lib/assinatura/renovacao-schema.ts, conferido por sha256)',
      'provedor: nenhuma leitura (conferencia separada, §9.2.2)'],
    saida: 'estados, contagens e datas agregadas; nenhum id, documento, e-mail ou valor',
    paradas: ['estado parcial ou ilegível; 100 divergente', 'prefixo de 089-118 diferente do esperado antes do E3 (além da base, só 099 e 105; 114 só com o par de corpos comprovado)',
      'E5b (E2c-RECONFERIR, D-ESC-8 = (c)): prefixo diferente do esperado depois do E3 (089, 092 e 093 completas; o resto como antes do E3, 118 ausente)',
      'combinados (B-21, E1, E2c e E5b): qualquer estado diferente de AUSENTE (ANTIGA, PARCIAL, NOVA) ou ilegível', 'E2c e E5b: 091 ou 094 fora de "ausente"',
      'matriz: objeto obrigatório ausente, fora do escopo presente, linha em objeto VAZIA (lotes de crédito com a origem aberta), RLS que pode induzir zero, sem privilégio, exceção vigente de tipo revogável, continuidade não concluída, histórico de cadastro com linha (erro de consulta = FALHA 2; tipo, privilégio e RLS detectados = PARAR 3)',
      '105 completa sem a integridade de catálogo do aplicador (índice único parcial válido, gatilho na relação certa)', 'B-15: precheck estrutural da 091 falharia; CHECK da base divergente na sua relação (definição integral, PG 18) ou sem referência na versão do servidor; legado sem visibilidade; documento fora do formato dos CHECKs novos; origens ausentes, sem privilégio ou com RLS',
      'Fundador: relações sem visibilidade completa; qualquer concessão confirmada (ramo COM-DADOS), cobertura incompleta, prazo do B-9 vencido ou janela de aviso perdida',
      'B-15 com DV inválido no legado: informa DECISAO_D_OP_4_NECESSARIA (não para sozinho; adiar a 091 é tratamento válido)'],
    nuncaExecuta: ['escrita no banco', 'escrita no disco', 'leitura de ASAAS_* ou chamada ao Asaas', 'migration', 'down', 'leitura de dados da agenda (combinados: só catálogo)']};
}
async function conferir({modo: m, env, Client = require('pg').Client, agora = new Date(), carregar, contrato109}) {
  const opts = {...prod.alvo(env), application_name: 'kidmais-conferencia-b5-production'};
  const db = new Client(opts); db.on?.('error', () => undefined);
  const r = {modo: m};
  try {
    await db.connect();
    r.conexao = prod.identidade((await somenteLeitura(db, prod.SQL_IDENTIDADE)).rows[0]);
    const comb = await combinados(db);
    const e = await estados(db, carregar, env, {contrato109: contrato109 ?? (() => carregarContrato109()), combinados108: comb.combinados.estado,
      prefixo: PREFIXOS[m]});
    r.estados = e.estados; r.ampliados = e.ampliados; r.papelTrocado = e.papelTrocado; r.presentes = presentes(e.estados);
    r.prefixoEsperado = PREFIXOS[m].rotulo;
    r.combinados = comb.combinados;
    const mat = await matriz(db);
    r.matriz = mat.matriz;
    const motivos = [...e.motivos, ...comb.motivos, ...mat.motivos];
    if (m === 'estado' || m === 'estadoPosE3') {
      for (const k of ['091', '094']) if (r.estados[k] !== 'ausente') motivos.push(`E2C_${k}_PRESENTE ${r.estados[k]}`);
    } else {
      const b = await b15(db, r.estados['091'], mat.motivos.length > 0);
      r.b15 = b.b15; motivos.push(...b.motivos);
      if (r.b15.legado?.dvInvalidoTotal > 0) r.decisao = 'DECISAO_D_OP_4_NECESSARIA';
      const f = await fundador(db, agora);
      r.fundador = f.fundador; motivos.push(...f.motivos);
      r.provedor = provedor(env.KIDMAIS_B5_RAMO_PROVEDOR);
    }
    r.motivos = motivos;
    r.resultado = motivos.length ? 'PARAR' : 'CONFERIDO';
    return r;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    return {...r, resultado: 'FALHA', mensagem: curta(e)};
  } finally { await db.end().catch(() => {}); }
}
const CODIGO = Object.freeze({PLANO: 0, CONFERIDO: 0, FALHA: 2, PARAR: 3});
async function principal(argv, envBruto, deps = {}) {
  const m = modo(argv);
  if (m === 'plano') return {codigo: 0, saida: plano()};
  const env = envLido(envBruto);
  // E1: o ramo do provedor é declarado antes de conectar (registro; a conferência do provedor é separada).
  if (m === 'completo') assert.ok(Object.hasOwn(RAMOS_PROVEDOR, String(env.KIDMAIS_B5_RAMO_PROVEDOR)), 'RAMO_PROVEDOR_NAO_DECLARADO');
  const s = await conferir({modo: m, env, ...deps});
  return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
}
if (require.main === module) {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida, null, 1)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
module.exports = {CODIGOS_PUBLICOS, curta, FLAG_COMPLETO, FLAG_ESTADO, MIGRACOES, EXCLUIDAS, AMPLIADAS, SEM_MIGRATION, ESPERADO_ANTES_DO_E3, RAMOS_PROVEDOR, ENV_LIDAS,
  envLido, AVISO_DIAS, ANTECIPADO_DIAS, MARGEM_B9_DIAS, SQL_DOCUMENTOS, SQL_TOTAL_CONFIRMADAS, SQL_RENOVACAO_INSTALADA, sqlConcessoes, documentoValido091, formato091,
  dataValida, diasAntes, diaBrasil, somenteLeitura, carregarContrato109, lerNucleo, lerLista, SQL_ESTADO_118, lerEstado118, estados, presentes, inventarioDocumentos,
  CHECKS_091, TABELAS_091, SQL_COMPATIBILIDADE_091, SQL_ORIGENS_091, ORIGENS_091, inventarioOrigens, b15, MATRIZ, GRUPOS_VAZIOS, SQL_MATRIZ_CATALOGO, SQL_MATRIZ_PAPEL,
  sqlContagem, matriz, fundador, provedor, modo, plano, conferir, principal, CODIGO, CONFLITO_098, SQL_COMBINADOS, lerCombinados, classificarCombinados,
  MOTIVO_COMBINADOS, combinados, REVISAO_114, ESPERADO_BASE_ANTES_DO_E3, CORPOS_114_ANTES_DO_E3, CONTAGEM_EXTRA, estado114, CHECKS_BASE_091, SQL_CHECKS_091,
  checksPorRelacao, SQL_ORIGENS_CATALOGO, INTEGRIDADE_105, SQL_ESTRUTURA_105, INDICE_105_DEF, GATILHO_105_DEF, CORPO_105, NAO_NULAS_105, COLUNAS_105, SQL_RELACAO_105, RELACAO_105, sqlIntegridade105, integridade105, VERSAO_MAIOR_REFERENCIA_091, SQL_VERSAO_PG,
  LEGADO_091, TABELAS_FUNDADOR, visibilidade, FLAG_ESTADO_POS_E3, ESPERADO_BASE_POS_E3, ESPERADO_POS_E3, PREFIXOS};
