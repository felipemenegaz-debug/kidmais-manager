/* eslint-disable @typescript-eslint/no-require-imports */
// B-5 (ampliado pela §9.2.7 do plano, rodada 34): conferência somente leitura agregada de produção com cliente simulado. Prova:
// alvo/identidade de produção, toda consulta em READ ONLY (a matriz numa fotografia REPEATABLE READ READ ONLY), estados pelos
// núcleos dos aplicadores (089–100 e 102–117; a 098 não tem núcleo; a 118 por catálogo), prefixo esperado antes do E3,
// combinados (B-21) pelo mesmo SQL e regra de lib/agenda/estado-combinados.ts (só AUSENTE passa), matriz da §9.2.2 por
// contagens, B-15 reescopado (legado, compatibilidade estrutural da 091 e origens futuras), DV igual ao do código e à regra
// da 091, Fundador SEM provedor (nenhuma ASAAS_* lida, nenhum fetch), ramo do provedor declarado, paradas nomeadas.
// Sem rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const b5 = require('./conferencia-b5-producao.cjs');
const prod = require('./migration-092-094-production.cjs');
const ret108 = require('./migration-108-retrato.cjs');
const n114 = require('./migration-114-comum.cjs');
const {cpfValido} = require('../lib/acessos/validacao.ts');
const {cnpjFormatoDvOficial} = require('../lib/cadastro/cnpj.ts');
const renovacao = require('../lib/assinatura/renovacao-fundador.ts');

const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD, KIDMAIS_B5_RAMO_PROVEDOR: 'com-conta'});
const ID = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const AGORA = new Date('2026-11-10T15:00:00Z');

/** Estado padrão de cada núcleo = o prefixo esperado antes do E3 (base: tudo ausente, 100 sem_094, 099 completa; 105 completa). */
const PADRAO = Object.freeze({m089: 'ausente', m090: 'ausente', m091: 'ausente', m092: 'ausente', m093: 'ausente', m094: 'ausente', m095: 'ausente',
  m096: 'ausente', m097: 'ausente', m099: 'completa', m100: 'sem_094', m102: 'ausente', m103: 'ausente', m104: 'ausente', m105: 'completa', m106: 'ausente',
  m107: 'ausente', m108: 'AUSENTE', m109: 'ausente', m112: 'ausente', m114: 'ausente', m116: 'ausente', m117: 'ausente', papel_trocado: false,
  d103: true, ler_103: true});
const TODOS = [...b5.MIGRACOES, ...b5.AMPLIADAS];
/** Núcleos simulados: estado escolhido por migration; a 109 recebe a capacidade; a 114 recebe a linha (estado114). */
function nucleos(estados = {}) {
  const padrao = {...PADRAO, ...estados};
  const carregados = [];
  const carregar = modulo => {
    carregados.push(modulo);
    const rotulo = TODOS.find(m => m[1] === modulo)[0];
    return {SQL_ESTADO: 'ESTADO ' + rotulo, SQL_CATEGORIA_103: 'CATEGORIA 103', CORPOS: n114.CORPOS,
      lerCategoria: l => estados.m103 ?? l.m103, lerEstado: (e, cap) => {
        assert.equal(e.rotulo, rotulo); if (padrao['ilegivel' + rotulo]) assert.fail('ESTADO_ILEGIVEL x');
        if (rotulo === '109') assert.equal(cap?.capacidade, '075', 'a 109 recebe a capacidade do contrato');
        const papel = padrao.papelPor && rotulo in padrao.papelPor ? padrao.papelPor[rotulo] : padrao.papel_trocado;
        return {...padrao, papel_trocado: papel, d103: padrao.d103, ler_103: padrao.ler_103, m103: 'nao_lida'};
      }};
  };
  return {carregar, carregados};
}
/** Linha do catálogo dos combinados por estado (formato de lerCatalogoCombinados). */
const NF = Object.keys(ret108.NOVA.funcoes).length, NG = ret108.NOVA.gatilhos.length;
const LINHA_AUSENTE = Object.freeze({funcoes: 0, funcoes_qualquer: 0, combinado: false, membros: false, check_ok: false, gatilhos_ok: 0, gatilhos_qualquer: 0,
  conflito: null, contrato: null, revisao: null, marcador: false, marcador114: false});
const NUCLEO = {funcoes: NF, funcoes_qualquer: NF, combinado: true, membros: true, check_ok: true, gatilhos_ok: NG, gatilhos_qualquer: NG,
  contrato: ret108.NOVA.hashes.contrato, revisao: ret108.NOVA.hashes.revisao};
const LINHAS = Object.freeze({AUSENTE: LINHA_AUSENTE, ANTIGA: {...LINHA_AUSENTE, ...NUCLEO, conflito: b5.CONFLITO_098},
  NOVA: {...LINHA_AUSENTE, ...NUCLEO, conflito: ret108.NOVA.hashes.conflito108, marcador: true}, PARCIAL: {...LINHA_AUSENTE, combinado: true}});
/** Concessão Fundador simulada (linha da consulta, sem provedor). */
const concessao = (extra = {}) => ({tem_contratacao: true, atual: true, registrada: '2027-03-20', linhas_da_concessao: '1', ...extra});
/** Catálogo da matriz: obrigatórias presentes, as demais ausentes; ajustes por objeto. */
const catalogoMatriz = (aj = {}) => b5.MATRIZ.map(([nome, , , estrutura]) => ({nome, presente: estrutura === 'OBRIGATORIA', tipo: estrutura === 'OBRIGATORIA' ? 'r' : '',
  rls: false, rls_forcada: false, ler: estrutura === 'OBRIGATORIA', ...(aj[nome] ?? {})}));
const LINHA_118 = Object.freeze({tabelas: 0, funcoes: 0, gatilhos: 0});
/** 110/111/115 por objeto: todos num estado, com trocas pontuais. */
const satisfacao = (estado, trocas = {}) => ({objetos: {...Object.fromEntries(require('./conferencia-b5-producao.cjs').IDS_SATISFACAO.map(([id]) => [id, estado])), ...trocas}});
/** Base de production: nada da 110/111/115 (CHECKs e função da 086 com a definição da 086; 054 com a forma da 054). */
const LINHA_SATISFACAO = Object.freeze(satisfacao('ausente'));
const SATISFACAO_PRESENTE = Object.freeze(satisfacao('conforme'));
const COMPAT = Object.freeze({tabelas: 6, checks: 5, objetos_091: false, plataforma: true});
/** CHECKs da base como pg_get_constraintdef os devolve (formato conferido no PostgreSQL 18 descartável). */
const DEF = Object.freeze(Object.fromEntries(b5.CHECKS_BASE_091.map(([nome, , , definicao]) => [nome, definicao])));
const checksBase = (aj = {}) => b5.CHECKS_BASE_091.map(([nome, tabela, coluna]) => ({nome, esquema: 'public', tabela, validado: true, definicao: DEF[nome], colunas: [coluna],
  ...(aj[nome] ?? {})}));
/** Visibilidade das origens do B-15: presentes, legíveis, sem RLS. */
const origensCatalogo = (aj = {}) => b5.ORIGENS_091.map(nome => ({nome, presente: true, tipo: 'r', rls: false, ler: true, ignora_rls: false, ...(aj[nome] ?? {})}));
/** Estrutura positiva da 105 (índice e gatilho pela definição): a de uma 105 íntegra. */
const ESTRUTURA_105 = Object.freeze({indice_def: b5.INDICE_105_DEF, indice_flags: true, gatilhos: 1, gatilho_def: b5.GATILHO_105_DEF, gatilho_funcao: true,
  nao_nulas: b5.NAO_NULAS_105, nao_nulas_declaradas: b5.NAO_NULAS_105, gatilhos_relacao: 1, regras: 0, colunas: b5.COLUNAS_105});
/** Par de corpos de production antes do E3 (019 + 062): o que a sonda PG lê na base 088 + 099 + 105. */
const SQL_INT105 = b5.sqlIntegridade105();
const PAR_114 = Object.freeze({hash_lock: b5.CORPOS_114_ANTES_DO_E3.lock, hash_revisao: b5.CORPOS_114_ANTES_DO_E3.revisao});

function clienteFalso({identidade = ID, docs = [], origens = [], concessoes = [], total, instalada = true, falharEm, combinados = [LINHA_AUSENTE],
  linha114 = {}, linha118 = LINHA_118, linhaSatisfacao = LINHA_SATISFACAO, categoria103 = {m103: 'ausente'}, catalogo = catalogoMatriz(), papel = {superusuario: false, ignora_rls: false},
  contagens = {}, compat = COMPAT, checks091 = checksBase(), origensCat = origensCatalogo(), visib = {}, integra105 = true, estrutura105 = {}, relacao105 = b5.RELACAO_105, versaoPg = 180006} = {}) {
  const log = []; let ro = false, iso = null;
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql, params) {
      if (/^BEGIN .*READ ONLY$/.test(sql)) { ro = true; iso = sql; }
      log.push({sql, ro, iso, params});
      if (sql === 'ROLLBACK') { ro = false; iso = null; return {rows: []}; }
      if (/^BEGIN/.test(sql) || sql.startsWith('SET LOCAL')) return {rows: []};
      if (falharEm && sql.includes(falharEm)) throw Object.assign(new Error('falha simulada ' + URL_PROD), {code: '57014'});
      if (sql === prod.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === 'ESTADO 114') return {rows: [{rotulo: '114', f114: false, hash_exigir: null, ...PAR_114, ...linha114}]};
      if (sql.startsWith('ESTADO ')) return {rows: [{rotulo: sql.slice(7)}]};
      if (sql === 'CATEGORIA 103') return {rows: [categoria103]};
      if (sql === b5.SQL_ESTADO_118) return {rows: [linha118]};
      if (sql === b5.SQL_ESTADO_SATISFACAO) return {rows: [linhaSatisfacao]};
      if (sql === b5.SQL_COMBINADOS) return {rows: combinados};
      if (sql === b5.SQL_MATRIZ_CATALOGO) { assert.deepEqual(params, [b5.MATRIZ.map(m => m[0])]); return {rows: catalogo}; }
      if (sql === b5.SQL_MATRIZ_PAPEL) return {rows: [papel]};
      const cont = /^SELECT count\(\*\)::text AS linhas.* FROM public\.([a-z_]+)$/.exec(sql);
      if (cont) return {rows: [{linhas: '0', ...extrasZero(cont[1]), ...(contagens[cont[1]] ?? {})}]};
      if (sql === b5.SQL_DOCUMENTOS) return {rows: docs};
      if (sql === b5.SQL_COMPATIBILIDADE_091) return {rows: [compat]};
      if (sql === b5.SQL_ORIGENS_091) return {rows: origens};
      if (sql === b5.SQL_CHECKS_091) { assert.deepEqual(params, [b5.CHECKS_091]); return {rows: checks091}; }
      if (sql === b5.SQL_ORIGENS_CATALOGO) {
        if (JSON.stringify(params) === JSON.stringify([b5.ORIGENS_091])) return {rows: origensCat};
        return {rows: params[0].map(nome => ({nome, presente: true, tipo: 'r', rls: false, ler: true, ignora_rls: false, ...(visib[nome] ?? {})}))};
      }
      if (sql === SQL_INT105) return {rows: [{integra_105: integra105}]};
      if (sql === b5.SQL_ESTRUTURA_105) return {rows: [{...ESTRUTURA_105, ...estrutura105}]};
      if (sql === b5.SQL_RELACAO_105) return {rows: [{relacao: relacao105}]};
      if (sql === b5.SQL_VERSAO_PG) return {rows: [{versao_pg: versaoPg}]};
      if (sql === b5.SQL_TOTAL_CONFIRMADAS) return {rows: [{n: total === undefined ? concessoes.length : total}]};
      if (sql === b5.SQL_RENOVACAO_INSTALADA) return {rows: [{instalada}]};
      if (sql === b5.sqlConcessoes(instalada)) return {rows: concessoes};
      throw new Error('SQL_INESPERADO ' + sql.slice(0, 40));
    }
  };
  C.log = log;
  return C;
}
const extrasZero = t => ({empresa_excecoes_comerciais: {vigentes_revogaveis: '0'}, empresa_documento_continuidades: {nao_concluidas: '0'},
  cadastros_publicos: {pendentes: '0', confirmados: '0', substituidos: '0', pendentes_nao_expirados: '0'},
  ia_credito_lotes: {origem_compra: '0', origem_franquia: '0', origem_cortesia: '0', origem_legado: '0', com_pedido: '0'}})[t] ?? {};
const foraDeLeitura = log => log.filter(x => !x.ro && !/^(BEGIN .*READ ONLY|ROLLBACK)$/.test(x.sql));
const contrato109 = () => ({capacidadeRenovacao: async () => ({capacidade: '075'})});
const rodar = (argv, {cliente = clienteFalso(), estados, env = ENV, contrato = contrato109} = {}) => {
  const n = nucleos(estados);
  return b5.principal(argv, env, {Client: cliente, carregar: n.carregar, agora: AGORA, contrato109: async () => contrato()})
    .then(r => ({...r, carregados: n.carregados, log: cliente.log}));
};

test('DV: mesma regra do código (cpfValido, cnpjFormatoDvOficial) e da função da 091, inclusive CNPJ alfanumérico e sequências', () => {
  for (const [doc, ok] of [['52998224725', true], ['52998224724', false], ['11111111111', false], ['00000000000', false], ['11222333000181', true],
    ['11222333000180', false], ['12ABC34501DE35', true], ['12ABC34501DE36', false], ['12abc34501de35', false], ['1122233300018', false], ['', false], ['ABCDEFGHIJKL00', false]]) {
    assert.equal(b5.documentoValido091(doc), ok, doc);
  }
  let x = 12345;
  const rnd = n => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
  const ALFA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < 2000; i++) {
    let cpf = Array.from({length: 9}, () => rnd(10)).join('');
    const d = (b, p) => { let s = 0; for (let k = 0; k < b.length; k++) s += Number(b[k]) * (p - k); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    cpf += d(cpf, 10); cpf += d(cpf, 11); if (rnd(2)) cpf = cpf.slice(0, 10) + ((Number(cpf[10]) + 1 + rnd(9)) % 10);
    assert.equal(b5.documentoValido091(cpf), cpfValido(cpf), cpf);
    const base = Array.from({length: 12}, () => ALFA[rnd(rnd(3) ? 10 : 36)]).join('');
    for (const dv of [`${rnd(10)}${rnd(10)}`, '00']) assert.equal(b5.documentoValido091(base + dv), cnpjFormatoDvOficial(base + dv), base + dv);
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database/migrations/20261022_091_documento_fiscal_contratante.sql'), 'utf8');
  for (const trecho of ["doc ~ '^[0-9]{11}$'", "doc ~ '^(.)\\1{10}$'", "doc ~ '^[0-9A-Z]{12}[0-9]{2}$'", '(11 - i)', '(12 - i)', 'CASE WHEN soma % 11 <= 1 THEN 0 ELSE 11 - soma % 11 END'])
    assert.ok(sql.includes(trecho), trecho);
  // Formato dos CHECKs novos da 091 (o mesmo texto nos 4 CHECKs de documento) e precheck estrutural espelhado.
  for (const c of ['empresa_assinaturas_documento_teste_check', 'assinatura_fundadores_documento_beneficiario_check', 'cadastros_empresas_documento_check', 'solicitacoes_documento_check'])
    assert.ok(new RegExp(c + " CHECK \\(\\w+ ~ '\\^\\(\\[0-9\\]\\{11\\}\\|\\[0-9A-Z\\]\\{12\\}\\[0-9\\]\\{2\\}\\)\\$'\\)").test(sql), c);
  for (const [d, ok] of [['52998224725', true], ['12ABC34501DE35', true], ['5299822472', false], ['12abc34501de35', false], ['12ABC34501DEAB', false]]) assert.equal(b5.formato091(d), ok, d);
  for (const t of b5.TABELAS_091) assert.ok(sql.includes(`to_regclass('public.${t}') IS NULL`), t);
  for (const c of b5.CHECKS_091) assert.ok(sql.includes(`'${c}'`), c);
  assert.match(sql, /\) <> 5 THEN/);
});

