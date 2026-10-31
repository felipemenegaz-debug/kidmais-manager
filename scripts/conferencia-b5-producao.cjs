/* eslint-disable @typescript-eslint/no-require-imports */
// B-5 do plano de promoção (25/10/2026): conferência SOMENTE LEITURA agregada do banco de PRODUÇÃO, entregue ao Web Shell do
// srv-dak77m2d0e5s73b8rkkg por bloco autossuficiente (o artefato publicado no E1/E2c ainda é o antigo, sem estes arquivos).
//   - estado de 089–097, 099 e 100 pelas MESMAS funções de estado dos aplicadores (SQL_ESTADO + lerEstado de cada núcleo;
//     a 092–094 pelo núcleo do B-1, a 099 pelo do B-2, a 100 pelo do B-3). A 098 não tem núcleo (PAUSADA): o estado dela
//     sai da classificação dos combinados abaixo;
//   - B-21 (rodada 19 do plano): estado dos salões combinados pelo MESMO critério da candidata (lib/agenda/estado-combinados.ts:
//     mesmo SQL de catálogo, mesma classificação). Esperado AUSENTE; ANTIGA (098 histórica), PARCIAL, NOVA (108, fora desta
//     promoção — reconciliar o escopo) ou linha ilegível = PARAR, nos dois modos;
//   - B-15: documentos com DV inválido pela regra da função `kidmais_091_documento_valido` (CPF módulo 11; CNPJ
//     numérico/alfanumérico, ASCII − 48), em `empresa_assinaturas.documento_teste` e `assinatura_fundadores.documento_beneficiario`
//     (as duas tabelas do gatilho de INSERT da 091). Os documentos ficam só na memória do processo: a saída tem contagens;
//   - Fundador: para TODAS as concessões confirmadas, a `primeiraDataRegular` pela regra do código
//     (`primeiraRenovacaoRegular(primeiroVencimento, beneficioFim, ciclo)`, lib/assinatura/renovacao-fundador.ts). O primeiro
//     vencimento só existe no Asaas (dueDate da cobrança de confirmação; decisão de Felipe de 26/10/2026: ler o Asaas): um GET
//     por concessão, somente leitura, com a chave de produção já presente no Shell. Registro de renovação existente
//     (`assinatura_renovacoes`) prevalece, como no código. Saída: menor data, prazos e contagens — sem ids, documentos,
//     e-mails ou valores.
// Banco: cada consulta em BEGIN TRANSACTION READ ONLY com lock_timeout/statement_timeout; trava de alvo, TLS e identidade de
// produção do B-1 (scripts/migration-092-094-production.cjs). Nunca grava no banco, no disco ou no Asaas.
//   node scripts/conferencia-b5-producao.cjs                       → plano, sem conexão
//   node scripts/conferencia-b5-producao.cjs --conferir-b5         → E1: estados + combinados + B-15 + Fundador (lê o Asaas)
//   node scripts/conferencia-b5-producao.cjs --conferir-b5-estado  → E2c: identidade, estados e combinados (091/094 têm de estar ausentes)
// Códigos: 0 CONFERIDO; 1 recusa antes de conectar; 2 FALHA (conexão, identidade, consulta); 3 PARAR (motivos nomeados).
const assert = require('node:assert/strict');
const prod = require('./migration-092-094-production.cjs');
const ret108 = require('./migration-108-retrato.cjs');

const FLAG_COMPLETO = '--conferir-b5';
const FLAG_ESTADO = '--conferir-b5-estado';
/** [rótulo, núcleo, campos de estado]. Ordem da numeração; a 098 nunca entra. */
const MIGRACOES = Object.freeze([
  ['089', './migration-089-comum.cjs', ['m089']], ['090', './migration-090-comum.cjs', ['m090']], ['091', './migration-091-comum.cjs', ['m091']],
  ['092-094', './migration-092-094-comum.cjs', ['m092', 'm093', 'm094']], ['095', './migration-095-comum.cjs', ['m095']],
  ['096', './migration-096-comum.cjs', ['m096']], ['097', './migration-097-comum.cjs', ['m097']], ['099', './migration-099-comum.cjs', ['m099']],
  ['100', './migration-100-comum.cjs', ['m100']]]);
const EXCLUIDAS = Object.freeze({'098': 'SEM_NUCLEO_VER_COMBINADOS'});
const ASAAS = Object.freeze({url: 'https://api.asaas.com/v3', prefixo: '$aact_prod_', ambiente: 'producao', tempoMs: 10000});
const ID_PROVEDOR = /^[A-Za-z0-9_-]{1,100}$/;
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
  'ARGUMENTOS_RECUSADOS', 'ASAAS_AMBIENTE_RECUSADO', 'ASAAS_CHAVE_RECUSADA', 'FUNDADOR_TOTAL_ILEGIVEL', 'ORIGEM_INESPERADA']));
function curta(e) {
  const m = String(e?.message ?? '');
  if (CODIGOS_PUBLICOS.has(m)) return m;
  const codigo = String(e?.code ?? '');
  return 'ERRO_INESPERADO' + (/^[0-9A-Z]{5}$/.test(codigo) ? ' SQLSTATE ' + codigo : '');
}

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
/** Mesmas regras de dataValida / diasAntes / mesesDepois / primeiraRenovacaoRegular / diaBrasil (renovacao-fundador.ts). */
const dataValida = d => typeof d === 'string' && DATA.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
function diasAntes(data, dias) {
  if (!dataValida(data)) throw new Error('Data de renovação inválida.');
  return new Date(Date.parse(data) - dias * 86400000).toISOString().slice(0, 10);
}
function mesesDepois(data, meses) {
  const [ano, mes, dia] = data.split('-').map(Number);
  const alvo = new Date(Date.UTC(ano, mes - 1 + meses, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(dia, ultimo)); return alvo.toISOString().slice(0, 10);
}
function primeiraRenovacaoRegular(primeiroVencimento, beneficioFim, ciclo) {
  const fim = beneficioFim.slice(0, 10);
  if (!dataValida(primeiroVencimento) || !dataValida(fim)) throw new Error('Vigência inválida.');
  if (ciclo === 'ANUAL') return mesesDepois(primeiroVencimento, 12);
  for (let meses = 1; meses <= 120; meses++) {
    const candidata = mesesDepois(primeiroVencimento, meses);
    if (candidata >= fim) return candidata;
  }
  throw new Error('Vigência fora da faixa suportada.');
}
const diaBrasil = data => new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'}).format(data);

// ---------- banco (somente leitura) ----------
async function somenteLeitura(db, sql, params = [], tempo = '30s') {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query(`SET LOCAL statement_timeout = '${tempo}'`);
    const r = await db.query(sql, params);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}

/**
 * Estado de cada migration pelo núcleo do aplicador; "parcial", ilegível ou 100 "divergente" = parar.
 * `papel_trocado` (session_user <> current_user, que todos os núcleos devolvem; revisão do B-5, P2-1) é preservado:
 * leitura divergente entre núcleos ou ausente = parar; papel trocado só passa com previsão explícita do operador
 * (`KIDMAIS_B5_PAPEL_TROCADO_ESPERADO=sim` exportada antes de colar, conforme o CONFERIR anterior de produção).
 */
async function estados(db, carregar = m => require(m), env = {}) {
  const r = {}, motivos = [], papeis = new Set();
  for (const [rotulo, modulo, campos] of MIGRACOES) {
    const nucleo = carregar(modulo);
    let s;
    try { s = nucleo.lerEstado((await somenteLeitura(db, nucleo.SQL_ESTADO)).rows[0]); }
    catch (e) {
      if (!/ESTADO_ILEGIVEL|AssertionError/.test(String(e?.name) + String(e?.message))) throw e;
      for (const c of campos) r[c.slice(1)] = 'ILEGIVEL';
      motivos.push('ESTADO_ILEGIVEL ' + rotulo); papeis.add('ilegivel'); continue;
    }
    papeis.add(typeof s.papel_trocado === 'boolean' ? s.papel_trocado : 'ilegivel');
    for (const c of campos) {
      const v = s[c];
      r[c.slice(1)] = typeof v === 'string' ? v : 'ILEGIVEL';
      if (v === 'parcial') motivos.push('APLICACAO_PARCIAL ' + c.slice(1));
      if (typeof v !== 'string') motivos.push('ESTADO_ILEGIVEL ' + c.slice(1));
    }
  }
  if (r['100'] === 'divergente') motivos.push('CORPO_DIVERGENTE 100 (098 presente ou deriva)');
  const papelTrocado = papeis.size === 1 && typeof [...papeis][0] === 'boolean' ? [...papeis][0] : 'INCONSISTENTE';
  if (papelTrocado === 'INCONSISTENTE') motivos.push('PAPEL_TROCADO_ILEGIVEL_OU_INCONSISTENTE');
  else if (papelTrocado && env.KIDMAIS_B5_PAPEL_TROCADO_ESPERADO !== 'sim') motivos.push('PAPEL_TROCADO_INESPERADO');
  else if (!papelTrocado && env.KIDMAIS_B5_PAPEL_TROCADO_ESPERADO === 'sim') motivos.push('PAPEL_TROCADO_ESPERADO_MAS_AUSENTE');
  return {estados: {...r, ...EXCLUIDAS}, papelTrocado, motivos};
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
            to_regprocedure('public.kidmais108_instalada()') IS NOT NULL AS marcador`;
})();
/** Linha do catálogo → objeto do detector (CatalogoCombinados). Tipos conferidos: qualquer desvio = ilegível (PARAR). */
function lerCombinados(l) {
  for (const k of ['funcoes', 'funcoes_qualquer', 'gatilhos_ok', 'gatilhos_qualquer']) assert.ok(Number.isInteger(l?.[k]) && l[k] >= 0, 'COMBINADOS_ILEGIVEIS');
  for (const k of ['combinado', 'membros', 'check_ok', 'marcador']) assert.equal(typeof l[k], 'boolean', 'COMBINADOS_ILEGIVEIS');
  // typeof antes da regex: RegExp.test converte para texto, e array, Buffer ou String objeto passariam (P2 da revisão do B-21).
  for (const k of ['conflito', 'contrato', 'revisao']) assert.ok(l[k] === null || (typeof l[k] === 'string' && /^[0-9a-f]{64}$/.test(l[k])), 'COMBINADOS_ILEGIVEIS');
  return {funcoes: l.funcoes, funcoesQualquer: l.funcoes_qualquer, colunaCombinado: l.combinado, colunaMembros: l.membros, checkValidado: l.check_ok,
    gatilhosOk: l.gatilhos_ok, gatilhosQualquer: l.gatilhos_qualquer, conflito: l.conflito, contrato: l.contrato, revisao: l.revisao, marcador108: l.marcador};
}
/** Mesma regra de classificarCombinados (lib/agenda/estado-combinados.ts). */
function classificarCombinados(c) {
  const algum = c.funcoesQualquer > 0 || c.colunaCombinado || c.colunaMembros || c.gatilhosQualquer > 0 || c.marcador108;
  if (!algum) return 'AUSENTE';
  const nucleo = c.funcoes === TOTAL_FUNCOES_COMBINADOS && c.funcoesQualquer === TOTAL_FUNCOES_COMBINADOS && c.colunaCombinado && c.colunaMembros
    && c.checkValidado && c.gatilhosOk === ret108.NOVA.gatilhos.length && c.gatilhosQualquer === ret108.NOVA.gatilhos.length
    && c.contrato === ret108.NOVA.hashes.contrato && c.revisao === ret108.NOVA.hashes.revisao;
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

const SQL_DOCUMENTOS = `SELECT 'empresa_assinaturas' AS origem, a.documento_teste AS doc,
    EXISTS (SELECT 1 FROM assinatura_fundadores f WHERE f.empresa_id = a.empresa_id) AS tem_concessao
  FROM empresa_assinaturas a
  UNION ALL
  SELECT 'assinatura_fundadores', f.documento_beneficiario, true FROM assinatura_fundadores f`;
/** B-15: só contagens. Documento nulo não é recusado pelo gatilho (doc IS NOT NULL). */
function inventarioDocumentos(linhas) {
  const base = () => ({total: 0, nulos: 0, cpf11: 0, cnpj14: 0, outroFormato: 0, dvInvalido: 0});
  const r = {empresa_assinaturas: base(), assinatura_fundadores: base(), empresasSemConcessaoComDvInvalido: 0};
  for (const l of linhas) {
    const t = r[l.origem]; assert.ok(t, 'ORIGEM_INESPERADA');
    t.total++;
    if (l.doc === null || l.doc === undefined) { t.nulos++; continue; }
    const d = String(l.doc);
    if (/^[0-9]{11}$/.test(d)) t.cpf11++; else if (/^[0-9A-Z]{12}[0-9]{2}$/.test(d)) t.cnpj14++; else t.outroFormato++;
    if (!documentoValido091(d)) { t.dvInvalido++; if (l.origem === 'empresa_assinaturas' && l.tem_concessao === false) r.empresasSemConcessaoComDvInvalido++; }
  }
  r.dvInvalidoTotal = r.empresa_assinaturas.dvInvalido + r.assinatura_fundadores.dvInvalido;
  return r;
}

const SQL_RENOVACAO_INSTALADA = "SELECT to_regclass('public.assinatura_renovacoes') IS NOT NULL AS instalada";
const sqlConcessoes = renovacao => `SELECT f.pagamento_confirmacao_id AS pagamento,
    to_char(f.beneficio_fim AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS fim,
    c.ciclo, (c.id IS NOT NULL) AS tem_contratacao, (c.id = a.contratacao_atual_id) AS atual,
    a.provedor_assinatura_id AS assinatura, a.provedor_cliente_id AS cliente, c.valor_final_centavos AS valor,
    ${renovacao ? '(SELECT r.primeira_data_regular::text FROM assinatura_renovacoes r WHERE r.contratacao_id = c.id)' : 'NULL::text'} AS registrada,
    count(*) OVER (PARTITION BY f.id) AS linhas_da_concessao
  FROM assinatura_fundadores f
  LEFT JOIN assinatura_contratacoes c ON c.empresa_id = f.empresa_id AND c.fundador_id = f.id AND c.estado = 'CONFIRMADA'
  LEFT JOIN empresa_assinaturas a ON a.empresa_id = f.empresa_id
  WHERE f.estado = 'CONFIRMADA'`;
const SQL_TOTAL_CONFIRMADAS = "SELECT count(*)::int AS n FROM assinatura_fundadores WHERE estado = 'CONFIRMADA'";

/** GET da cobrança de confirmação (somente leitura). Devolve o objeto da cobrança ou lança com código nomeado, sem chave nem id. */
function criarLeitorAsaas(env, executar = (url, init) => fetch(url, init), tempoMs = ASAAS.tempoMs) {
  assert.ok(env.ASAAS_AMBIENTE === ASAAS.ambiente, 'ASAAS_AMBIENTE_RECUSADO');
  const chave = String(env.ASAAS_API_KEY ?? '').trim();
  assert.ok(chave.startsWith(ASAAS.prefixo), 'ASAAS_CHAVE_RECUSADA');
  return async function cobranca(id) {
    assert.match(String(id), ID_PROVEDOR, 'ID_COBRANCA_INVALIDO');
    // O prazo vale para a chamada INTEIRA, inclusive a leitura do corpo (revisão do B-5, P2-2): cabeçalhos imediatos com
    // corpo pendurado também esgotam o tempo com o erro nomeado.
    const controle = new AbortController();
    const expirou = new Promise((_, rejeitar) => controle.signal.addEventListener('abort', () => rejeitar(new Error('ASAAS_TEMPO_ESGOTADO')), {once: true}));
    expirou.catch(() => undefined);
    const timer = setTimeout(() => controle.abort(), tempoMs);
    try {
      let res;
      try {
        res = await Promise.race([executar(`${ASAAS.url}/payments/${encodeURIComponent(id)}`, {method: 'GET', redirect: 'error', cache: 'no-store', signal: controle.signal,
          headers: {access_token: chave, Accept: 'application/json', 'User-Agent': 'kidmais-manager-b5'}}), expirou]);
      } catch { throw new Error(controle.signal.aborted ? 'ASAAS_TEMPO_ESGOTADO' : 'ASAAS_REDE'); }
      if (!res.ok) { Promise.resolve(res.body?.cancel?.()).catch(() => undefined); throw new Error('ASAAS_HTTP_' + res.status); }
      let o;
      try { o = await Promise.race([res.json(), expirou]); } catch { throw new Error(controle.signal.aborted ? 'ASAAS_TEMPO_ESGOTADO' : 'ASAAS_RESPOSTA_INVALIDA'); }
      assert.ok(o && typeof o === 'object' && !Array.isArray(o), 'ASAAS_RESPOSTA_INVALIDA');
      return o;
    } finally { clearTimeout(timer); }
  };
}

/**
 * Fundador: cobertura de TODAS as confirmadas e menor primeiraDataRegular. Identidade da cobrança como o código
 * (`identidadePagamento`: assinatura e cliente do provedor iguais aos da empresa, dueDate válido); sem isso a concessão não
 * conta como calculada.
 */
async function fundador(db, lerCobranca, agora = new Date()) {
  const total = (await somenteLeitura(db, SQL_TOTAL_CONFIRMADAS)).rows[0]?.n;
  assert.ok(Number.isInteger(total) && total >= 0, 'FUNDADOR_TOTAL_ILEGIVEL');
  const renovacao = (await somenteLeitura(db, SQL_RENOVACAO_INSTALADA)).rows[0]?.instalada === true;
  const linhas = (await somenteLeitura(db, sqlConcessoes(renovacao))).rows;
  const c = {confirmadas: total, calculadas: 0, semDatas: 0, contratacaoAusenteOuMultipla: 0, contratacaoNaoAtual: 0,
    cobrancaIlegivel: 0, cobrancaDivergente: 0, cobrancaNaoConfirmada: 0, registradas: 0};
  const datas = [];
  for (const l of linhas) {
    if (l.tem_contratacao !== true || Number(l.linhas_da_concessao) !== 1) { c.contratacaoAusenteOuMultipla++; continue; }
    if (l.atual !== true) c.contratacaoNaoAtual++;
    // Registro de renovação existente é a data do código (ele só consulta a cobrança quando não há registro): resolvido
    // ANTES do Asaas, que nem é chamado (revisão do B-5, P2-3).
    if (dataValida(l.registrada)) { c.registradas++; c.calculadas++; datas.push(l.registrada); continue; }
    if (!l.pagamento || !dataValida(l.fim) || !['MENSAL', 'ANUAL'].includes(l.ciclo)) { c.semDatas++; continue; }
    let p;
    try { p = await lerCobranca(l.pagamento); } catch { c.cobrancaIlegivel++; continue; }
    // Contrato do adaptador (asaas.ts: texto(o.dueDate, 10) + DATA): a string inteira, sem truncar (P2-4).
    const due = typeof p.dueDate === 'string' && p.dueDate.length === 10 ? p.dueDate : null;
    if (!dataValida(due) || p.id !== l.pagamento || p.subscription !== l.assinatura || p.customer !== l.cliente) { c.cobrancaDivergente++; continue; }
    if (p.deleted === true || !['RECEIVED', 'CONFIRMED'].includes(p.status)) c.cobrancaNaoConfirmada++;
    let data;
    try { data = primeiraRenovacaoRegular(due, l.fim, l.ciclo); } catch { c.semDatas++; continue; }
    c.calculadas++; datas.push(data);
  }
  const hoje = diaBrasil(agora);
  datas.sort();
  const menor = datas[0] ?? null;
  const r = {...c, hoje, menorPrimeiraDataRegular: menor,
    inicioJanelaAviso: menor && diasAntes(menor, AVISO_DIAS + ANTECIPADO_DIAS), limiteAviso: menor && diasAntes(menor, AVISO_DIAS),
    prazoB9: menor && diasAntes(menor, AVISO_DIAS + ANTECIPADO_DIAS + MARGEM_B9_DIAS),
    janelasPerdidas: datas.filter(d => hoje > diasAntes(d, AVISO_DIAS)).length,
    janelasAbertas: datas.filter(d => hoje >= diasAntes(d, AVISO_DIAS + ANTECIPADO_DIAS) && hoje <= diasAntes(d, AVISO_DIAS)).length};
  const motivos = [];
  if (c.calculadas !== c.confirmadas) motivos.push(`FUNDADOR_COBERTURA_INCOMPLETA ${c.calculadas}/${c.confirmadas}`);
  if (c.semDatas > 0) motivos.push('FUNDADOR_DATAS_AUSENTES ' + c.semDatas);
  if (r.prazoB9 && hoje > r.prazoB9) motivos.push('PRAZO_B9_VENCIDO');
  if (r.janelasPerdidas > 0) motivos.push('JANELAS_DE_AVISO_PERDIDAS ' + r.janelasPerdidas);
  return {fundador: r, motivos};
}

// ---------- execução ----------
function modo(argv) {
  if (argv.length === 0) return 'plano';
  if (argv.length === 1 && argv[0] === FLAG_COMPLETO) return 'completo';
  if (argv.length === 1 && argv[0] === FLAG_ESTADO) return 'estado';
  assert.fail('ARGUMENTOS_RECUSADOS');
}
function plano() {
  return {resultado: 'PLANO', conecta: false, alvo: prod.ALVO, modos: {E1: FLAG_COMPLETO, E2c: FLAG_ESTADO},
    migracoes: MIGRACOES.map(([m, n]) => ({migration: m, nucleo: n.replace('./', 'scripts/')})), excluidas: EXCLUIDAS,
    leituras: ['banco: só BEGIN TRANSACTION READ ONLY (lock_timeout 5s, statement_timeout 30s)', 'combinados (B-21): só catálogo, o mesmo SQL de lib/agenda/estado-combinados.ts', 'Asaas (só --conferir-b5): GET /v3/payments/{id} da cobrança de confirmação de cada concessão Fundador confirmada'],
    saida: 'estados, contagens e datas agregadas; nenhum id, documento, e-mail ou valor',
    paradas: ['estado parcial ou ilegível; 100 divergente', 'combinados (B-21, E1 e E2c): qualquer estado diferente de AUSENTE (ANTIGA, PARCIAL, NOVA) ou ilegível', 'E2c: 091 ou 094 fora de "ausente"', 'Fundador: cobertura incompleta, datas ausentes, prazo do B-9 vencido ou janela de aviso perdida',
      'B-15 com DV inválido: informa DECISAO_D_OP_4_NECESSARIA (não para sozinho; adiar a 091 é tratamento válido)'],
    nuncaExecuta: ['escrita no banco', 'escrita no disco', 'escrita no Asaas', 'migration', 'down', 'leitura de dados da agenda (combinados: só catálogo)']};
}
async function conferir({modo: m, env, Client = require('pg').Client, lerCobranca, agora = new Date(), carregar}) {
  const opts = {...prod.alvo(env), application_name: 'kidmais-conferencia-b5-production'};
  const leitor = m === 'completo' ? (lerCobranca ?? criarLeitorAsaas(env)) : null;
  const db = new Client(opts); db.on?.('error', () => undefined);
  const r = {modo: m};
  try {
    await db.connect();
    r.conexao = prod.identidade((await somenteLeitura(db, prod.SQL_IDENTIDADE)).rows[0]);
    const e = await estados(db, carregar, env);
    r.estados = e.estados; r.papelTrocado = e.papelTrocado; r.presentes = presentes(e.estados);
    const comb = await combinados(db);
    r.combinados = comb.combinados;
    const motivos = [...e.motivos, ...comb.motivos];
    if (m === 'estado') {
      for (const k of ['091', '094']) if (r.estados[k] !== 'ausente') motivos.push(`E2C_${k}_PRESENTE ${r.estados[k]}`);
    } else {
      r.b15 = inventarioDocumentos((await somenteLeitura(db, SQL_DOCUMENTOS, [], '60s')).rows);
      if (r.b15.dvInvalidoTotal > 0) r.decisao = 'DECISAO_D_OP_4_NECESSARIA';
      const f = await fundador(db, leitor, agora);
      r.fundador = f.fundador; motivos.push(...f.motivos);
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
async function principal(argv, env, deps = {}) {
  const m = modo(argv);
  if (m === 'plano') return {codigo: 0, saida: plano()};
  const s = await conferir({modo: m, env, ...deps});
  return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
}
if (require.main === module) {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida, null, 1)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
module.exports = {CODIGOS_PUBLICOS, curta, FLAG_COMPLETO, FLAG_ESTADO, MIGRACOES, EXCLUIDAS, ASAAS, AVISO_DIAS, ANTECIPADO_DIAS, MARGEM_B9_DIAS, SQL_DOCUMENTOS, SQL_TOTAL_CONFIRMADAS,
  SQL_RENOVACAO_INSTALADA, sqlConcessoes, documentoValido091, dataValida, diasAntes, primeiraRenovacaoRegular, diaBrasil, somenteLeitura, estados, presentes,
  inventarioDocumentos, criarLeitorAsaas, fundador, modo, plano, conferir, principal, CODIGO, CONFLITO_098, SQL_COMBINADOS, lerCombinados, classificarCombinados,
  MOTIVO_COMBINADOS, combinados};