test('datas: mesma regra do código (diasAntes, dataValida, diaBrasil, constantes de aviso)', () => {
  for (const [d, n] of [['2027-03-20', 30], ['2027-03-20', 33], ['2027-03-01', 44], ['2027-03-01', 47]]) assert.equal(b5.diasAntes(d, n), renovacao.diasAntes(d, n));
  for (const d of ['2027-02-30', '2027-13-01', '27-01-01', null, '2027-01-01T00:00']) assert.equal(b5.dataValida(d), renovacao.dataValida(d), String(d));
  assert.equal(b5.diaBrasil(new Date('2026-11-10T02:00:00Z')), renovacao.diaBrasil(new Date('2026-11-10T02:00:00Z')));
  assert.equal(b5.AVISO_DIAS, renovacao.AVISO_FUNDADOR_DIAS); assert.equal(b5.ANTECIPADO_DIAS, renovacao.AVISO_ANTECIPADO_DIAS);
  assert.equal(b5.diasAntes('2027-01-05', 33), renovacao.inicioJanelaAviso('2027-01-05'));
});

test('alvo e identidade de produção do B-1; nome de aplicação próprio; fora do Render recusa antes de conectar (código 1)', async () => {
  await assert.rejects(b5.principal(['--conferir-b5'], {...ENV, RENDER: undefined}, {Client: clienteFalso()}), /FORA_DO_RENDER/);
  await assert.rejects(b5.principal(['--conferir-b5'], {...ENV, RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
  await assert.rejects(b5.principal(['--conferir-b5'], {...ENV, DATABASE_SSL: 'false'}, {Client: clienteFalso()}), /TLS_OBRIGATORIO/);
  for (const argv of [['--aplicar'], ['--conferir-b5', '--x'], ['--conferir-098'], ['--conferir-b5-fundador-asaas']]) await assert.rejects(b5.principal(argv, ENV, {}), /ARGUMENTOS_RECUSADOS/);
  let opts;
  const C = class extends clienteFalso() { constructor(o) { super(); opts = o; } };
  await rodar(['--conferir-b5-estado'], {cliente: C});
  assert.equal(opts.application_name, 'kidmais-conferencia-b5-production'); assert.deepEqual(opts.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  const outro = await rodar(['--conferir-b5'], {cliente: clienteFalso({identidade: {...ID, db: 'kidmais_staging_1z91'}})});
  assert.equal(outro.codigo, 2); assert.equal(outro.saida.resultado, 'FALHA'); assert.match(outro.saida.mensagem, /BANCO_DIVERGENTE/);
  assert.equal(outro.carregados.length, 0, 'identidade recusada: nenhum estado lido');
});

test('E1 completo: todas as consultas em READ ONLY; núcleos 089–100 e 102–117 na ordem, 098 nunca; prefixo esperado confere; saída sem segredo', async () => {
  const docs = [{origem: 'empresa_assinaturas', doc: '11222333000181', tem_concessao: false}];
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({docs, origens: [{origem: 'cadastros_empresas', doc: '52998224725'}]})});
  // o legado com linha não para sozinho; a matriz (empresa_assinaturas VAZIA) para — aqui a contagem simulada é 0.
  assert.equal(r.codigo, 0, JSON.stringify(r.saida)); assert.equal(r.saida.resultado, 'CONFERIDO');
  assert.deepEqual(foraDeLeitura(r.log), [], 'nenhuma consulta fora de BEGIN ... READ ONLY');
  assert.ok(r.log.filter(x => x.sql.startsWith('SET LOCAL lock_timeout')).length >= 20);
  assert.deepEqual(r.carregados, TODOS.map(m => m[1])); assert.ok(!r.carregados.some(m => m.includes('098')));
  assert.deepEqual(Object.keys(r.saida.estados).sort(), ['089', '090', '091', '092', '093', '094', '095', '096', '097', '098', '099', '100']);
  assert.deepEqual(Object.keys(r.saida.ampliados).sort(), ['102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112', '113', '114', '115', '116', '117', '118',
    'nucleo108'].sort());
  assert.equal(r.saida.ampliados['113'], 'SEM_MIGRATION_NA_ARVORE');
  for (const k of ['110', '111', '115']) assert.equal(r.saida.ampliados[k], 'ausente', k);
  assert.equal(r.log.filter(x => x.sql === b5.SQL_ESTADO_SATISFACAO && x.ro).length, 1);
  assert.equal(r.saida.ampliados['105'], 'completa'); assert.equal(r.saida.ampliados['118'], 'ausente');
  assert.equal(r.saida.estados['098'], 'SEM_NUCLEO_VER_COMBINADOS'); assert.deepEqual(r.saida.presentes, ['099:completa']);
  assert.equal(r.saida.estados['099'], 'completa'); assert.equal(r.saida.ampliados['114'], 'ausente');
  assert.equal(r.saida.combinados.estado, 'AUSENTE'); assert.equal(r.log.filter(x => x.sql === b5.SQL_COMBINADOS && x.ro).length, 1);
  assert.equal(r.saida.fundador.confirmadas, 0); assert.equal(r.saida.provedor.ramoDeclarado, 'COM_CONTA');
  assert.equal(r.saida.b15.legado.dvInvalidoTotal, 0); assert.equal(r.saida.decisao, undefined);
  const texto = JSON.stringify(r.saida);
  for (const proibido of ['11222333000181', '52998224725', 'SENHA_FALSA', 'aact', 'postgres', 'dpg-']) assert.ok(!texto.includes(proibido), proibido);
});

test('estados 089–100: parcial, ilegível e 100 divergente param (código 3); presentes listados; E2c exige 091 e 094 ausentes', async () => {
  for (const [estados, motivo] of [[{m093: 'parcial'}, /APLICACAO_PARCIAL 093/], [{ilegivel095: true}, /ESTADO_ILEGIVEL 095/], [{m100: 'divergente'}, /CORPO_DIVERGENTE 100/]]) {
    const r = await rodar(['--conferir-b5-estado'], {estados});
    assert.equal(r.codigo, 3, JSON.stringify(r.saida)); assert.match(r.saida.motivos.join(' '), motivo);
  }
  const ok = await rodar(['--conferir-b5-estado']);
  assert.equal(ok.codigo, 0, JSON.stringify(ok.saida)); assert.deepEqual(ok.saida.presentes, ['099:completa']);
  assert.equal(ok.saida.b15, undefined); assert.equal(ok.saida.fundador, undefined); assert.equal(ok.saida.provedor, undefined);
  assert.ok(!ok.log.some(x => [b5.SQL_DOCUMENTOS, b5.SQL_ORIGENS_091, b5.SQL_TOTAL_CONFIRMADAS].includes(x.sql)), 'E2c não lê documentos nem Fundador');
  for (const [estados, motivo] of [[{m091: 'completa'}, /E2C_091_PRESENTE completa/], [{m094: 'completa', m100: 'ausente'}, /E2C_094_PRESENTE completa/]]) {
    const r = await rodar(['--conferir-b5-estado'], {estados});
    assert.equal(r.codigo, 3); assert.match(r.saida.motivos.join(' '), motivo);
  }
});

test('revisão Astra r1, P1: prefixo antes do E3 também em 089–100 — 099 ausente, qualquer 089–097 presente ou 100 fora de sem_094 = PARAR nos dois modos', async () => {
  assert.deepEqual(b5.ESPERADO_BASE_ANTES_DO_E3, {'089': 'ausente', '090': 'ausente', '091': 'ausente', '092': 'ausente', '093': 'ausente', '094': 'ausente',
    '095': 'ausente', '096': 'ausente', '097': 'ausente', '099': 'completa', '100': 'sem_094'});
  const casos = [
    [{m099: 'ausente'}, ['PREFIXO_DIVERGENTE 099:ausente (esperado completa)']],
    [{m099: 'parcial'}, ['APLICACAO_PARCIAL 099', 'PREFIXO_DIVERGENTE 099:parcial (esperado completa)']],
    // Os dois falsos aceites da revisão: 099 ausente com 105 completa; 090 instalada e vazia (matriz: campanhas presente, 0 linhas).
    [{m090: 'completa'}, ['PREFIXO_DIVERGENTE 090:completa (esperado ausente)'], {catalogo: catalogoMatriz({assinatura_campanhas: {presente: true, tipo: 'r', ler: true}})}],
    [{m089: 'completa'}, ['PREFIXO_DIVERGENTE 089:completa (esperado ausente)']],
    [{m092: 'completa', m093: 'completa'}, ['PREFIXO_DIVERGENTE 092:completa (esperado ausente)', 'PREFIXO_DIVERGENTE 093:completa (esperado ausente)']],
    [{m095: 'completa'}, ['PREFIXO_DIVERGENTE 095:completa (esperado ausente)']], [{m096: 'completa'}, ['PREFIXO_DIVERGENTE 096:completa (esperado ausente)']],
    [{m097: 'completa'}, ['PREFIXO_DIVERGENTE 097:completa (esperado ausente)']], [{m100: 'ausente'}, ['PREFIXO_DIVERGENTE 100:ausente (esperado sem_094)']],
    [{m100: 'substituida_108'}, ['PREFIXO_DIVERGENTE 100:substituida_108 (esperado sem_094)']]];
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    for (const [estados, motivos, cfg] of casos) {
      const r = await rodar(argv, {estados, cliente: clienteFalso(cfg)});
      assert.equal(r.codigo, 3, argv + JSON.stringify(estados)); assert.equal(r.saida.resultado, 'PARAR');
      for (const m of motivos) assert.ok(r.saida.motivos.includes(m), m + ' em ' + JSON.stringify(r.saida.motivos));
      assert.ok(r.saida.motivos.every(m => /^(PREFIXO_DIVERGENTE|APLICACAO_PARCIAL|E2C_09[14]_PRESENTE|B15_091_|CORPO_DIVERGENTE)/.test(m)), JSON.stringify(r.saida.motivos));
    }
  }
  // A 091 completa no E1 também para pelo prefixo (o precheck do B-15 deixa de se aplicar).
  const e1 = await rodar(['--conferir-b5'], {estados: {m091: 'completa'}});
  assert.equal(e1.codigo, 3); assert.ok(e1.saida.motivos.includes('PREFIXO_DIVERGENTE 091:completa (esperado ausente)'));
  assert.equal(e1.saida.b15.compatibilidade091.precheckEstrutural, 'NAO_SE_APLICA_091_COMPLETA');
});

test('B-5 ampliado: 102–118 fora do prefixo esperado antes do E3 = PARAR (PREFIXO_DIVERGENTE), parcial e ilegível também; nos dois modos', async () => {
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    for (const [estados, motivos] of [
      [{m102: 'completa'}, ['PREFIXO_DIVERGENTE 102:completa (esperado ausente)']], [{m104: 'divergente'}, ['PREFIXO_DIVERGENTE 104:divergente (esperado ausente)']],
      [{m105: 'ausente'}, ['PREFIXO_DIVERGENTE 105:ausente (esperado completa)']], [{m105: 'parcial'}, ['APLICACAO_PARCIAL 105', 'PREFIXO_DIVERGENTE 105:parcial (esperado completa)']],
      [{m106: 'completa'}, ['PREFIXO_DIVERGENTE 106:completa (esperado ausente)']], [{m107: 'presente'}, ['PREFIXO_DIVERGENTE 107:presente (esperado ausente)']],
      [{m109: 'divergente'}, ['PREFIXO_DIVERGENTE 109:divergente (esperado ausente)']], [{m112: 'presente'}, ['PREFIXO_DIVERGENTE 112:presente (esperado ausente)']],
      [{m116: 'parcial'}, ['APLICACAO_PARCIAL 116', 'PREFIXO_DIVERGENTE 116:parcial (esperado ausente)']], [{m117: 'presente'}, ['PREFIXO_DIVERGENTE 117:presente (esperado ausente)']],
      [{m103: 'divergente'}, ['PREFIXO_DIVERGENTE 103:divergente (esperado ausente)']], [{m103: 'completa'}, ['PREFIXO_DIVERGENTE 103:completa (esperado ausente)']],
      [{ilegivel112: true}, ['ESTADO_ILEGIVEL 112', 'PAPEL_TROCADO_ILEGIVEL_OU_INCONSISTENTE', 'PREFIXO_DIVERGENTE 112:ILEGIVEL (esperado ausente)']]]) {
      const r = await rodar(argv, {estados});
      assert.equal(r.codigo, 3, JSON.stringify(estados)); assert.deepEqual([...r.saida.motivos].sort(), [...motivos].sort(), JSON.stringify(estados));
    }
    for (const [linha118, motivo] of [[{tabelas: 2, funcoes: 3, gatilhos: 2}, 'PREFIXO_DIVERGENTE 118:presente (esperado ausente)'],
      [{tabelas: 0, funcoes: 1, gatilhos: 0}, 'PREFIXO_DIVERGENTE 118:parcial (esperado ausente)'], [{tabelas: '0', funcoes: 0, gatilhos: 0}, 'PREFIXO_DIVERGENTE 118:ILEGIVEL (esperado ausente)'],
      [{tabelas: -1, funcoes: 0, gatilhos: 0}, 'PREFIXO_DIVERGENTE 118:ILEGIVEL (esperado ausente)']]) {
      const r = await rodar(argv, {cliente: clienteFalso({linha118})});
      assert.equal(r.codigo, 3); assert.deepEqual(r.saida.motivos, [motivo]);
    }
  }
  assert.equal(b5.lerEstado118({tabelas: 2, funcoes: 3, gatilhos: 2}), 'presente'); assert.equal(b5.lerEstado118({tabelas: 0, funcoes: 0, gatilhos: 0}), 'ausente');
  assert.equal(b5.lerEstado118({tabelas: 2, funcoes: 3, gatilhos: 1}), 'parcial');
  // 118 pelo catálogo: os 7 objetos da migration (2 tabelas, 3 funções, 2 gatilhos), e só catálogo.
  const sql118 = fs.readFileSync(path.join(__dirname, '..', 'database/migrations/20261104_118_importacao_cotas.sql'), 'utf8');
  assert.equal((sql118.match(/CREATE (TABLE|FUNCTION|TRIGGER) /g) ?? []).length, 7);
  for (const nome of ['ia_importacao_cotas', 'ia_importacao_usos', 'kidmais_118_janela_migracao', 'kidmais_118_periodo_mensal', 'kidmais_118_guarda', 'ia_importacao_cotas_118_guarda', 'ia_importacao_usos_118_guarda'])
    assert.ok(b5.SQL_ESTADO_118.includes(nome) && sql118.includes(nome), nome);
  assert.doesNotMatch(b5.SQL_ESTADO_118, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/);
});

test('B-5 ampliado: 110/111/115 (pesquisa de satisfação) pelo catálogo, por objeto; fora de "ausente" = PARAR, nos dois modos', async () => {
  const L = (trocas) => satisfacao('ausente', trocas);
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    for (const [linhaSatisfacao, motivos] of [
      [SATISFACAO_PRESENTE, ['PREFIXO_DIVERGENTE 110:presente (esperado ausente)', 'PREFIXO_DIVERGENTE 111:presente (esperado ausente)', 'PREFIXO_DIVERGENTE 115:presente (esperado ausente)']],
      // Só os objetos que a 110 redefine (CHECK ou função da 086) com a definição da 110: não é "ausente".
      [L({'110:check:marketing_exec_estado': 'conforme'}), ['PREFIXO_DIVERGENTE 110:parcial (esperado ausente)']],
      [L({'110:funcao:kidmais086_execucao_tenant()': 'conforme'}), ['PREFIXO_DIVERGENTE 110:parcial (esperado ausente)']],
      [L({'110:funcao:kidmais086_execucao_tenant()': 'divergente'}), ['PREFIXO_DIVERGENTE 110:parcial (esperado ausente)']],
      [L({'110:coluna:marketing_automacao_regras.canais': 'conforme'}), ['PREFIXO_DIVERGENTE 110:parcial (esperado ausente)']],
      [L({'111:gatilho:satisfacao_links_guarda': 'divergente'}), ['PREFIXO_DIVERGENTE 111:parcial (esperado ausente)']],
      // 115: índice novo (válido ou não) sem tirar o 054; 054 removido ou fora de forma.
      [L({'115:indice:fechamentos_115_empresa_data_idx': 'conforme'}), ['PREFIXO_DIVERGENTE 115:parcial (esperado ausente)']],
      [L({'115:indice:fechamentos_115_empresa_data_idx': 'divergente'}), ['PREFIXO_DIVERGENTE 115:parcial (esperado ausente)']],
      [L({'115:sem_indice:fechamentos_054_empresa_idx': 'conforme'}), ['PREFIXO_DIVERGENTE 115:parcial (esperado ausente)']],
      [L({'115:sem_indice:fechamentos_054_empresa_idx': 'divergente'}), ['PREFIXO_DIVERGENTE 115:parcial (esperado ausente)']],
      // Ilegível: identidade faltando, sobrando, valor fora do vocabulário, sem objetos.
      [(() => { const l = L(); delete l.objetos['110:tabela:satisfacao_saidas']; return l; })(), ['110', '111', '115'].map(k => `PREFIXO_DIVERGENTE ${k}:ILEGIVEL (esperado ausente)`)],
      [L({'110:tabela:satisfacao_outra': 'ausente'}), ['110', '111', '115'].map(k => `PREFIXO_DIVERGENTE ${k}:ILEGIVEL (esperado ausente)`)],
      [L({'111:tabela:satisfacao_auditoria': 'presente'}), ['110', '111', '115'].map(k => `PREFIXO_DIVERGENTE ${k}:ILEGIVEL (esperado ausente)`)],
      [{objetos: null}, ['110', '111', '115'].map(k => `PREFIXO_DIVERGENTE ${k}:ILEGIVEL (esperado ausente)`)]]) {
      const r = await rodar(argv, {cliente: clienteFalso({linhaSatisfacao})});
      assert.equal(r.codigo, 3, JSON.stringify(linhaSatisfacao)); assert.deepEqual([...r.saida.motivos].sort(), [...motivos].sort(), JSON.stringify(linhaSatisfacao));
    }
  }
  assert.deepEqual(b5.lerEstadoSatisfacao(SATISFACAO_PRESENTE), {'110': 'presente', '111': 'presente', '115': 'presente'});
  assert.deepEqual(b5.lerEstadoSatisfacao(LINHA_SATISFACAO), {'110': 'ausente', '111': 'ausente', '115': 'ausente'});
  // Sem soma: um gatilho desabilitado (divergente) com todo o resto conforme não vira "presente".
  assert.deepEqual(b5.lerEstadoSatisfacao(satisfacao('conforme', {'110:gatilho:satisfacao_envios_guarda': 'divergente', '115:sem_indice:fechamentos_054_empresa_idx': 'ausente'})),
    {'110': 'parcial', '111': 'presente', '115': 'parcial'});
  assert.deepEqual(b5.divergenciasSatisfacao(L({'111:gatilho:satisfacao_links_guarda': 'divergente'})), ['111:gatilho:satisfacao_links_guarda=divergente']);
  assert.deepEqual(b5.OBJETOS_SATISFACAO, {'110': 39, '111': 9, '115': 2});
  // Identidades = objetos das migrations; corpos (md5 de prosrc) = os dos arquivos; a 110 redefine a função da 086.
  const crypto = require('node:crypto');
  const ler = n => fs.readFileSync(path.join(__dirname, '..', 'database/migrations', n), 'utf8').split('\r\n').join('\n');
  const m086 = ler('20261018_086_marketing_automacoes.sql'), m110 = ler('20261030_110_satisfacao_pesquisa.sql');
  const m111 = ler('20261031_111_satisfacao_links_auditoria.sql'), m115 = ler('20261103_115_fechamentos_empresa_data.sql');
  const corpos = (sql) => Object.fromEntries([...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+\([^)]*\))[^$]*?AS \$\$([\s\S]*?)\$\$/g)]
    .map(([, f, c]) => [f, crypto.createHash('md5').update(c).digest('hex')]));
  const c086 = corpos(m086), c110 = corpos(m110), c111 = corpos(m111);
  assert.deepEqual(Object.fromEntries(b5.FUNCOES_SATISFACAO.map(([, f, h]) => [f, h])),
    Object.fromEntries(Object.entries({...c110, ...c111}).filter(([f]) => !f.startsWith('kidmais086_'))));
  assert.deepEqual(b5.FUNCOES_REDEFINIDAS.map(([, f, a, d]) => [f, a, d]), [['kidmais086_execucao_tenant()', c086['kidmais086_execucao_tenant()'], c110['kidmais086_execucao_tenant()']]]);
  const ids = new Set(b5.IDS_SATISFACAO.map(([id]) => id.split(':').slice(2).join(':')));
  for (const [sql, m] of [[m110, '110'], [m111, '111']]) {
    for (const [, nome] of sql.matchAll(/^CREATE TABLE (\w+)/gm)) assert.ok(b5.IDS_SATISFACAO.some(([id]) => id === `${m}:tabela:${nome}`), nome);
    for (const [, nome] of sql.matchAll(/^CREATE (?:CONSTRAINT )?TRIGGER (\w+)/gm)) assert.ok(ids.has(nome), nome);
  }
  assert.equal([...m110.matchAll(/^CREATE (?:CONSTRAINT )?TRIGGER /gm)].length, 8); assert.equal([...m111.matchAll(/^CREATE (?:CONSTRAINT )?TRIGGER /gm)].length, 4);
  // CHECKs: os 7 novos (ADD CONSTRAINT sem DROP antes) e os 4 que a 110 redefine (DROP + ADD com o nome da 086).
  const redefinidos = [...m110.matchAll(/DROP CONSTRAINT (\w+)/g)].map(([, n]) => n).sort();
  const novos = [...m110.matchAll(/ADD CONSTRAINT (\w+)/g)].map(([, n]) => n).filter(n => !redefinidos.includes(n)).sort();
  assert.deepEqual(b5.CHECKS_REDEFINIDOS.map(([, , n]) => n).sort(), redefinidos);
  assert.deepEqual(b5.CHECKS_SATISFACAO.map(([, , n]) => n).sort(), novos);
  for (const n of redefinidos) assert.match(m086, new RegExp(`CONSTRAINT ${n} CHECK`), n);
  for (const [, , n, a, d] of b5.CHECKS_REDEFINIDOS) assert.notEqual(a, d, n);
  for (const [, , c] of [['', '', 'canais'], ['', '', 'template_lembrete_texto'], ['', '', 'template_lembrete_provedor']]) assert.ok(m110.includes('ADD COLUMN ' + c + ' '), c);
  assert.match(m115, /CREATE INDEX IF NOT EXISTS fechamentos_115_empresa_data_idx ON public\.fechamentos \(empresa_id, data_evento\);/);
  assert.match(m115, /DROP INDEX IF EXISTS public\.fechamentos_054_empresa_idx/);
  assert.doesNotMatch(b5.SQL_ESTADO_SATISFACAO, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/);
});

test('B-5 ampliado: a 109 pelo contrato do cron (capacidade em READ ONLY com search_path); a 103 só lida com dependência e privilégio; contrato divergente = FALHA', async () => {
  const r = await rodar(['--conferir-b5-estado']);
  const i = r.log.findIndex(x => x.sql === 'SET LOCAL search_path = public, pg_catalog');
  assert.ok(i > 0 && r.log[i].ro, 'capacidade da 109 dentro de uma transação READ ONLY própria');
  assert.equal(r.log.filter(x => x.sql === 'CATEGORIA 103').length, 1, 'com d103/ler_103 a linha SERVICOS é lida uma vez');
  const sem = await rodar(['--conferir-b5-estado'], {estados: {d103: false}});
  assert.equal(sem.log.filter(x => x.sql === 'CATEGORIA 103').length, 0, 'sem d103 a linha SERVICOS não é lida');
  const com103 = await rodar(['--conferir-b5-estado'], {estados: {d103: true, ler_103: true}, cliente: clienteFalso({categoria103: {m103: 'completa'}})});
  assert.equal(com103.saida.ampliados['103'], 'completa'); assert.ok(com103.log.some(x => x.sql === 'CATEGORIA 103' && x.ro));
  const naoLida = await rodar(['--conferir-b5-estado'], {estados: {d103: true, ler_103: false}});
  assert.equal(naoLida.codigo, 3); assert.ok(naoLida.saida.motivos.includes('PREFIXO_DIVERGENTE 103:indeterminada (esperado ausente)'));
  for (const [erro, msg] of [['CONTRATO_109_DIVERGENTE', 'CONTRATO_109_DIVERGENTE'], ['CONTRATO_109_INDISPONIVEL', 'CONTRATO_109_INDISPONIVEL']]) {
    const f = await rodar(['--conferir-b5-estado'], {contrato: () => { throw new Error(erro); }});
    assert.equal(f.codigo, 2); assert.equal(f.saida.mensagem, msg); assert.equal(f.log.at(-1).sql, 'ROLLBACK');
  }
  // Contrato real: o TS conferido por sha256 expõe capacidadeRenovacao; arquivo alterado ou import que falha recusam.
  assert.equal(typeof (await b5.carregarContrato109()).capacidadeRenovacao, 'function');
  await assert.rejects(b5.carregarContrato109(path.resolve(__dirname, '..'), async () => { throw new Error('ERR_UNKNOWN_FILE_EXTENSION'); }), /^Error: CONTRATO_109_INDISPONIVEL$/);
  await assert.rejects(b5.carregarContrato109(path.resolve(__dirname, '..'), async () => ({})), /CONTRATO_109_INDISPONIVEL/);
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-109-'));
  try {
    fs.mkdirSync(path.join(raiz, 'lib/assinatura'), {recursive: true});
    for (const a of ['renovacao-schema.ts', 'renovacao-schema-retratos.ts']) fs.copyFileSync(path.join(__dirname, '..', 'lib/assinatura', a), path.join(raiz, 'lib/assinatura', a));
    fs.appendFileSync(path.join(raiz, 'lib/assinatura/renovacao-schema-retratos.ts'), '\n// alterado\n');
    await assert.rejects(b5.carregarContrato109(raiz), /CONTRATO_109_DIVERGENTE/);
  } finally { fs.rmSync(raiz, {recursive: true, force: true}); }
});

test('revisão Astra r1, P1 — 114: só o par de corpos comprovado de production antes do E3 (019 + 062) é ausente; ausente, desconhecido ou misturado = divergente', async () => {
  // O par é o texto das migrations: o último corpo de cada função até a 088 (lock da 019, revisão da 062), prosrc sem CR.
  const corpo = (arquivo, fn) => {
    const t = fs.readFileSync(path.join(__dirname, '..', 'database/migrations', arquivo), 'utf8').split('\r').join('');
    const i = t.search(new RegExp('FUNCTION\\s+(?:public\\.)?' + fn + '\\s*\\(\\s*\\)')), a = /AS\s+(\$[A-Za-z_]*\$)/.exec(t.slice(i));
    const ini = i + a.index + a[0].length; return require('node:crypto').createHash('sha256').update(t.slice(ini, t.indexOf(a[1], ini))).digest('hex');
  };
  assert.equal(b5.CORPOS_114_ANTES_DO_E3.lock, corpo('20260915_019_festa_formalizacao.sql', 'kidmais019_lock_ocupacao'));
  assert.equal(b5.CORPOS_114_ANTES_DO_E3.revisao, corpo('20261002_062_agenda_empresa_unidade.sql', 'kidmais_validar_agenda_revisao'));
  assert.equal(b5.CORPOS_114_ANTES_DO_E3.lock, n114.CORPOS.antes.lock); assert.notEqual(b5.CORPOS_114_ANTES_DO_E3.revisao, n114.CORPOS.antes.revisao);
  // Nenhuma migration entre a 062 e a 088 regrava a revisão (a próxima é a 094).
  const arquivos = fs.readdirSync(path.join(__dirname, '..', 'database/migrations')).sort();
  const regravam = arquivos.filter(a => a.slice(0, 12) > '20261002_062' && a.slice(0, 12) < '20261022_094' && /FUNCTION\s+(?:public\.)?(kidmais_validar_agenda_revisao|kidmais019_lock_ocupacao)\s*\(/
    .test(fs.readFileSync(path.join(__dirname, '..', 'database/migrations', a), 'utf8')));
  assert.deepEqual(regravam, []);
  const D = n114.CORPOS.depois, A = n114.CORPOS.antes, P = b5.CORPOS_114_ANTES_DO_E3, X = 'c'.repeat(64);
  for (const [linha114, esperado] of [[{}, 'ausente'],
    // Os falsos aceites da revisão: corpos ausentes ou desconhecidos.
    [{hash_lock: null, hash_revisao: null}, 'divergente'], [{hash_lock: X, hash_revisao: 'd'.repeat(64)}, 'divergente'],
    [{hash_lock: P.lock, hash_revisao: null}, 'divergente'], [{hash_lock: null, hash_revisao: P.revisao}, 'divergente'], [{hash_revisao: X}, 'divergente'],
    // Misturados com o pós-114 ou com o par de staging.
    [{hash_lock: D.lock}, 'divergente'], [{hash_revisao: D.revisao}, 'divergente'], [{hash_revisao: A.revisao}, 'divergente'],
    [{f114: true}, 'divergente'], [{hash_exigir: X}, 'divergente'], [{f114: null}, 'divergente']]) {
    for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
      const r = await rodar(argv, {estados: {m114: 'divergente'}, cliente: clienteFalso({linha114})});
      assert.equal(r.saida.ampliados['114'], esperado, JSON.stringify(linha114)); assert.equal(r.codigo, esperado === 'ausente' ? 0 : 3, JSON.stringify(linha114));
    }
  }
  // "ausente" do núcleo = par de staging (098/108 já presente): outro prefixo, PARAR; com o par de production, ausente.
  const staging = await rodar(['--conferir-b5-estado'], {estados: {m114: 'ausente'}, cliente: clienteFalso({linha114: {hash_lock: A.lock, hash_revisao: A.revisao}})});
  assert.equal(staging.saida.ampliados['114'], 'ausente_par_de_staging'); assert.ok(staging.saida.motivos.includes('PREFIXO_DIVERGENTE 114:ausente_par_de_staging (esperado ausente)'));
  assert.equal((await rodar(['--conferir-b5-estado'], {estados: {m114: 'ausente'}})).saida.ampliados['114'], 'ausente');
  // Os outros estados do núcleo passam intactos.
  for (const m114 of ['presente', 'completa', 'parcial']) assert.equal((await rodar(['--conferir-b5-estado'], {estados: {m114}})).saida.ampliados['114'], m114);
  const pres = await rodar(['--conferir-b5-estado'], {estados: {m114: 'presente'}});
  assert.equal(pres.saida.ampliados['114'], 'presente'); assert.ok(pres.saida.motivos.includes('PREFIXO_DIVERGENTE 114:presente (esperado ausente)'));
  assert.equal(b5.estado114(n114, {f114: false, hash_exigir: null, hash_lock: P.lock, hash_revisao: P.revisao}, 'divergente'), 'ausente');
});

test('B-5 ampliado, 108: o estado vem da regra da candidata (B-21); o do núcleo fica como diagnóstico; parcial do núcleo só some se o B-21 não for AUSENTE', async () => {
  const nova = await rodar(['--conferir-b5-estado'], {estados: {m108: 'PARCIAL'}, cliente: clienteFalso({combinados: [LINHAS.NOVA]})});
  assert.equal(nova.saida.ampliados['108'], 'NOVA'); assert.equal(nova.saida.ampliados.nucleo108, 'PARCIAL');
  assert.ok(!nova.saida.motivos.includes('APLICACAO_PARCIAL 108'));
  assert.ok(nova.saida.motivos.includes('PREFIXO_DIVERGENTE 108:NOVA (esperado AUSENTE)') && nova.saida.motivos.some(m => m.startsWith('COMBINADOS_NOVA')));
  const aus = await rodar(['--conferir-b5-estado'], {estados: {m108: 'PARCIAL'}});
  assert.equal(aus.codigo, 3); assert.ok(aus.saida.motivos.includes('APLICACAO_PARCIAL 108'), 'núcleo parcial com B-21 AUSENTE continua parando');
  assert.equal(aus.saida.ampliados['108'], 'AUSENTE');
  const ileg = await rodar(['--conferir-b5-estado'], {cliente: clienteFalso({combinados: []})});
  assert.equal(ileg.saida.ampliados['108'], 'ILEGIVEL'); assert.ok(ileg.saida.motivos.includes('COMBINADOS_ILEGIVEIS'));
});

test('matriz §9.2.2: fotografia REPEATABLE READ READ ONLY; obrigatória ausente, fora do escopo, linha em VAZIA, RLS, privilégio e classificados = PARAR', async () => {
  const ok = await rodar(['--conferir-b5-estado']);
  const transacao = ok.log.filter(x => x.iso === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(transacao.some(x => x.sql === b5.SQL_MATRIZ_CATALOGO) && transacao.some(x => x.sql === b5.SQL_MATRIZ_PAPEL));
  assert.equal(transacao.filter(x => x.sql.startsWith('SELECT count(*)')).length, b5.MATRIZ.filter(m => m[3] === 'OBRIGATORIA').length, 'uma contagem por objeto presente, na mesma transação');
  assert.equal(ok.saida.matriz.protocolo, 'REPEATABLE READ READ ONLY'); assert.match(ok.saida.matriz.veredito, /^NAO_EMITIDO/);
  assert.equal(ok.saida.matriz.objetos.assinatura_encerramentos.estrutura, 'AUSENTE'); assert.equal(ok.saida.matriz.objetos.empresa_assinaturas.linhas, 0);
  assert.deepEqual(ok.saida.matriz.objetos.cadastros_publicos, {migracao: '069', grupo: 'CLASSIFICADA', estrutura: 'PRESENTE', rls: false, rlsForcada: false, linhas: 0, pendentes: 0,
    confirmados: 0, substituidos: 0, pendentesNaoExpirados: 0});
  const pres = {presente: true, tipo: 'r', ler: true};
  const casos = [
    [{catalogo: catalogoMatriz({assinatura_avisos: {presente: false, tipo: '', ler: false}})}, ['MATRIZ_ESTRUTURA_AUSENTE assinatura_avisos']],
    [{catalogo: catalogoMatriz({ia_credito_franquias_ciclo: pres})}, ['MATRIZ_FORA_DO_ESCOPO_PRESENTE ia_credito_franquias_ciclo']],
    [{catalogo: catalogoMatriz({assinatura_campanhas: pres}), contagens: {assinatura_campanhas: {linhas: '1'}}}, ['MATRIZ_VAZIA_COM_LINHAS assinatura_campanhas 1']],
    [{catalogo: catalogoMatriz({ia_credito_lotes: pres}), contagens: {ia_credito_lotes: {linhas: '3'}}}, ['MATRIZ_VAZIA_COM_LINHAS ia_credito_lotes 3']],
    [{catalogo: catalogoMatriz({ia_credito_pedidos: pres}), contagens: {ia_credito_pedidos: {linhas: '2'}}}, ['MATRIZ_VAZIA_COM_LINHAS ia_credito_pedidos 2']],
    [{catalogo: catalogoMatriz({assinatura_comprovantes: pres}), contagens: {assinatura_comprovantes: {linhas: '1'}}}, ['MATRIZ_VAZIA_COM_LINHAS assinatura_comprovantes 1']],
    [{contagens: {empresa_assinaturas: {linhas: '1'}}}, ['MATRIZ_VAZIA_COM_LINHAS empresa_assinaturas 1']],
    [{contagens: {assinatura_avisos: {linhas: '7'}}}, ['MATRIZ_VAZIA_COM_LINHAS assinatura_avisos 7']],
    [{catalogo: catalogoMatriz({assinatura_isencoes: {rls: true}})}, ['MATRIZ_RLS_PODE_INDUZIR_ZERO assinatura_isencoes']],
    [{catalogo: catalogoMatriz({cobranca_eventos: {ler: false}})}, ['MATRIZ_SEM_PRIVILEGIO_LEITURA cobranca_eventos']],
    [{catalogo: catalogoMatriz({cobranca_eventos: {tipo: 'v'}})}, ['MATRIZ_NAO_E_TABELA cobranca_eventos']],
    [{contagens: {empresa_excecoes_comerciais: {linhas: '3', vigentes_revogaveis: '1'}}}, ['MATRIZ_EXCECAO_VIGENTE_NAO_TERMINAL 1']],
    [{catalogo: catalogoMatriz({empresa_documento_continuidades: pres}), contagens: {empresa_documento_continuidades: {linhas: '2', nao_concluidas: '1'}}}, ['MATRIZ_CONTINUIDADE_NAO_CONCLUIDA 1']],
    [{contagens: {cadastros_empresas: {linhas: '1'}}}, ['MATRIZ_CADASTRO_EMPRESA_EXIGE_EXPLICACAO_P1 1']]];
  for (const [cfg, motivos] of casos) for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    const r = await rodar(argv, {cliente: clienteFalso(cfg)});
    assert.equal(r.codigo, 3, JSON.stringify(cfg)); assert.deepEqual(r.saida.motivos, motivos, JSON.stringify(cfg));
  }
  // Classificados só contam: isenções, exceções terminais, continuidades concluídas e cadastros públicos (no P1) não param.
  const conta = await rodar(['--conferir-b5-estado'], {cliente: clienteFalso({catalogo: catalogoMatriz({empresa_documento_continuidades: pres}), contagens: {assinatura_isencoes: {linhas: '2'},
    empresa_excecoes_comerciais: {linhas: '4', vigentes_revogaveis: '0'}, empresa_documento_continuidades: {linhas: '1', nao_concluidas: '0'},
    cadastros_publicos: {linhas: '5', pendentes: '1', confirmados: '3', substituidos: '1', pendentes_nao_expirados: '1'}}})});
  assert.equal(conta.codigo, 0, JSON.stringify(conta.saida.motivos)); assert.equal(conta.saida.matriz.objetos.cadastros_publicos.pendentesNaoExpirados, 1);
  assert.equal(conta.saida.matriz.objetos.assinatura_isencoes.linhas, 2);
  // RLS com superusuário ou BYPASSRLS não induz zero.
  for (const papel of [{superusuario: true, ignora_rls: false}, {superusuario: false, ignora_rls: true}]) {
    const r = await rodar(['--conferir-b5-estado'], {cliente: clienteFalso({papel, catalogo: catalogoMatriz({assinatura_isencoes: {rls: true, rls_forcada: true}})})});
    assert.equal(r.codigo, 0, JSON.stringify(papel)); assert.equal(r.saida.matriz.objetos.assinatura_isencoes.rlsForcada, true);
  }
  // Ilegível nunca vira zero: FALHA (código 2) com ROLLBACK.
  for (const cfg of [{contagens: {cobranca_eventos: {linhas: 0}}}, {contagens: {cobranca_eventos: {linhas: '-1'}}}, {contagens: {cobranca_eventos: {linhas: '1e3'}}},
    {catalogo: catalogoMatriz().slice(1)}, {catalogo: [...catalogoMatriz()].reverse()}, {catalogo: catalogoMatriz({cobranca_eventos: {presente: 'true'}})},
    {papel: {superusuario: null, ignora_rls: false}}, {falharEm: 'FROM public.assinatura_avisos'}]) {
    const r = await rodar(['--conferir-b5-estado'], {cliente: clienteFalso(cfg)});
    assert.equal(r.codigo, 2, JSON.stringify(cfg)); assert.equal(r.log.at(-1).sql, 'ROLLBACK');
    if (!cfg.falharEm) assert.equal(r.saida.mensagem, 'MATRIZ_ILEGIVEL', JSON.stringify(cfg));
  }
  // A matriz lista os objetos da §9.2.2 (núcleo, encerramento/contratação, campanha, créditos, fora do escopo, classificados).
  assert.equal(b5.MATRIZ.length, 28); assert.deepEqual(b5.MATRIZ.filter(m => m[3] === 'PROIBIDA').map(m => m[0]), ['ia_credito_franquias_ciclo', 'ia_credito_franquia_pendencias']);
  assert.throws(() => b5.sqlContagem('x; DROP TABLE y'), /MATRIZ_ILEGIVEL/);
});

test('B-15 reescopado: legado (DV), rótulo do ramo VAZIO, prova artificial não aplicável, precheck da 091, origens futuras; só contagens', async () => {
  const docs = [['empresa_assinaturas', '11222333000180', false], ['empresa_assinaturas', '11222333000181', true], ['empresa_assinaturas', null, false],
    ['empresa_assinaturas', '52998224724', true], ['empresa_assinaturas', 'XYZ', false], ['assinatura_fundadores', '11222333000180', true], ['assinatura_fundadores', '12ABC34501DE35', true]]
    .map(([origem, doc, tem_concessao]) => ({origem, doc, tem_concessao}));
  const origens = [['cadastros_empresas', '11222333000181'], ['cadastros_empresas', '11222333000180'], ['solicitacoes_acesso_empresa', '52998224725'],
    ['plataforma_empresas_cadastro', null], ['plataforma_empresas_cadastro', '52998224724']].map(([origem, doc]) => ({origem, doc}));
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({docs, origens})});
  // 'XYZ' no legado de empresa_assinaturas: fora do formato dos CHECKs novos ⇒ o ALTER da 091 falharia (PARAR).
  assert.equal(r.codigo, 3); assert.deepEqual(r.saida.motivos, ['B15_091_CHECK_FALHARIA empresa_assinaturas 1']);
  assert.equal(r.saida.decisao, 'DECISAO_D_OP_4_NECESSARIA');
  const b = r.saida.b15;
  assert.deepEqual(b.legado.empresa_assinaturas, {total: 5, nulos: 1, cpf11: 1, cnpj14: 2, outroFormato: 1, foraDoFormato091: 1, dvInvalido: 3});
  assert.deepEqual(b.legado.assinatura_fundadores, {total: 2, nulos: 0, cpf11: 0, cnpj14: 2, outroFormato: 0, foraDoFormato091: 0, dvInvalido: 1});
  assert.equal(b.legado.empresasSemConcessaoComDvInvalido, 2); assert.equal(b.legado.dvInvalidoTotal, 4);
  assert.equal(b.inventarioLegado, 'COM_LINHAS'); assert.match(b.provaArtificialDocumentoLegado, /^EXIGIDA/);
  assert.deepEqual(b.compatibilidade091, {tabelas: '6/6', checks: '5/5', objetos091Presentes: false, precheckEstrutural: 'PASSARIA', checksDaBasePorRelacao: 'CONFORME', versaoPg: 180006});
  assert.deepEqual(b.origensFuturas, {cadastros_empresas: {total: 2, nulos: 0, foraDoFormato091: 0, dvInvalido: 1}, solicitacoes_acesso_empresa: {total: 1, nulos: 0, foraDoFormato091: 0, dvInvalido: 0},
    plataforma_empresas_cadastro: {total: 2, nulos: 1, foraDoFormato091: 0, dvInvalido: 1}});
  assert.ok(b.naoCoberto.length >= 4);
  for (const d of ['11222333000180', '52998224724', '52998224725']) assert.ok(!JSON.stringify(r.saida).includes(d));
  assert.ok(r.log.some(x => x.ro && x.sql === "SET LOCAL statement_timeout = '60s'"), 'leitura de documentos com tempo próprio');
  // Ramo VAZIO: legado vazio = prova artificial não aplicável SE o G-VAZIO do P1 confirmar (§9.2.7; revisão Astra r1, P2-F);
  // com a matriz parada, o rótulo é INDETERMINADA.
  const vazio = await rodar(['--conferir-b5']);
  assert.equal(vazio.saida.b15.inventarioLegado, 'VAZIO'); assert.match(vazio.saida.b15.provaArtificialDocumentoLegado, /^NAO_APLICAVEL_SE_G_VAZIO_P1 .*B-26/);
  const parou = await rodar(['--conferir-b5'], {cliente: clienteFalso({contagens: {cobranca_eventos: {linhas: '1'}}})});
  assert.equal(parou.saida.b15.inventarioLegado, 'VAZIO'); assert.match(parou.saida.b15.provaArtificialDocumentoLegado, /^INDETERMINADA/);
  // Precheck estrutural: falharia (PARAR) com 091 ausente; não se aplica com a 091 presente.
  for (const [compat, esperado] of [[{checks: 4}, 'FALHARIA'], [{tabelas: 5}, 'FALHARIA'], [{objetos_091: true}, 'FALHARIA']]) {
    const f = await rodar(['--conferir-b5'], {cliente: clienteFalso({compat: {...COMPAT, ...compat}})});
    assert.equal(f.saida.b15.compatibilidade091.precheckEstrutural, esperado); assert.equal(f.codigo, 3); assert.ok(f.saida.motivos.includes('B15_091_PRECHECK_ESTRUTURAL_FALHARIA'));
  }
  const ja = await rodar(['--conferir-b5'], {estados: {m091: 'completa'}, cliente: clienteFalso({compat: {...COMPAT, objetos_091: true}})});
  assert.equal(ja.saida.b15.compatibilidade091.precheckEstrutural, 'NAO_SE_APLICA_091_COMPLETA'); assert.equal(ja.saida.b15.compatibilidade091.checksDaBasePorRelacao, 'NAO_SE_APLICA');
  assert.ok(!ja.saida.motivos.some(m => m.startsWith('B15_')), JSON.stringify(ja.saida.motivos)); assert.ok(!ja.log.some(x => x.sql === b5.SQL_CHECKS_091));
  // Documento fora do formato dos CHECKs novos (cadastros/solicitações) = o ALTER da 091 falharia.
  const fora = await rodar(['--conferir-b5'], {cliente: clienteFalso({origens: [{origem: 'solicitacoes_acesso_empresa', doc: '1234'}]})});
  assert.equal(fora.codigo, 3); assert.deepEqual(fora.saida.motivos, ['B15_091_CHECK_FALHARIA solicitacoes_acesso_empresa 1']);
  const sem = await rodar(['--conferir-b5'], {cliente: clienteFalso({compat: {...COMPAT, plataforma: false}})});
  assert.equal(sem.saida.b15.origensFuturas, null); assert.ok(sem.saida.motivos.includes('B15_ORIGENS_AUSENTES'));
  assert.ok(!sem.log.some(x => x.sql === b5.SQL_ORIGENS_091));
  for (const compat of [{tabelas: '6'}, {checks: -1}, {objetos_091: 'f'}, {plataforma: null}]) {
    const i = await rodar(['--conferir-b5'], {cliente: clienteFalso({compat: {...COMPAT, ...compat}})});
    assert.equal(i.codigo, 2); assert.equal(i.saida.mensagem, 'B15_CATALOGO_ILEGIVEL');
  }
  assert.throws(() => b5.inventarioDocumentos([{origem: 'outra', doc: 'x'}]), /ORIGEM_INESPERADA/);
  assert.throws(() => b5.inventarioOrigens([{origem: 'empresa_assinaturas', doc: 'x'}]), /ORIGEM_INESPERADA/);
});

test('revisão Astra r1, P2-F: CHECKs da base conferidos na SUA relação (public), validados, na coluna e com a definição da base; homônimo noutra relação não compensa', async () => {
  const outra = {nome: 'cadastros_empresas_documento_check', esquema: 'public', tabela: 'outra_tabela', validado: true, definicao: DEF.cadastros_empresas_documento_check, colunas: ['documento']};
  const casos = [
    [{checks091: checksBase().filter(c => c.nome !== 'solicitacoes_documento_check'), compat: {...COMPAT, checks: 4}}, ['B15_091_PRECHECK_ESTRUTURAL_FALHARIA', 'B15_091_CHECK_BASE_DIVERGENTE solicitacoes_documento_check']],
    // Falta na relação certa, compensada por homônimo noutra: a contagem literal passa (5), a conferência por relação não.
    [{checks091: [...checksBase().filter(c => c.nome !== 'cadastros_empresas_documento_check'), outra]}, ['B15_091_CHECK_BASE_DIVERGENTE cadastros_empresas_documento_check']],
    [{checks091: [...checksBase(), {...outra, esquema: 'outro'}], compat: {...COMPAT, checks: 6}}, ['B15_091_PRECHECK_ESTRUTURAL_FALHARIA', 'B15_091_CHECK_BASE_DIVERGENTE cadastros_empresas_documento_check']],
    [{checks091: checksBase({empresa_assinaturas_documento_teste_check: {validado: false}})}, ['B15_091_CHECK_BASE_DIVERGENTE empresa_assinaturas_documento_teste_check']],
    [{checks091: checksBase({assinatura_fundadores_documento_beneficiario_check: {colunas: ['empresa_id']}})}, ['B15_091_CHECK_BASE_DIVERGENTE assinatura_fundadores_documento_beneficiario_check']],
    [{checks091: checksBase({solicitacoes_documento_check: {definicao: "CHECK ((documento ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'::text))"}})}, ['B15_091_CHECK_BASE_DIVERGENTE solicitacoes_documento_check']],
    [{checks091: checksBase({empresa_representacoes_qualificacao_check: {definicao: DEF.empresa_representacoes_qualificacao_check.replace("'RESPONSAVEL_INDICADO'::text", "'RESPONSAVEL_INDICADO'::text, 'TITULAR_PF'::text")}})},
      ['B15_091_CHECK_BASE_DIVERGENTE empresa_representacoes_qualificacao_check']],
    [{checks091: checksBase({empresa_assinaturas_documento_teste_check: {definicao: "CHECK ((documento_teste ~ '^[0-9A-Z]{12}[0-9]{2}$'::text))"}})}, ['B15_091_CHECK_BASE_DIVERGENTE empresa_assinaturas_documento_teste_check']]];
  for (const [cfg, motivos] of casos) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso(cfg)});
    assert.equal(r.codigo, 3, JSON.stringify(cfg)); assert.deepEqual(r.saida.motivos, motivos); assert.equal(r.saida.b15.compatibilidade091.checksDaBasePorRelacao, 'DIVERGENTE');
  }
  for (const checks091 of [[{...checksBase()[0], validado: 'true'}], [{...checksBase()[0], colunas: null}], [{...checksBase()[0], definicao: null}], {}]) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({checks091})});
    assert.equal(r.codigo, 2); assert.equal(r.saida.mensagem, 'B15_CATALOGO_ILEGIVEL');
  }
});

test('revisão Astra r1, P2-F: origens futuras qualificadas (public.) e só lidas com privilégio e sem RLS que possa esconder linhas', async () => {
  assert.match(b5.SQL_ORIGENS_091, /FROM public\.cadastros_empresas[\s\S]*FROM public\.solicitacoes_acesso_empresa[\s\S]*FROM public\.plataforma_empresas_cadastro/);
  assert.doesNotMatch(b5.SQL_ORIGENS_091.replace(/public\.[a-z_]+/g, ''), /FROM [a-z]/);
  assert.match(b5.SQL_DOCUMENTOS, /FROM public\.empresa_assinaturas/);
  for (const [aj, motivo] of [[{solicitacoes_acesso_empresa: {rls: true}}, 'B15_ORIGEM_RLS_PODE_INDUZIR_ZERO solicitacoes_acesso_empresa'],
    [{plataforma_empresas_cadastro: {ler: false}}, 'B15_ORIGEM_SEM_PRIVILEGIO_LEITURA plataforma_empresas_cadastro'],
    [{cadastros_empresas: {rls: true}}, 'B15_ORIGEM_RLS_PODE_INDUZIR_ZERO cadastros_empresas'],
    [{cadastros_empresas: {presente: false, ler: false}}, 'B15_ORIGENS_AUSENTES cadastros_empresas']]) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({origensCat: origensCatalogo(aj), origens: [{origem: 'cadastros_empresas', doc: '52998224725'}]})});
    assert.equal(r.codigo, 3, motivo); assert.deepEqual(r.saida.motivos, [motivo]); assert.equal(r.saida.b15.origensFuturas, null);
    assert.ok(!r.log.some(x => x.sql === b5.SQL_ORIGENS_091), 'visibilidade incompleta: nada é lido');
  }
  const bypass = await rodar(['--conferir-b5'], {cliente: clienteFalso({origensCat: origensCatalogo({solicitacoes_acesso_empresa: {rls: true, ignora_rls: true}})})});
  assert.equal(bypass.codigo, 0, JSON.stringify(bypass.saida.motivos));
  for (const origensCat of [origensCatalogo().slice(1), origensCatalogo({cadastros_empresas: {rls: 'f'}}), [...origensCatalogo()].reverse()]) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({origensCat})});
    assert.equal(r.codigo, 2); assert.equal(r.saida.mensagem, 'B15_CATALOGO_ILEGIVEL');
  }
});

test('revisão Astra r1, P2-C/E: lotes de crédito discriminados por origem; gatilhos da 118 só nas tabelas da 118', async () => {
  assert.match(b5.SQL_ESTADO_118, /WHERE NOT tgisinternal AND tgname IN \('ia_importacao_cotas_118_guarda', 'ia_importacao_usos_118_guarda'\)\s+AND tgrelid IN \(SELECT to_regclass\('public\.' \|\| t\) FROM unnest\(ARRAY\['ia_importacao_cotas', 'ia_importacao_usos'\]\) t\)/);
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({catalogo: catalogoMatriz({ia_credito_lotes: {presente: true, tipo: 'r', ler: true}}),
    contagens: {ia_credito_lotes: {linhas: '3', origem_compra: '1', origem_franquia: '1', origem_cortesia: '0', origem_legado: '1', com_pedido: '1'}}})});
  assert.equal(r.codigo, 3); assert.deepEqual(r.saida.motivos, ['MATRIZ_VAZIA_COM_LINHAS ia_credito_lotes 3']);
  assert.deepEqual(r.saida.matriz.objetos.ia_credito_lotes, {migracao: '095', grupo: 'CREDITOS_GERAIS', estrutura: 'PRESENTE', rls: false, rlsForcada: false, linhas: 3,
    origemCompra: 1, origemFranquia: 1, origemCortesia: 0, origemLegado: 1, comPedido: 1});
  assert.match(b5.CONTAGEM_EXTRA.ia_credito_lotes, /origem = 'COMPRA'[\s\S]*origem = 'FRANQUIA'[\s\S]*origem = 'CORTESIA'[\s\S]*origem = 'LEGADO'[\s\S]*pedido_id IS NOT NULL/);
  // Os valores são os do CHECK da 095.
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'database/migrations/20261022_095_ia_creditos.sql'), 'utf8').includes("origem text NOT NULL CHECK (origem IN ('FRANQUIA', 'COMPRA', 'CORTESIA', 'LEGADO'))"));
});

test('Fundador sem provedor: zero confirmadas = parte vazia e nenhuma outra leitura; com confirmada = ramo COM-DADOS (PARAR), datas só dos registros', async () => {
  const zero = await rodar(['--conferir-b5']);
  assert.equal(zero.codigo, 0); const f0 = zero.saida.fundador;
  assert.equal(f0.ramo, 'SEM_CONCESSAO_CONFIRMADA'); assert.equal(f0.confirmadas, 0); assert.equal(f0.consultasAsaas, 0); assert.equal(f0.menorPrimeiraDataRegular, null);
  assert.ok(!zero.log.some(x => x.sql === b5.SQL_RENOVACAO_INSTALADA || x.sql === b5.sqlConcessoes(true)), 'sem concessão, nada além da contagem');
  const concessoes = [concessao(), concessao({registrada: '2027-01-05', atual: false}), concessao({registrada: null}), concessao({registrada: '2027-02-30'}),
    concessao({tem_contratacao: false}), concessao({linhas_da_concessao: '2'})];
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes})});
  const f = r.saida.fundador;
  assert.equal(r.codigo, 3); assert.equal(f.ramo, 'COM_CONCESSAO_CONFIRMADA'); assert.equal(f.confirmadas, 6); assert.equal(f.calculadas, 2); assert.equal(f.registradas, 2);
  assert.equal(f.semRegistroProvedorNaoConsultado, 2); assert.equal(f.contratacaoAusenteOuMultipla, 2); assert.equal(f.contratacaoNaoAtual, 1); assert.equal(f.consultasAsaas, 0);
  assert.equal(f.menorPrimeiraDataRegular, '2027-01-05'); assert.equal(f.limiteAviso, renovacao.diasAntes('2027-01-05', 30));
  assert.equal(f.inicioJanelaAviso, renovacao.inicioJanelaAviso('2027-01-05')); assert.equal(f.prazoB9, renovacao.diasAntes('2027-01-05', 47));
  assert.deepEqual(r.saida.motivos, ['FUNDADOR_CONFIRMADAS_RAMO_COM_DADOS 6 (nucleo nao vazio; datas sem provedor)', 'FUNDADOR_COBERTURA_INCOMPLETA 2/6']);
  // Mesmo com todas registradas, concessão confirmada para (núcleo não vazio).
  const todas = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao()]})});
  assert.deepEqual(todas.saida.motivos, ['FUNDADOR_CONFIRMADAS_RAMO_COM_DADOS 1 (nucleo nao vazio; datas sem provedor)']);
  // Sem a 075, nenhuma data registrada: coberturas zero.
  const sem075 = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: null})], instalada: false})});
  assert.equal(sem075.saida.fundador.calculadas, 0); assert.ok(sem075.log.some(x => x.sql === b5.sqlConcessoes(false)));
  // Janela perdida e janela aberta (hoje 2026-11-10).
  const perdida = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: '2026-11-20'})]})});
  assert.ok(perdida.saida.motivos.includes('JANELAS_DE_AVISO_PERDIDAS 1') && perdida.saida.motivos.includes('PRAZO_B9_VENCIDO'));
  const aberta = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: '2026-12-11'})]})});
  assert.equal(aberta.saida.fundador.janelasAbertas, 1); assert.equal(aberta.saida.fundador.janelasPerdidas, 0);
  for (const total of ['x', -1, 1.5, null]) {
    const i = await rodar(['--conferir-b5'], {cliente: clienteFalso({total})});
    assert.equal(i.codigo, 2, String(total)); assert.equal(i.saida.mensagem, 'FUNDADOR_TOTAL_ILEGIVEL');
  }
  // A consulta das concessões não traz identificadores do provedor nem valores.
  assert.doesNotMatch(b5.sqlConcessoes(true), /pagamento_confirmacao_id|provedor_|valor_|documento/);
});

test('D-COM-5: prazo do B-9 em −47 (margem de 14 dias antes da abertura da janela, −33) — vencido entre −47 e −44, no dia exato ainda não', async () => {
  assert.equal(b5.AVISO_DIAS + b5.ANTECIPADO_DIAS + b5.MARGEM_B9_DIAS, 47);
  const vencido = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: '2026-12-26'})]})});
  assert.equal(vencido.saida.fundador.prazoB9, '2026-11-09'); assert.ok(vencido.saida.motivos.includes('PRAZO_B9_VENCIDO'));
  assert.equal(vencido.saida.fundador.janelasPerdidas, 0); assert.equal(vencido.saida.fundador.inicioJanelaAviso, '2026-11-23');
  const noDia = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: '2026-12-27'})]})});
  assert.equal(noDia.saida.fundador.prazoB9, '2026-11-10'); assert.ok(!noDia.saida.motivos.includes('PRAZO_B9_VENCIDO'), JSON.stringify(noDia.saida.motivos));
});

test('L1 (§9.2.4): nenhuma ASAAS_* é lida, nenhum fetch; o ramo do provedor é declarado antes de conectar e registrado; conferência do provedor é separada', async () => {
  const lidas = new Set();
  const armadilha = base => new Proxy({...base, ASAAS_API_KEY: '$aact_prod_ARMADILHA', ASAAS_AMBIENTE: 'producao', ASAAS_WEBHOOK_TOKEN: 'x'}, {
    get(t, k) { lidas.add(String(k)); if (/^ASAAS/.test(String(k))) throw new Error('LEU_ASAAS ' + String(k)); return t[k]; },
    has(t, k) { lidas.add(String(k)); if (/^ASAAS/.test(String(k))) throw new Error('LEU_ASAAS ' + String(k)); return k in t; },
    ownKeys() { throw new Error('ENUMEROU_O_AMBIENTE'); }, getOwnPropertyDescriptor() { throw new Error('ENUMEROU_O_AMBIENTE'); }});
  const fetchOriginal = globalThis.fetch; let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('FETCH_PROIBIDO'); };
  try {
    for (const [argv, cfg] of [[['--conferir-b5'], {}], [['--conferir-b5-estado'], {}], [['--conferir-b5'], {concessoes: [concessao({registrada: null})]}]]) {
      const r = await rodar(argv, {env: armadilha(ENV), cliente: clienteFalso(cfg)});
      assert.ok([0, 3].includes(r.codigo), JSON.stringify(r.saida)); assert.ok(!JSON.stringify(r.saida).includes('ARMADILHA'));
    }
  } finally { globalThis.fetch = fetchOriginal; }
  assert.equal(fetches, 0);
  assert.deepEqual([...lidas].filter(k => !b5.ENV_LIDAS.includes(k)), [], 'só as variáveis da lista');
  // Ramo do provedor: obrigatório no E1, antes de conectar (Client nunca construído); E2c não pede.
  let construidos = 0;
  const C = class extends clienteFalso() { constructor() { super(); construidos++; } };
  for (const ramo of [undefined, '', 'SEM-CONTA', 'sim', 'com-conta ', 'toString', '__proto__']) {
    await assert.rejects(b5.principal(['--conferir-b5'], {...ENV, KIDMAIS_B5_RAMO_PROVEDOR: ramo}, {Client: C}), /RAMO_PROVEDOR_NAO_DECLARADO/, String(ramo));
  }
  assert.equal(construidos, 0);
  const e2c = await rodar(['--conferir-b5-estado'], {env: {...ENV, KIDMAIS_B5_RAMO_PROVEDOR: undefined}});
  assert.equal(e2c.codigo, 0);
  for (const [ramo, rotulo, texto] of [['sem-conta', 'SEM_CONTA', /declaracao de Felipe/], ['com-conta', 'COM_CONTA', /chave FORA do web/]]) {
    const r = await rodar(['--conferir-b5'], {env: {...ENV, KIDMAIS_B5_RAMO_PROVEDOR: ramo}});
    assert.equal(r.codigo, 0); assert.equal(r.saida.provedor.ramoDeclarado, rotulo); assert.match(r.saida.provedor.conferencia, texto);
    assert.equal(r.saida.provedor.chaveAsaasLida, false); assert.equal(r.saida.provedor.consultasAsaas, 0);
  }
  // O código não tem caminho de leitura do provedor (fora dos comentários).
  const fonte = fs.readFileSync(path.join(__dirname, 'conferencia-b5-producao.cjs'), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n')
    .replace(/'[^'\n]*'/g, "''");
  assert.doesNotMatch(fonte, /fetch\s*\(|ASAAS_|asaas\.com|access_token|https?:/);
});

test('falha de consulta no meio: FALHA (código 2), ROLLBACK, mensagem sem URL; plano sem conexão descreve leituras, ampliadas, matriz e nunca-executa', async () => {
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({falharEm: 'documento_beneficiario, true'})});
  assert.equal(r.codigo, 2, JSON.stringify(r.saida)); assert.equal(r.saida.resultado, 'FALHA'); assert.ok(!r.saida.mensagem.includes('SENHA_FALSA'));
  assert.ok(r.log.at(-1).sql === 'ROLLBACK');
  const p = (await b5.principal([], {})).saida;
  assert.equal(p.resultado, 'PLANO'); assert.equal(p.conecta, false); assert.deepEqual(p.excluidas, {'098': 'SEM_NUCLEO_VER_COMBINADOS'});
  assert.ok(p.nuncaExecuta.includes('leitura de ASAAS_* ou chamada ao Asaas') && p.nuncaExecuta.includes('leitura de dados da agenda (combinados: só catálogo)'));
  assert.ok(p.leituras.some(l => /combinados \(B-21\)/.test(l)) && p.paradas.some(l => /combinados \(B-21, E1 e E2c\)/.test(l)));
  assert.deepEqual(p.migracoes.map(m => m.migration), ['089', '090', '091', '092-094', '095', '096', '097', '099', '100']);
  assert.deepEqual(p.ampliadas.map(m => m.migration), ['102-103', '104-106', '105', '107-108', '109', '112', '114', '116', '117', '118', '110-111-115']);
  assert.equal(p.matriz.length, 28); assert.deepEqual(p.prefixoEsperadoAntesDoE3, {...b5.ESPERADO_BASE_ANTES_DO_E3, ...b5.ESPERADO_ANTES_DO_E3});
  assert.equal(Object.keys(p.prefixoEsperadoAntesDoE3).length, 27); assert.equal(p.prefixoEsperadoAntesDoE3['099'], 'completa');
});

test('núcleos reais (089–100 e 102–117): cada um carrega, expõe SQL_ESTADO e lerEstado e o campo que o B-5 lê; nenhum é o da 098; faixa 102–117 coberta', () => {
  for (const [rotulo, modulo, campos] of TODOS) {
    const n = require(modulo);
    assert.equal(typeof n.SQL_ESTADO, 'string', rotulo); assert.equal(typeof n.lerEstado, 'function', rotulo);
    assert.match(n.SQL_ESTADO, /papel_trocado/, rotulo);
    // Só SELECT (CREATE aparece apenas como privilégio consultado, ex.: has_schema_privilege(..., 'CREATE')).
    assert.match(n.SQL_ESTADO, /^\s*(WITH|SELECT)\b/i, rotulo); assert.doesNotMatch(n.SQL_ESTADO, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|FUNCTION|INDEX)|ALTER\s+TABLE|DROP\s+\w+|TRUNCATE\s)/i, rotulo);
    const fonte = fs.readFileSync(path.join(__dirname, modulo), 'utf8');
    for (const c of campos) assert.ok(new RegExp(`\\b${c}\\b`).test(fonte), `${rotulo} ${c}`);
    assert.ok(!modulo.includes('098'));
  }
  assert.equal(typeof require('./migration-102-103-comum.cjs').SQL_CATEGORIA_103, 'string');
  assert.deepEqual(require('./migration-114-comum.cjs').CORPOS, n114.CORPOS);
  // Cada número de 102 a 118 tem núcleo, catálogo (110, 111, 115 e 118) ou está marcado sem migration — e "sem migration" é verdade na árvore.
  const migracoes = fs.readdirSync(path.join(__dirname, '..', 'database/migrations')).map(a => a.split('_')[1]);
  const cobertos = new Set([...b5.AMPLIADAS.flatMap(([, , c]) => c.map(x => x.slice(1))), '118', '110', '111', '115', ...Object.keys(b5.SEM_MIGRATION)]);
  for (let i = 102; i <= 118; i++) assert.ok(cobertos.has(String(i)), String(i));
  for (const k of Object.keys(b5.SEM_MIGRATION)) assert.ok(!migracoes.includes(k), k);
  for (const k of Object.keys(b5.ESPERADO_ANTES_DO_E3)) assert.ok(migracoes.includes(k), k);
});

test('P2-1 da revisão: papel_trocado preservado (inclusive nos núcleos 102–117); trocado sem previsão, ilegível ou inconsistente = PARAR; previsto = passa', async () => {
  const normal = await rodar(['--conferir-b5-estado']);
  assert.equal(normal.codigo, 0); assert.equal(normal.saida.papelTrocado, false);
  const trocado = await rodar(['--conferir-b5-estado'], {estados: {papel_trocado: true}});
  assert.equal(trocado.codigo, 3); assert.equal(trocado.saida.papelTrocado, true); assert.match(trocado.saida.motivos.join(' '), /PAPEL_TROCADO_INESPERADO/);
  const previsto = await rodar(['--conferir-b5-estado'], {estados: {papel_trocado: true}, env: {...ENV, KIDMAIS_B5_PAPEL_TROCADO_ESPERADO: 'sim'}});
  assert.equal(previsto.codigo, 0, JSON.stringify(previsto.saida)); assert.equal(previsto.saida.papelTrocado, true);
  const naoVeio = await rodar(['--conferir-b5-estado'], {env: {...ENV, KIDMAIS_B5_PAPEL_TROCADO_ESPERADO: 'sim'}});
  assert.equal(naoVeio.codigo, 3); assert.match(naoVeio.saida.motivos.join(' '), /PAPEL_TROCADO_ESPERADO_MAS_AUSENTE/);
  for (const estados of [{papelPor: {'095': true}}, {papelPor: {'099': 'x'}}, {ilegivel097: true}, {papelPor: {'116': true}}, {papelPor: {'109': undefined}}]) {
    const r = await rodar(['--conferir-b5'], {estados});
    assert.equal(r.codigo, 3, JSON.stringify(estados)); assert.equal(r.saida.papelTrocado, 'INCONSISTENTE'); assert.match(r.saida.motivos.join(' '), /PAPEL_TROCADO_ILEGIVEL_OU_INCONSISTENTE/);
  }
});

test('P3 da revisão: erros só com códigos conhecidos — e-mail, URL, id e usuário nunca saem; erro do servidor vira ERRO_INESPERADO com SQLSTATE', async () => {
  const C = clienteFalso();
  const D = class extends C {
    async query(sql, p) {
      if (sql === b5.SQL_DOCUMENTOS) throw Object.assign(new Error('password authentication failed for user "fulano@exemplo.com" pay_1 https://api.asaas.com/v3/x'), {code: '28P01'});
      return super.query(sql, p);
    }
  };
  D.log = C.log;
  const r = await rodar(['--conferir-b5'], {cliente: D});
  assert.equal(r.codigo, 2); assert.equal(r.saida.mensagem, 'ERRO_INESPERADO SQLSTATE 28P01');
  const t = JSON.stringify(r.saida);
  for (const proibido of ['fulano', '@', 'https', 'pay_1', 'asaas.com']) assert.ok(!t.includes(proibido), proibido);
  const outro = await rodar(['--conferir-b5'], {cliente: clienteFalso({identidade: {...ID, db: 'outro'}})});
  assert.equal(outro.saida.mensagem, 'BANCO_DIVERGENTE');
});

test('P3 da re-revisão: só a lista fechada de códigos sai; texto externo com cara de código vira ERRO_INESPERADO; bijeção com o que as travas lançam', async () => {
  for (const mensagem of ['FALHA pay_SONDA_SINTETICA', 'ERRO 12345678901', 'CODIGO_INVENTADO', 'BANCO_DIVERGENTE pay_1', 'FORA_DO_RENDER ', ' FORA_DO_RENDER',
    'ESTADO_ILEGIVEL 095', 'ASAAS_HTTP_404', 'ASAAS_CHAVE_RECUSADA', 'MATRIZ_ILEGIVEL x', 'TLS_OBRIGATORIO\nfulano@exemplo.com']) {
    const C0 = clienteFalso();
    const C = class extends C0 { async query(sql, p) { if (sql === b5.SQL_DOCUMENTOS) throw new Error(mensagem); return super.query(sql, p); } };
    C.log = C0.log;
    const r = await rodar(['--conferir-b5'], {cliente: C});
    assert.equal(r.codigo, 2, mensagem); assert.equal(r.saida.mensagem, 'ERRO_INESPERADO', JSON.stringify(mensagem));
  }
  for (const [code, esperado] of [['57014', 'ERRO_INESPERADO SQLSTATE 57014'], ['42P01', 'ERRO_INESPERADO SQLSTATE 42P01'], ['ECONNRESET', 'ERRO_INESPERADO'],
    ['pay_1', 'ERRO_INESPERADO'], ['1234', 'ERRO_INESPERADO'], [undefined, 'ERRO_INESPERADO']])
    assert.equal(b5.curta(Object.assign(new Error('qualquer coisa fulano@exemplo.com'), {code})), esperado, String(code));
  for (const c of b5.CODIGOS_PUBLICOS) { assert.match(c, /^[A-Z][A-Z0-9_]+$/); assert.equal(b5.curta(new Error(c)), c); }
  const lancados = new Set();
  const tentar = f => { try { f(); } catch (e) { lancados.add(e.message); } };
  const tentarAsync = async f => { try { await f(); } catch (e) { lancados.add(e.message); } };
  for (const delta of [{RENDER: undefined}, {RENDER_SERVICE_ID: 'x'}, {KIDMAIS_DEPLOY_ENV: 'staging'}, {DATABASE_SSL: 'false'}, {DATABASE_URL: 'nao-e-url'},
    {DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'outro')}, {DATABASE_URL: URL_PROD.replace('kidmais_production', 'x')},
    {DATABASE_URL: URL_PROD.replace(':5432', ':1')}, {DATABASE_URL: URL_PROD + '?a=b'}]) tentar(() => prod.alvo({...ENV, ...delta}));
  for (const delta of [{db: 'x'}, {tls: false}, {tls_versao: 'TLSv1.1'}, {servidor_privado: false}]) tentar(() => prod.identidade({...ID, ...delta}));
  tentar(() => b5.modo(['--x'])); tentar(() => b5.inventarioDocumentos([{origem: 'outra'}])); tentar(() => b5.inventarioOrigens([{origem: 'outra'}]));
  tentar(() => b5.lerEstado118({})); tentar(() => b5.lerEstadoSatisfacao({})); tentar(() => b5.sqlContagem('A'));
  await tentarAsync(() => b5.principal(['--conferir-b5'], {...ENV, KIDMAIS_B5_RAMO_PROVEDOR: undefined}, {}));
  await tentarAsync(() => b5.carregarContrato109(path.resolve(__dirname, '..'), async () => { throw new Error('x'); }));
  await tentarAsync(() => b5.carregarContrato109(os.tmpdir()));
  tentar(() => b5.sqlIntegridade105(os.tmpdir()));
  const fundadorIlegivel = await rodar(['--conferir-b5'], {cliente: clienteFalso({total: 'x'})});
  assert.equal(fundadorIlegivel.codigo, 2); lancados.add(fundadorIlegivel.saida.mensagem);
  const b15Ilegivel = await rodar(['--conferir-b5'], {cliente: clienteFalso({compat: {...COMPAT, checks: 'x'}})});
  lancados.add(b15Ilegivel.saida.mensagem);
  assert.deepEqual([...lancados].sort(), [...b5.CODIGOS_PUBLICOS].sort());
});

test('revisão Astra r2, A: 105 "completa" por presença só passa com a integridade de catálogo do aplicador e o índice único parcial válido', async () => {
  // A integridade é o arquivo revisado do próprio aplicador (sha256 de ETAPAS), lida só do catálogo.
  const n105 = require('./migration-105-comum.cjs');
  assert.deepEqual(b5.INTEGRIDADE_105, n105.ETAPAS.find(e => e[0] === 'integridade 105'));
  assert.match(SQL_INT105, /mcp_oauth_concessoes_ativa_uk/); assert.match(SQL_INT105, /t\.tgrelid = to_regclass\('public\.mcp_oauth_concessoes'\)/);
  assert.doesNotMatch(SQL_INT105.replace(/--.*$/gm, ''), /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.match(b5.SQL_ESTRUTURA_105, /indisvalid AND i\.indisready AND i\.indislive/);
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    const ok = await rodar(argv);
    assert.equal(ok.codigo, 0, JSON.stringify(ok.saida.motivos)); assert.equal(ok.saida.ampliados['105'], 'completa');
    const ro = ok.log.filter(x => x.sql === SQL_INT105 || x.sql === b5.SQL_ESTRUTURA_105);
    assert.equal(ro.length, 2); assert.ok(ro.every(x => x.ro && /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/.test(x.iso)), 'mesma fotografia REPEATABLE READ READ ONLY');
    for (const cfg of [{integra105: false}, {estrutura105: {indice_flags: false}}]) {
      const r = await rodar(argv, {cliente: clienteFalso(cfg)});
      assert.equal(r.codigo, 3, JSON.stringify(cfg)); assert.deepEqual(r.saida.motivos, ['PREFIXO_DIVERGENTE 105:incompleta (esperado completa)']);
    }
    for (const cfg of [{integra105: null}, {estrutura105: {indice_flags: 'true'}}, {estrutura105: {gatilhos: '1'}}, {estrutura105: {indice_def: 1}}]) {
      const r = await rodar(argv, {cliente: clienteFalso(cfg)});
      assert.equal(r.codigo, 3); assert.ok(r.saida.motivos.includes('ESTADO_ILEGIVEL 105'), JSON.stringify(r.saida.motivos));
    }
    // 105 ausente ou parcial: a integridade não roda.
    const aus = await rodar(argv, {estados: {m105: 'ausente'}});
    assert.ok(!aus.log.some(x => x.sql === SQL_INT105)); assert.ok(aus.saida.motivos.includes('PREFIXO_DIVERGENTE 105:ausente (esperado completa)'));
  }
  // O núcleo real da 105, com a linha de presença completa, passa a depender da integridade (o falso aceite da r2).
  const linha = {versao_pg: 180006, d105: true, m105_tabelas: 6, m105_funcao: 1, m105_gatilho: 1, usar_public: true, pode_criar: false, referencias_105: true,
    plpgsql: true, gerar_uuid: true, ler_105: true, papel_trocado: false};
  for (const [integra, valido, esperado] of [[true, true, 'completa'], [false, true, 'incompleta'], [true, false, 'incompleta']]) {
    const db = {query: async sql => sql === n105.SQL_ESTADO ? {rows: [linha]} : sql === SQL_INT105 ? {rows: [{integra_105: integra}]}
      : sql === b5.SQL_ESTRUTURA_105 ? {rows: [{...ESTRUTURA_105, indice_flags: valido}]} : sql === b5.SQL_RELACAO_105 ? {rows: [{relacao: b5.RELACAO_105}]} : {rows: []}};
    assert.equal((await b5.lerNucleo(db, '105', n105, {})).m105, esperado);
  }
});

test('revisão Astra r2, C: CHECKs da base pela definição INTEIRA (pg_get_constraintdef(oid, false), PG 18); negação da regex ou lista ampliada = DIVERGENTE', async () => {
  assert.match(b5.SQL_CHECKS_091, /pg_get_constraintdef\(c\.oid, false\)/);
  const casos = [['solicitacoes_documento_check', DEF.solicitacoes_documento_check.replace(' ~ ', ' !~ ')],
    ['cadastros_empresas_documento_check', DEF.cadastros_empresas_documento_check.replace(' ~ ', ' ~* ')],
    ['empresa_representacoes_qualificacao_check', DEF.empresa_representacoes_qualificacao_check.replace("'RESPONSAVEL_INDICADO'::text", "'RESPONSAVEL_INDICADO'::text, 'OUTRA'::text")],
    ['empresa_assinaturas_documento_teste_check', DEF.empresa_assinaturas_documento_teste_check.replace(' OR ', ' AND ')],
    ['assinatura_fundadores_documento_beneficiario_check', DEF.assinatura_fundadores_documento_beneficiario_check + ' NOT VALID']];
  for (const [nome, definicao] of casos) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({checks091: checksBase({[nome]: {definicao}})})});
    assert.equal(r.codigo, 3, nome); assert.deepEqual(r.saida.motivos, ['B15_091_CHECK_BASE_DIVERGENTE ' + nome]);
    assert.equal(r.saida.b15.compatibilidade091.precheckEstrutural, 'PASSARIA', 'o espelho literal continua PASSARIA; a definição para');
  }
  // CHECKs e versão lidos na mesma transação READ ONLY, com search_path fixo.
  const ok = await rodar(['--conferir-b5']);
  const i = ok.log.findIndex(x => x.sql === b5.SQL_CHECKS_091);
  assert.equal(ok.log[i - 1].sql, 'SET LOCAL search_path = public, pg_catalog'); assert.equal(ok.log[i + 1].sql, b5.SQL_VERSAO_PG); assert.ok(ok.log[i].ro && ok.log[i + 1].ro);
  // Outra versão maior: sem referência = PARAR, sem julgar a definição.
  for (const versaoPg of [170005, 190000]) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({versaoPg, checks091: checksBase({solicitacoes_documento_check: {definicao: 'x'}})})});
    assert.equal(r.codigo, 3); assert.deepEqual(r.saida.motivos, ['B15_091_DEFINICAO_SEM_REFERENCIA_PG ' + versaoPg]);
    assert.equal(r.saida.b15.compatibilidade091.checksDaBasePorRelacao, 'SEM_REFERENCIA_PG_' + Math.floor(versaoPg / 10000));
  }
  for (const versaoPg of [null, '180006', 0]) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({versaoPg})});
    assert.equal(r.codigo, 2); assert.equal(r.saida.mensagem, 'B15_CATALOGO_ILEGIVEL');
  }
});

test('revisão Astra r2, F: RLS sem bypass não conta (matriz INDETERMINADA) nem lê legado ou Fundador; parada nomeada, nunca zero nem erro genérico', async () => {
  const cat = catalogoMatriz({empresa_assinaturas: {rls: true}});
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({catalogo: cat, visib: {empresa_assinaturas: {rls: true}}})});
  assert.equal(r.codigo, 3);
  assert.deepEqual(r.saida.motivos, ['MATRIZ_RLS_PODE_INDUZIR_ZERO empresa_assinaturas', 'B15_LEGADO_RLS_PODE_INDUZIR_ZERO empresa_assinaturas',
    'FUNDADOR_RLS_PODE_INDUZIR_ZERO empresa_assinaturas']);
  const o = r.saida.matriz.objetos.empresa_assinaturas;
  assert.equal(o.linhas, null); assert.equal(o.contagem, 'INDETERMINADA_RLS');
  assert.ok(!r.log.some(x => x.sql === b5.sqlContagem('empresa_assinaturas')), 'sem count(*) sob RLS');
  assert.ok(!r.log.some(x => x.sql === b5.SQL_DOCUMENTOS), 'sem leitura de documentos');
  assert.ok(!r.log.some(x => x.sql === b5.SQL_TOTAL_CONFIRMADAS), 'sem leitura do Fundador');
  assert.equal(r.saida.b15.legado, null); assert.equal(r.saida.b15.inventarioLegado, 'INDETERMINADO'); assert.match(r.saida.b15.provaArtificialDocumentoLegado, /^INDETERMINADA/);
  assert.match(r.saida.fundador.ramo, /^INDETERMINADO/); assert.equal(r.saida.fundador.confirmadas, null);
  // Superusuário ou BYPASSRLS: conta normalmente.
  const bypass = await rodar(['--conferir-b5'], {cliente: clienteFalso({catalogo: cat, papel: {superusuario: false, ignora_rls: true},
    visib: {empresa_assinaturas: {rls: true, ignora_rls: true}}})});
  assert.equal(bypass.codigo, 0, JSON.stringify(bypass.saida.motivos)); assert.equal(bypass.saida.matriz.objetos.empresa_assinaturas.linhas, 0);
  // Sem privilégio em uma relação do legado ou do Fundador: parada nomeada (não um erro genérico de leitura).
  for (const [visib, motivos] of [[{assinatura_fundadores: {ler: false}}, ['B15_LEGADO_SEM_PRIVILEGIO_LEITURA assinatura_fundadores', 'FUNDADOR_SEM_PRIVILEGIO_LEITURA assinatura_fundadores']],
    [{assinatura_contratacoes: {rls: true}}, ['FUNDADOR_RLS_PODE_INDUZIR_ZERO assinatura_contratacoes']],
    [{assinatura_renovacoes: {ler: false}}, ['FUNDADOR_CONFIRMADAS_RAMO_COM_DADOS_NAO_LIDO']]]) {
    const c = clienteFalso({visib, concessoes: [concessao()]});
    const x = await rodar(['--conferir-b5'], {cliente: c});
    assert.equal(x.codigo, 3, JSON.stringify(visib));
    if (motivos[0] === 'FUNDADOR_CONFIRMADAS_RAMO_COM_DADOS_NAO_LIDO') {
      assert.deepEqual(x.saida.motivos, ['FUNDADOR_SEM_PRIVILEGIO_LEITURA assinatura_renovacoes']); assert.equal(x.saida.fundador.confirmadas, 1);
      assert.ok(!x.log.some(l => l.sql === b5.sqlConcessoes(true)));
    } else assert.deepEqual(x.saida.motivos, motivos);
  }
});

test('revisão Astra r3, A: 105 pela definição — predicado invertido, chaves trocadas, função homônima, WHEN, UPDATE OF ou gatilho duplicado = incompleta', async () => {
  // As referências vêm do texto da migration (CREATE UNIQUE INDEX … WHERE revogada_em IS NULL; CREATE TRIGGER … EXECUTE FUNCTION public.…).
  const mig = fs.readFileSync(path.join(__dirname, '..', 'database/migrations/20261027_105_mcp_assinaturas.sql'), 'utf8');
  assert.ok(mig.includes('CREATE UNIQUE INDEX mcp_oauth_concessoes_ativa_uk ON public.mcp_oauth_concessoes (usuario_id, empresa_id, client_id) WHERE revogada_em IS NULL;'));
  assert.ok(mig.includes('CREATE TRIGGER mcp_oauth_concessoes_revogacao_imutavel BEFORE UPDATE ON public.mcp_oauth_concessoes\n  FOR EACH ROW EXECUTE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel();')
    || mig.includes('CREATE TRIGGER mcp_oauth_concessoes_revogacao_imutavel BEFORE UPDATE ON public.mcp_oauth_concessoes\r\n  FOR EACH ROW EXECUTE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel();'));
  assert.match(b5.INDICE_105_DEF, /\(usuario_id, empresa_id, client_id\) WHERE \(revogada_em IS NULL\)$/);
  assert.match(b5.SQL_ESTRUTURA_105, /t\.tgfoid = p\.oid AND t\.tgqual IS NULL/); assert.match(b5.SQL_ESTRUTURA_105, /to_regprocedure\('public\.mcp_oauth_concessao_revogacao_imutavel\(\)'\)/);
  assert.ok(b5.SQL_ESTRUTURA_105.includes(b5.CORPO_105));
  const derivas = [{indice_def: b5.INDICE_105_DEF.replace('IS NULL', 'IS NOT NULL')}, {indice_def: b5.INDICE_105_DEF.replace('client_id', 'cliente_nome')},
    {indice_def: null}, {gatilho_def: b5.GATILHO_105_DEF.replace('EXECUTE FUNCTION mcp_', 'EXECUTE FUNCTION outro.mcp_')}, {gatilho_funcao: false},
    {gatilho_def: b5.GATILHO_105_DEF.replace('FOR EACH ROW', 'FOR EACH ROW WHEN ((old.revogada_em IS NULL))')},
    {gatilho_def: b5.GATILHO_105_DEF.replace('BEFORE UPDATE ON', 'BEFORE UPDATE OF ultimo_uso_em ON')}, {gatilhos: 2}, {gatilho_def: null}];
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    for (const estrutura105 of derivas) {
      const r = await rodar(argv, {cliente: clienteFalso({estrutura105})});
      assert.equal(r.codigo, 3, JSON.stringify(estrutura105)); assert.deepEqual(r.saida.motivos, ['PREFIXO_DIVERGENTE 105:incompleta (esperado completa)']);
    }
  }
});

test('revisão Astra r3, C: a sentinela da 103 só é lida com tipo, privilégio e RLS conferidos; linha oculta por RLS nunca vira ausente', async () => {
  const ler = {estados: {d103: true, ler_103: true, m103: 'ausente'}};
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    const ok = await rodar(argv, {...ler, cliente: clienteFalso()});
    assert.equal(ok.codigo, 0, JSON.stringify(ok.saida.motivos)); assert.ok(ok.log.some(x => x.sql === 'CATEGORIA 103'));
    for (const [aj, motivo] of [[{rls: true}, 'M103_RLS_PODE_INDUZIR_ZERO adicional_categorias'], [{ler: false}, 'M103_SEM_PRIVILEGIO_LEITURA adicional_categorias'],
      [{tipo: 'v'}, 'M103_NAO_E_TABELA adicional_categorias'], [{presente: false}, 'M103_AUSENTES adicional_categorias']]) {
      const c = clienteFalso({visib: {adicional_categorias: aj}});
      const r = await rodar(argv, {...ler, cliente: c});
      assert.equal(r.codigo, 3, motivo); assert.deepEqual(r.saida.motivos, [motivo, 'PREFIXO_DIVERGENTE 103:indeterminada (esperado ausente)']);
      assert.ok(!r.log.some(x => x.sql === 'CATEGORIA 103'), 'sem leitura da linha SERVICOS');
    }
    const bypass = await rodar(argv, {...ler, cliente: clienteFalso({visib: {adicional_categorias: {rls: true, ignora_rls: true}}})});
    assert.equal(bypass.codigo, 0, JSON.stringify(bypass.saida.motivos));
  }
});

test('revisão Astra r3, F: Fundador lê só relações de public (nada sem esquema) e as guardas exigem tabela; rótulo diz o que foi lido', async () => {
  for (const sql of [b5.SQL_TOTAL_CONFIRMADAS, b5.sqlConcessoes(true), b5.sqlConcessoes(false), b5.SQL_DOCUMENTOS, b5.SQL_ORIGENS_091]) {
    const semEsquema = sql.match(/\b(FROM|JOIN)\s+(?!public\.|unnest\b)[a-z_]+/g);
    assert.equal(semEsquema, null, sql.slice(0, 60));
  }
  for (const [visib, motivos] of [[{assinatura_contratacoes: {tipo: 'v'}}, ['FUNDADOR_NAO_E_TABELA assinatura_contratacoes']],
    [{empresa_assinaturas: {tipo: 'v'}}, ['B15_LEGADO_NAO_E_TABELA empresa_assinaturas', 'FUNDADOR_NAO_E_TABELA empresa_assinaturas']],
    [{plataforma_empresas_cadastro: {tipo: 'm'}}, null]]) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({visib, origensCat: origensCatalogo(visib)})});
    assert.equal(r.codigo, 3);
    assert.deepEqual(r.saida.motivos, motivos ?? ['B15_ORIGEM_NAO_E_TABELA plataforma_empresas_cadastro']);
  }
  const ren = await rodar(['--conferir-b5'], {cliente: clienteFalso({visib: {assinatura_renovacoes: {rls: true}}, concessoes: [concessao()]})});
  assert.match(ren.saida.fundador.ramo, /datas nao lidas: assinatura_renovacoes .*so o total foi lido/); assert.equal(ren.saida.fundador.confirmadas, 1);
});

test('revisão Astra r4, A: 105 com coluna de identidade anulável (ou NOT NULL não validado) = incompleta nos dois modos', async () => {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'database/migrations/20261027_105_mcp_assinaturas.sql'), 'utf8').split('\r\n').join('\n');
  const tabela = mig.slice(mig.indexOf('CREATE TABLE public.mcp_oauth_concessoes ('), mig.indexOf('\n);', mig.indexOf('CREATE TABLE public.mcp_oauth_concessoes (')));
  const naoNulas = tabela.split('\n').map(l => /^  ([a-z_]+) [a-z\[\]]+ (NOT NULL|PRIMARY KEY)/.exec(l)?.[1]).filter(Boolean).sort().join(',');
  assert.equal(naoNulas, b5.NAO_NULAS_105, 'conjunto NOT NULL da migration');
  assert.match(b5.SQL_ESTRUTURA_105, /a\.attnotnull/); assert.match(b5.SQL_ESTRUTURA_105, /n\.contype = 'n' AND n\.conkey = ARRAY\[a\.attnum\] AND n\.convalidated/);
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    for (const nao_nulas of [b5.NAO_NULAS_105.replace('empresa_id,', ''), b5.NAO_NULAS_105.replace('usuario_id', 'x').replace(',x', ''), null,
      b5.NAO_NULAS_105 + ',revogada_em']) {
      const r = await rodar(argv, {cliente: clienteFalso({estrutura105: {nao_nulas}})});
      assert.equal(r.codigo, 3, String(nao_nulas)); assert.deepEqual(r.saida.motivos, ['PREFIXO_DIVERGENTE 105:incompleta (esperado completa)']);
    }
    const ileg = await rodar(argv, {cliente: clienteFalso({estrutura105: {nao_nulas: 1}})});
    assert.equal(ileg.codigo, 3); assert.ok(ileg.saida.motivos.some(m => /^ESTADO_ILEGIVEL 105/.test(m)), JSON.stringify(ileg.saida.motivos));
  }
});

test('revisão Astra r4, B: falta de dependência ou de SELECT já no primeiro retrato = 103 indeterminada com motivo M103_*', async () => {
  const P = 'PREFIXO_DIVERGENTE 103:indeterminada (esperado ausente)';
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    for (const [estados, visib, motivos] of [
      [{ler_103: false}, {adicional_categorias: {ler: false}}, ['M103_SEM_PRIVILEGIO_LEITURA adicional_categorias']],
      [{ler_103: false}, {}, ['M103_SEM_PRIVILEGIO_LEITURA adicional_categorias']],
      [{d103: false, ler_103: false}, {adicional_categorias: {presente: false, ler: false}}, ['M103_DEPENDENCIA_AUSENTE', 'M103_AUSENTES adicional_categorias']],
      [{d103: false}, {adicionais: {presente: false}}, ['M103_DEPENDENCIA_AUSENTE', 'M103_AUSENTES adicionais']],
      [{d103: false}, {adicionais: {tipo: 'v'}}, ['M103_DEPENDENCIA_AUSENTE', 'M103_NAO_E_TABELA adicionais']],
      [{d103: false}, {}, ['M103_DEPENDENCIA_AUSENTE']],
      // r5 (B): RLS no segundo retrato não apaga o motivo do primeiro; view estável em adicionais com d103/ler_103 verdadeiros.
      [{ler_103: false}, {adicional_categorias: {rls: true}}, ['M103_SEM_PRIVILEGIO_LEITURA adicional_categorias', 'M103_RLS_PODE_INDUZIR_ZERO adicional_categorias']],
      [{d103: false}, {adicional_categorias: {rls: true}}, ['M103_DEPENDENCIA_AUSENTE', 'M103_RLS_PODE_INDUZIR_ZERO adicional_categorias']],
      [{}, {adicionais: {tipo: 'v'}}, ['M103_NAO_E_TABELA adicionais']],
      [{}, {adicionais: {tipo: 'm'}}, ['M103_NAO_E_TABELA adicionais']],
      [{}, {adicionais: {presente: false}}, ['M103_AUSENTES adicionais']]]) {
      const r = await rodar(argv, {estados, cliente: clienteFalso({visib})});
      const motivo = JSON.stringify(motivos);
      assert.equal(r.codigo, 3, motivo); assert.deepEqual(r.saida.motivos, [...motivos, P]);
      assert.ok(!r.log.some(x => x.sql === 'CATEGORIA 103'), 'sem leitura da linha SERVICOS');
    }
    // RLS ou falta de SELECT em adicionais não afetam a sentinela (só presença e tipo dela entram na dependência).
    const ok = await rodar(argv, {cliente: clienteFalso({visib: {adicionais: {rls: true, ler: false}}})});
    assert.equal(ok.codigo, 0, JSON.stringify(ok.saida.motivos));
  }
});

test('revisão Astra r5, A: gatilho a mais na relação, regra, ou NOT NULL extra (mesmo não validado) = 105 incompleta nos dois modos', async () => {
  assert.match(b5.SQL_ESTRUTURA_105, /t\.tgrelid = to_regclass\('public\.mcp_oauth_concessoes'\) AND NOT t\.tgisinternal\)::int AS gatilhos_relacao/);
  assert.match(b5.SQL_ESTRUTURA_105, /pg_rewrite r WHERE r\.ev_class = to_regclass\('public\.mcp_oauth_concessoes'\)/);
  assert.match(b5.SQL_ESTRUTURA_105, /a\.attnotnull OR EXISTS \(SELECT 1 FROM pg_constraint n WHERE n\.conrelid = a\.attrelid AND n\.contype = 'n' AND a\.attnum = ANY \(n\.conkey\)\)/);
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    for (const estrutura105 of [{gatilhos_relacao: 2}, {gatilhos_relacao: 0}, {regras: 1}, {nao_nulas_declaradas: b5.NAO_NULAS_105 + ',revogada_em'},
      {nao_nulas_declaradas: null}]) {
      const r = await rodar(argv, {cliente: clienteFalso({estrutura105})});
      assert.equal(r.codigo, 3, JSON.stringify(estrutura105)); assert.deepEqual(r.saida.motivos, ['PREFIXO_DIVERGENTE 105:incompleta (esperado completa)']);
    }
    for (const estrutura105 of [{gatilhos_relacao: '1'}, {regras: null}, {nao_nulas_declaradas: 7}]) {
      const r = await rodar(argv, {cliente: clienteFalso({estrutura105})});
      assert.equal(r.codigo, 3); assert.ok(r.saida.motivos.some(m => /^ESTADO_ILEGIVEL 105/.test(m)), JSON.stringify(r.saida.motivos));
    }
  }
});

test('revisão Astra r6, A: impressão digital das colunas da 105 — coluna gerada, identity, default, tipo, collation ou ordem = incompleta', async () => {
  // A referência bate com a migration: mesmos nomes, na ordem, com os tipos e o NOT NULL declarados; nenhuma gerada.
  const mig = fs.readFileSync(path.join(__dirname, '..', 'database/migrations/20261027_105_mcp_assinaturas.sql'), 'utf8').split('\r\n').join('\n');
  const ini = mig.indexOf('CREATE TABLE public.mcp_oauth_concessoes (');
  const linhas = mig.slice(ini, mig.indexOf('\n);', ini)).split('\n').slice(1).filter(l => /^  [a-z_]+ /.test(l) && !/^  CHECK/.test(l));
  const ref = b5.COLUNAS_105.split('; ');
  assert.deepEqual(ref.map(c => c.split(' ')[0]), linhas.map(l => l.trim().split(' ')[0]));
  for (const c of ref) assert.doesNotMatch(c, / GENERATED | IDENTITY | COLLATE /, c);
  assert.deepEqual(ref.filter(c => c.includes(' NOT NULL')).map(c => c.split(' ')[0]).sort().join(','), b5.NAO_NULAS_105);
  assert.match(b5.SQL_ESTRUTURA_105, /a\.attgenerated::text <> ''/); assert.match(b5.SQL_ESTRUTURA_105, /a\.attidentity::text <> ''/);
  assert.match(b5.SQL_ESTRUTURA_105, /pg_get_expr\(d\.adbin, d\.adrelid\)/); assert.match(b5.SQL_ESTRUTURA_105, /ORDER BY a\.attnum\)/);
  const emp = ref.find(c => c.startsWith('empresa_id '));
  const derivas = [ref.map(c => c === emp ? emp + ' GENERATED s DEFAULT ' + "'00000000-0000-0000-0000-000000000000'::uuid" : c),
    ref.map(c => c === emp ? emp + ' IDENTITY a' : c), ref.map(c => c.startsWith('criada_em ') ? c.replace(/ DEFAULT .*$/, ' DEFAULT now()') : c),
    ref.map(c => c.startsWith('cliente_nome ') ? c + ' COLLATE "C"' : c), [...ref.filter(c => c !== emp), emp], ref.map(c => c === emp ? c.replace(' uuid', ' text') : c)]
    .map(x => x.join('; ')).concat([null]);
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    for (const colunas of derivas) {
      const r = await rodar(argv, {cliente: clienteFalso({estrutura105: {colunas}})});
      assert.equal(r.codigo, 3, String(colunas)); assert.deepEqual(r.saida.motivos, ['PREFIXO_DIVERGENTE 105:incompleta (esperado completa)']);
    }
    const ileg = await rodar(argv, {cliente: clienteFalso({estrutura105: {colunas: ['x']}})});
    assert.equal(ileg.codigo, 3); assert.ok(ileg.saida.motivos.some(m => /^ESTADO_ILEGIVEL 105/.test(m)));
  }
});

test('revisão Astra r7/r8: catálogo da relação 105, com as FKs de entrada — herança, RLS, política, restrição, índice, gatilho, coluna ou função fora da referência = incompleta', async () => {
  // A referência cobre a migration: todas as restrições de mcp_oauth_concessoes (6 CHECKs, 4 FKs, PK, 9 NOT NULL), os 4 índices,
  // a guarda qualificada, sem herança, sem RLS, sem política e a função sem configuração.
  const ref = b5.RELACAO_105.split('\n');
  assert.deepEqual([...ref].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), ref, 'ordem COLLATE "C"');
  for (const l of ['heranca 0', 'politicas 0', 'classe r p heap rls f f replica d particao f opcoes -', 'funcao - f f v u f f']) assert.ok(ref.includes(l), l);
  assert.equal(ref.filter(l => / c t f f t f true CHECK /.test(l)).length, 6); assert.equal(ref.filter(l => l.startsWith('restricao public.mcp_oauth_concessoes ') && / f t f f t t true FOREIGN KEY /.test(l)).length, 4);
  // Revisão Astra r8 (P2): as FKs de ENTRADA (códigos e tokens → concessões), pela origem, flags e definição, e os gatilhos
  // internos delas com a relação da restrição, a outra relação e o adiamento.
  for (const t of ['codigos', 'tokens']) {
    assert.ok(ref.includes(`restricao public.mcp_oauth_${t} mcp_oauth_${t}_concessao_id_fkey f t f f t t true FOREIGN KEY (concessao_id) REFERENCES public.mcp_oauth_concessoes(id)`), t);
    for (const [fn, tipo] of [['del', 9], ['upd', 17]]) assert.ok(ref.includes(`gatilho interno public.mcp_oauth_${t} mcp_oauth_${t}_concessao_id_fkey "RI_FKey_noaction_${fn}" ${tipo} public.mcp_oauth_${t} f f O`), t + fn);
  }
  assert.equal(ref.filter(l => l.startsWith('restricao ')).length, 22); assert.equal(ref.filter(l => l.startsWith('gatilho interno ')).length, 12);
  assert.deepEqual(ref.filter(l => / n t f f t f true NOT NULL /.test(l)).map(l => l.split(' ').at(-1)).sort().join(','), b5.NAO_NULAS_105);
  assert.equal(ref.filter(l => l.startsWith('indice ')).length, 4); assert.ok(ref.includes('restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_pkey p t f f t t true PRIMARY KEY (id)'));
  assert.ok(ref.includes('restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_cliente_nome_check c t f f t f true CHECK ((length(cliente_nome) <= 120))'));
  assert.ok(ref.includes('gatilho ' + b5.GATILHO_105_DEF.replace('FUNCTION mcp_', 'FUNCTION public.mcp_') + ' O'));
  assert.ok(ref.filter(l => l.startsWith('gatilho ')).every(l => l.endsWith(' O')));
  assert.deepEqual(ref.filter(l => l.startsWith('coluna ')).map(l => l.split(' ')[2]), b5.COLUNAS_105.split('; ').map(c => c.split(' ')[0]));
  assert.match(b5.SQL_RELACAO_105, /to_regclass\('public\.mcp_oauth_concessoes'\) IN \(h\.inhparent, h\.inhrelid\)/);
  assert.match(b5.SQL_RELACAO_105, /pg_policy p WHERE p\.polrelid/); assert.match(b5.SQL_RELACAO_105, /p\.proconfig/);
  assert.match(b5.SQL_RELACAO_105, /pg_constraint k WHERE to_regclass\('public\.mcp_oauth_concessoes'\) IN \(k\.conrelid, k\.confrelid\)\n/);
  assert.match(b5.SQL_RELACAO_105, /t\.tgconstrrelid::regclass, t\.tgdeferrable, t\.tginitdeferred/);
  assert.match(b5.SQL_RELACAO_105, /'restricao', k\.conrelid::regclass, k\.conname/);
  assert.match(b5.SQL_RELACAO_105, /'interno', coalesce\(k\.conrelid::regclass::text, '-'\), coalesce\(k\.conname::text, '-'\)/);
  assert.match(b5.SQL_RELACAO_105, /ORDER BY x COLLATE "C"/); assert.match(b5.SQL_ESTRUTURA_105, /ORDER BY a\.attname::text COLLATE "C"\) FROM pg_attribute a\n    WHERE[^\n]*a\.attnotnull/);
  const troca = (de, para) => { assert.ok(ref.includes(de), de); return ref.map(l => (l === de ? para : l)).join('\n'); };
  const mais = l => [...ref, l].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n');
  const derivas = [troca('heranca 0', 'heranca 1'), troca('politicas 0', 'politicas 1'),
    troca('classe r p heap rls f f replica d particao f opcoes -', 'classe r p heap rls t t replica d particao f opcoes -'),
    troca('restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_cliente_nome_check c t f f t f true CHECK ((length(cliente_nome) <= 120))',
      'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_cliente_nome_check c f f f t f true CHECK ((length(cliente_nome) <= 119))'),
    troca('restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_empresa_id_fkey f t f f t t true FOREIGN KEY (empresa_id) REFERENCES public.empresas(id)',
      'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_empresa_id_fkey f t f f t t true FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE'),
    // r8 (P2): FK de entrada adiável e FK de entrada com outra coluna de origem.
    troca('restricao public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey f t f f t t true FOREIGN KEY (concessao_id) REFERENCES public.mcp_oauth_concessoes(id)',
      'restricao public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey f t t t t t true FOREIGN KEY (concessao_id) REFERENCES public.mcp_oauth_concessoes(id) DEFERRABLE INITIALLY DEFERRED'),
    troca('gatilho interno public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey "RI_FKey_noaction_del" 9 public.mcp_oauth_codigos f f O',
      'gatilho interno public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey "RI_FKey_noaction_del" 9 public.mcp_oauth_codigos t t O'),
    troca('restricao public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey f t f f t t true FOREIGN KEY (concessao_id) REFERENCES public.mcp_oauth_concessoes(id)',
      'restricao public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey f t f f t t true FOREIGN KEY (id) REFERENCES public.mcp_oauth_concessoes(id)'),
    troca('gatilho interno public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey "RI_FKey_noaction_upd" 17 public.mcp_oauth_tokens f f O',
      'gatilho interno public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey "RI_FKey_noaction_upd" 17 public.mcp_oauth_outra f f O'),
    ref.filter(l => !l.includes('mcp_oauth_tokens_concessao_id_fkey')).join('\n'),
    troca('funcao - f f v u f f', 'funcao {"search_path=pg_catalog, public"} f f v u f f'),
    troca('gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_empresa_id_fkey "RI_FKey_check_upd" 17 public.empresas f f O',
      'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_empresa_id_fkey "RI_FKey_check_upd" 17 public.empresas f f D'),
    troca('coluna 014 motivo_revogacao text -', 'coluna 014 motivo_revogacao public.text -'),
    mais('indice public.zz_105_extra f f f t t t t f CREATE INDEX zz_105_extra ON public.mcp_oauth_concessoes USING btree (recurso)'),
    ref.slice(1).join('\n'), '', null];
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    const ok = await rodar(argv);
    assert.equal(ok.codigo, 0, JSON.stringify(ok.saida.motivos));
    // Mesma fotografia: a troca de search_path para pg_catalog vem depois da estrutura, antes do catálogo da relação.
    const i = ok.log.findIndex(x => x.sql === b5.SQL_RELACAO_105);
    assert.ok(i > 0 && ok.log[i - 1].sql === 'SET LOCAL search_path = pg_catalog' && ok.log[i - 2].sql === b5.SQL_ESTRUTURA_105);
    assert.ok(ok.log[i].ro && /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/.test(ok.log[i].iso));
    for (const relacao105 of derivas) {
      const r = await rodar(argv, {cliente: clienteFalso({relacao105})});
      assert.equal(r.codigo, 3, String(relacao105).slice(0, 80)); assert.deepEqual(r.saida.motivos, ['PREFIXO_DIVERGENTE 105:incompleta (esperado completa)']);
    }
    for (const relacao105 of [7, ['x'], {}, true]) {
      const r = await rodar(argv, {cliente: clienteFalso({relacao105})});
      assert.equal(r.codigo, 3); assert.ok(r.saida.motivos.some(m => /^ESTADO_ILEGIVEL 105/.test(m)), JSON.stringify(r.saida.motivos));
    }
  }
});

// ---------- B-21: salões combinados (098 histórica / 108) ----------
const detector = () => import('../lib/agenda/estado-combinados.ts');

test('B-21: SQL dos combinados é o TEXTO de lerCatalogoCombinados (lib/agenda/estado-combinados.ts) e só lê o catálogo', async () => {
  const det = await detector();
  let sqlTs, params;
  await det.lerCatalogoCombinados({query: async (sql, p) => { sqlTs = sql; params = p; return {rows: []}; }});
  assert.equal(b5.SQL_COMBINADOS, sqlTs); assert.equal(params, undefined);
  assert.equal(b5.CONFLITO_098, det.HASHES_COMBINADOS.conflito098);
  assert.equal(b5.REVISAO_114, det.HASHES_COMBINADOS.revisao114);
  const tabelas = [...b5.SQL_COMBINADOS.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/gi)].map(m => m[1]);
  assert.ok(tabelas.length >= 8);
  for (const t of tabelas) assert.match(t, /^pg_(proc|attribute|constraint|trigger)$/, 'só catálogo: ' + t);
  assert.doesNotMatch(b5.SQL_COMBINADOS, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE|COPY|LOCK|SET)\b/);
});

test('B-21: lerCombinados mapeia a linha como o detector; classificarCombinados = regra do .ts em matriz completa (4 estados alcançados)', async () => {
  const det = await detector();
  const sonda = {funcoes: NF - 1, funcoes_qualquer: NF + 2, combinado: true, membros: false, check_ok: true, gatilhos_ok: NG - 1, gatilhos_qualquer: NG + 3,
    conflito: b5.CONFLITO_098, contrato: ret108.NOVA.hashes.contrato, revisao: null, marcador: false, marcador114: true};
  for (const linha of [...Object.values(LINHAS), sonda]) {
    assert.deepEqual(b5.lerCombinados(linha), await det.lerCatalogoCombinados({query: async () => ({rows: [linha]})}));
  }
  const vistos = new Set(); let n = 0;
  const H = ret108.NOVA.hashes;
  for (const funcoes of [0, NF - 1, NF]) for (const funcoesQualquer of [0, NF, NF + 1]) for (const colunaCombinado of [false, true])
  for (const colunaMembros of [false, true]) for (const checkValidado of [false, true]) for (const gatilhosOk of [0, NG - 1, NG])
  for (const gatilhosQualquer of [0, NG, NG + 1]) for (const conflito of [null, b5.CONFLITO_098, H.conflito108, 'f'.repeat(64)])
  for (const contrato of [null, H.contrato]) for (const revisao of [null, H.revisao, b5.REVISAO_114]) for (const marcador108 of [false, true]) for (const marcador114 of [false, true]) {
    const c = {funcoes, funcoesQualquer, colunaCombinado, colunaMembros, checkValidado, gatilhosOk, gatilhosQualquer, conflito, contrato, revisao, marcador108, marcador114};
    const e = b5.classificarCombinados(c);
    assert.equal(e, det.classificarCombinados(c), JSON.stringify(c)); vistos.add(e); n++;
  }
  assert.equal(n, 62208); assert.deepEqual([...vistos].sort(), ['ANTIGA', 'AUSENTE', 'NOVA', 'PARCIAL']);
  for (const [k, linha] of Object.entries(LINHAS)) assert.equal((await det.estadoCombinados({query: async () => ({rows: [linha]})})).estado, k);
});

test('B-21: E1 e E2c — AUSENTE confere; ANTIGA, PARCIAL e NOVA = PARAR (código 3) com motivo nomeado; consulta sempre em READ ONLY', async () => {
  for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    const ok = await rodar(argv);
    assert.equal(ok.codigo, 0, JSON.stringify(ok.saida)); assert.equal(ok.saida.combinados.estado, 'AUSENTE');
    assert.deepEqual(foraDeLeitura(ok.log), []);
    for (const [estado, motivo] of [['ANTIGA', /COMBINADOS_ANTIGA \(098 historica presente\)/], ['PARCIAL', /COMBINADOS_PARCIAL/],
      ['NOVA', /COMBINADOS_NOVA \(108 presente: reconciliar o escopo, D-ESC-6\)/]]) {
      const r = await rodar(argv, {cliente: clienteFalso({combinados: [LINHAS[estado]]})});
      assert.equal(r.codigo, 3, argv + estado); assert.equal(r.saida.resultado, 'PARAR'); assert.equal(r.saida.combinados.estado, estado);
      assert.match(r.saida.motivos.join(' '), motivo); assert.deepEqual(foraDeLeitura(r.log), []);
      assert.ok(r.log.some(x => x.sql === b5.SQL_COMBINADOS && x.ro));
      assert.ok(r.saida.motivos.includes(`PREFIXO_DIVERGENTE 108:${estado} (esperado AUSENTE)`), 'a 108 do prefixo segue o B-21');
    }
  }
  const ambos = await rodar(['--conferir-b5-estado'], {cliente: clienteFalso({combinados: [LINHAS.ANTIGA]}), estados: {m093: 'parcial'}});
  assert.equal(ambos.codigo, 3); assert.match(ambos.saida.motivos.join(' '), /APLICACAO_PARCIAL 093.*COMBINADOS_ANTIGA/);
});

test('B-21: sem linha, várias linhas ou linha ilegível = PARAR (COMBINADOS_ILEGIVEIS) — ao contrário do detector, nunca AUSENTE por omissão', async () => {
  const ruins = [[], [LINHA_AUSENTE, LINHA_AUSENTE], [{...LINHA_AUSENTE, funcoes: '0'}], [{...LINHA_AUSENTE, gatilhos_qualquer: -1}],
    [{...LINHA_AUSENTE, funcoes_qualquer: 1.5}], [{...LINHA_AUSENTE, combinado: 'f'}], [{...LINHA_AUSENTE, marcador: null}], [{...LINHA_AUSENTE, marcador114: null}],
    [{...LINHA_AUSENTE, conflito: 'A'.repeat(64)}], [{...LINHA_AUSENTE, revisao: 'abc'}], [{...LINHA_AUSENTE, contrato: undefined}], [null],
    ...['conflito', 'contrato', 'revisao'].flatMap(k => [[LINHAS.ANTIGA.contrato], Buffer.from(LINHAS.ANTIGA.contrato), new String(LINHAS.ANTIGA.contrato),
      {toString: () => LINHAS.ANTIGA.contrato}].map(v => [{...LINHA_AUSENTE, [k]: v}]))];
  for (const combinados of ruins) for (const argv of [['--conferir-b5'], ['--conferir-b5-estado']]) {
    const r = await rodar(argv, {cliente: clienteFalso({combinados})});
    assert.equal(r.codigo, 3, JSON.stringify(combinados)); assert.deepEqual(r.saida.combinados, {estado: 'ILEGIVEL'});
    assert.ok(r.saida.motivos.includes('COMBINADOS_ILEGIVEIS'));
  }
  const det = await detector();
  assert.equal((await det.estadoCombinados({query: async () => ({rows: []})})).estado, 'AUSENTE', 'divergência deliberada documentada');
});

test('B-21: falha na consulta dos combinados = FALHA (código 2) com ROLLBACK; saída dos combinados sem SQL nem dados de negócio', async () => {
  const r = await rodar(['--conferir-b5-estado'], {cliente: clienteFalso({falharEm: 'kidmais108_instalada'})});
  assert.equal(r.codigo, 2, JSON.stringify(r.saida)); assert.equal(r.log.at(-1).sql, 'ROLLBACK'); assert.ok(!r.saida.mensagem.includes('SENHA_FALSA'));
  const ok = await rodar(['--conferir-b5-estado']);
  assert.deepEqual(Object.keys(ok.saida.combinados.catalogo).sort(), ['colunaCombinado', 'colunaMembros', 'checkValidado', 'conflito', 'contrato', 'funcoes',
    'funcoesQualquer', 'gatilhosOk', 'gatilhosQualquer', 'marcador108', 'marcador114', 'revisao'].sort());
  assert.ok(!JSON.stringify(ok.saida).includes('pg_proc'));
});
