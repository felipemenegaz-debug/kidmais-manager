/* eslint-disable @typescript-eslint/no-require-imports */
// B-5: conferência somente leitura agregada de produção com cliente simulado e Asaas simulado. Prova: alvo/identidade de
// produção, toda consulta em READ ONLY, estados pelos núcleos dos aplicadores (a 098 não tem núcleo), combinados (B-21) pelo
// mesmo SQL e regra de lib/agenda/estado-combinados.ts (só AUSENTE passa), paradas nomeadas,
// DV igual ao do código (cpfValido/cnpjFormatoDvOficial) e à regra da 091, datas do Fundador pela regra do código
// (primeiraRenovacaoRegular/diasAntes de renovacao-fundador.ts), leitura do Asaas só GET, sem chave nem ids na saída.
// Sem rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const b5 = require('./conferencia-b5-producao.cjs');
const prod = require('./migration-092-094-production.cjs');
const ret108 = require('./migration-108-retrato.cjs');
const {cpfValido} = require('../lib/acessos/validacao.ts');
const {cnpjFormatoDvOficial} = require('../lib/cadastro/cnpj.ts');
const renovacao = require('../lib/assinatura/renovacao-fundador.ts');

const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const CHAVE = '$aact_prod_CHAVE_FALSA_123';
const ENV = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD, ASAAS_AMBIENTE: 'producao', ASAAS_API_KEY: CHAVE});
const ID = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const AGORA = new Date('2026-11-10T15:00:00Z');

/** Núcleos simulados: estado escolhido por migration (padrão: tudo ausente; 100 = sem_094). */
function nucleos(estados = {}) {
  const padrao = {m089: 'ausente', m090: 'ausente', m091: 'ausente', m092: 'ausente', m093: 'ausente', m094: 'ausente', m095: 'ausente',
    m096: 'ausente', m097: 'ausente', m099: 'ausente', m100: 'sem_094', papel_trocado: false, ...estados};
  const carregados = [];
  const carregar = modulo => {
    carregados.push(modulo);
    const rotulo = b5.MIGRACOES.find(m => m[1] === modulo)[0];
    return {SQL_ESTADO: 'ESTADO ' + rotulo, lerEstado: e => { assert.equal(e.rotulo, rotulo); if (padrao['ilegivel' + rotulo]) assert.fail('ESTADO_ILEGIVEL x');
      const papel = padrao.papelPor && rotulo in padrao.papelPor ? padrao.papelPor[rotulo] : padrao.papel_trocado; return {...padrao, papel_trocado: papel}; }};
  };
  return {carregar, carregados};
}
/** Linha do catálogo dos combinados por estado (formato de lerCatalogoCombinados). */
const NF = Object.keys(ret108.NOVA.funcoes).length, NG = ret108.NOVA.gatilhos.length;
const LINHA_AUSENTE = Object.freeze({funcoes: 0, funcoes_qualquer: 0, combinado: false, membros: false, check_ok: false, gatilhos_ok: 0, gatilhos_qualquer: 0,
  conflito: null, contrato: null, revisao: null, marcador: false});
const NUCLEO = {funcoes: NF, funcoes_qualquer: NF, combinado: true, membros: true, check_ok: true, gatilhos_ok: NG, gatilhos_qualquer: NG,
  contrato: ret108.NOVA.hashes.contrato, revisao: ret108.NOVA.hashes.revisao};
const LINHAS = Object.freeze({AUSENTE: LINHA_AUSENTE, ANTIGA: {...LINHA_AUSENTE, ...NUCLEO, conflito: b5.CONFLITO_098},
  NOVA: {...LINHA_AUSENTE, ...NUCLEO, conflito: ret108.NOVA.hashes.conflito108, marcador: true}, PARCIAL: {...LINHA_AUSENTE, combinado: true}});
/** Concessão Fundador simulada (linha da consulta) e cobrança correspondente no Asaas. */
const concessao = (extra = {}) => ({pagamento: 'pay_1', fim: '2027-03-15', ciclo: 'MENSAL', tem_contratacao: true, atual: true, assinatura: 'sub_1',
  cliente: 'cus_1', valor: 11820, registrada: null, linhas_da_concessao: '1', ...extra});
const cobranca = (extra = {}) => ({id: 'pay_1', dueDate: '2026-03-20', subscription: 'sub_1', customer: 'cus_1', status: 'CONFIRMED', deleted: false, ...extra});

function clienteFalso({identidade = ID, docs = [], concessoes = [concessao()], total, instalada = true, falharEm, combinados = [LINHA_AUSENTE]} = {}) {
  const log = []; let ro = false;
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro});
      if (sql === 'ROLLBACK') { ro = false; return {rows: []}; }
      if (sql === 'BEGIN TRANSACTION READ ONLY' || sql.startsWith('SET LOCAL')) return {rows: []};
      if (falharEm && sql.includes(falharEm)) throw Object.assign(new Error('falha simulada ' + URL_PROD), {code: '57014'});
      if (sql === prod.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql.startsWith('ESTADO ')) return {rows: [{rotulo: sql.slice(7)}]};
      if (sql === b5.SQL_COMBINADOS) return {rows: combinados};
      if (sql === b5.SQL_DOCUMENTOS) return {rows: docs};
      if (sql === b5.SQL_TOTAL_CONFIRMADAS) return {rows: [{n: total ?? concessoes.length}]};
      if (sql === b5.SQL_RENOVACAO_INSTALADA) return {rows: [{instalada}]};
      if (sql === b5.sqlConcessoes(instalada)) return {rows: concessoes};
      throw new Error('SQL_INESPERADO ' + sql.slice(0, 40));
    }
  };
  C.log = log;
  return C;
}
const foraDeLeitura = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK)$/.test(x.sql));
const rodar = (argv, {cliente = clienteFalso(), estados, cobrancas = {pay_1: cobranca()}, env = ENV} = {}) => {
  const n = nucleos(estados), lidas = [];
  const lerCobranca = async id => { lidas.push(id); if (!(id in cobrancas)) throw new Error('ASAAS_HTTP_404'); return cobrancas[id]; };
  return b5.principal(argv, env, {Client: cliente, carregar: n.carregar, lerCobranca, agora: AGORA}).then(r => ({...r, carregados: n.carregados, lidas, log: cliente.log}));
};

test('DV: mesma regra do código (cpfValido, cnpjFormatoDvOficial) e da função da 091, inclusive CNPJ alfanumérico e sequências', () => {
  for (const [doc, ok] of [['52998224725', true], ['52998224724', false], ['11111111111', false], ['00000000000', false], ['11222333000181', true],
    ['11222333000180', false], ['12ABC34501DE35', true], ['12ABC34501DE36', false], ['12abc34501de35', false], ['1122233300018', false], ['', false], ['ABCDEFGHIJKL00', false]]) {
    assert.equal(b5.documentoValido091(doc), ok, doc);
  }
  // 4 mil documentos sorteados (válidos e inválidos) contra os validadores do código.
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
  // A regra espelha o texto da função da 091 (pesos e cortes), não outra.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database/migrations/20261022_091_documento_fiscal_contratante.sql'), 'utf8');
  for (const trecho of ["doc ~ '^[0-9]{11}$'", "doc ~ '^(.)\\1{10}$'", "doc ~ '^[0-9A-Z]{12}[0-9]{2}$'", '(11 - i)', '(12 - i)', 'CASE WHEN soma % 11 <= 1 THEN 0 ELSE 11 - soma % 11 END'])
    assert.ok(sql.includes(trecho), trecho);
});

test('datas do Fundador: mesma regra do código (primeiraRenovacaoRegular, diasAntes, dataValida, diaBrasil)', () => {
  for (const [venc, fim, ciclo] of [['2026-03-20', '2027-03-15', 'MENSAL'], ['2026-01-31', '2027-01-31T03:00:00.000Z', 'MENSAL'], ['2026-03-20', '2027-03-20', 'ANUAL'],
    ['2026-02-28', '2027-02-27', 'MENSAL'], ['2024-02-29', '2025-02-28', 'ANUAL'], ['2026-12-31', '2027-12-30', 'MENSAL']])
    assert.equal(b5.primeiraRenovacaoRegular(venc, fim, ciclo), renovacao.primeiraRenovacaoRegular(venc, fim, ciclo), `${venc} ${fim} ${ciclo}`);
  for (const [d, n] of [['2027-03-20', 30], ['2027-03-20', 33], ['2027-03-01', 44]]) assert.equal(b5.diasAntes(d, n), renovacao.diasAntes(d, n));
  for (const d of ['2027-02-30', '2027-13-01', '27-01-01', null, '2027-01-01T00:00']) assert.equal(b5.dataValida(d), renovacao.dataValida(d), String(d));
  assert.equal(b5.diaBrasil(new Date('2026-11-10T02:00:00Z')), renovacao.diaBrasil(new Date('2026-11-10T02:00:00Z')));
  assert.equal(b5.AVISO_DIAS, renovacao.AVISO_FUNDADOR_DIAS); assert.equal(b5.ANTECIPADO_DIAS, renovacao.AVISO_ANTECIPADO_DIAS);
  assert.throws(() => b5.primeiraRenovacaoRegular('2026-13-01', '2027-01-01', 'MENSAL'), /Vigência inválida/);
});

test('alvo e identidade de produção do B-1; nome de aplicação próprio; fora do Render recusa antes de conectar (código 1)', async () => {
  await assert.rejects(b5.principal(['--conferir-b5'], {...ENV, RENDER: undefined}, {Client: clienteFalso()}), /FORA_DO_RENDER/);
  await assert.rejects(b5.principal(['--conferir-b5'], {...ENV, RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
  await assert.rejects(b5.principal(['--conferir-b5'], {...ENV, DATABASE_SSL: 'false'}, {Client: clienteFalso()}), /TLS_OBRIGATORIO/);
  for (const argv of [['--aplicar'], ['--conferir-b5', '--x'], ['--conferir-098']]) await assert.rejects(b5.principal(argv, ENV, {}), /ARGUMENTOS_RECUSADOS/);
  let opts;
  const C = class extends clienteFalso() { constructor(o) { super(); opts = o; } };
  await rodar(['--conferir-b5-estado'], {cliente: C});
  assert.equal(opts.application_name, 'kidmais-conferencia-b5-production'); assert.deepEqual(opts.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  const outro = await rodar(['--conferir-b5'], {cliente: clienteFalso({identidade: {...ID, db: 'kidmais_staging_1z91'}})});
  assert.equal(outro.codigo, 2); assert.equal(outro.saida.resultado, 'FALHA'); assert.match(outro.saida.mensagem, /BANCO_DIVERGENTE/);
  assert.equal(outro.carregados.length, 0, 'identidade recusada: nenhum estado lido');
});

test('E1 completo: todas as consultas em READ ONLY; estados dos 9 núcleos na ordem, 098 nunca carregada; saída sem ids, documentos, chave ou URL', async () => {
  const docs = [{origem: 'empresa_assinaturas', doc: '11222333000181', tem_concessao: true}, {origem: 'assinatura_fundadores', doc: '11222333000181', tem_concessao: true}];
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({docs})});
  assert.equal(r.codigo, 0, JSON.stringify(r.saida)); assert.equal(r.saida.resultado, 'CONFERIDO');
  assert.deepEqual(foraDeLeitura(r.log), [], 'nenhuma consulta fora de BEGIN TRANSACTION READ ONLY');
  assert.ok(r.log.filter(x => x.sql.startsWith("SET LOCAL lock_timeout")).length >= 10);
  assert.deepEqual(r.carregados, b5.MIGRACOES.map(m => m[1])); assert.ok(!r.carregados.some(m => m.includes('098')));
  assert.deepEqual(Object.keys(r.saida.estados).sort(), ['089', '090', '091', '092', '093', '094', '095', '096', '097', '098', '099', '100']);
  assert.equal(r.saida.estados['098'], 'SEM_NUCLEO_VER_COMBINADOS'); assert.deepEqual(r.saida.presentes, []);
  assert.equal(r.saida.combinados.estado, 'AUSENTE'); assert.equal(r.log.filter(x => x.sql === b5.SQL_COMBINADOS && x.ro).length, 1);
  assert.equal(r.saida.fundador.menorPrimeiraDataRegular, '2027-03-20'); assert.equal(r.saida.fundador.calculadas, 1);
  assert.equal(r.saida.b15.dvInvalidoTotal, 0); assert.equal(r.saida.decisao, undefined);
  const texto = JSON.stringify(r.saida);
  for (const proibido of ['pay_1', 'sub_1', 'cus_1', '11222333000181', 'SENHA_FALSA', CHAVE, 'aact', '11820', 'postgres']) assert.ok(!texto.includes(proibido), proibido);
});

test('estados: parcial, ilegível e 100 divergente param (código 3); presentes listados; E2c exige 091 e 094 ausentes', async () => {
  for (const [estados, motivo] of [[{m093: 'parcial'}, /APLICACAO_PARCIAL 093/], [{ilegivel095: true}, /ESTADO_ILEGIVEL 095/], [{m100: 'divergente'}, /CORPO_DIVERGENTE 100/]]) {
    const r = await rodar(['--conferir-b5-estado'], {estados});
    assert.equal(r.codigo, 3, JSON.stringify(r.saida)); assert.match(r.saida.motivos.join(' '), motivo);
  }
  const ok = await rodar(['--conferir-b5-estado'], {estados: {m089: 'completa', m092: 'completa', m093: 'completa', m099: 'completa'}});
  assert.equal(ok.codigo, 0, JSON.stringify(ok.saida)); assert.deepEqual(ok.saida.presentes, ['089:completa', '092:completa', '093:completa', '099:completa']);
  assert.equal(ok.saida.b15, undefined); assert.equal(ok.saida.fundador, undefined); assert.deepEqual(ok.lidas, [], 'E2c não lê o Asaas');
  assert.ok(!ok.log.some(x => x.sql === b5.SQL_DOCUMENTOS), 'E2c não lê documentos');
  for (const [estados, motivo] of [[{m091: 'completa'}, /E2C_091_PRESENTE completa/], [{m094: 'completa', m100: 'ausente'}, /E2C_094_PRESENTE completa/]]) {
    const r = await rodar(['--conferir-b5-estado'], {estados});
    assert.equal(r.codigo, 3); assert.match(r.saida.motivos.join(' '), motivo);
  }
  // No E1 a 091/094 presentes só aparecem na lista (a comparação com o esperado é do operador).
  const e1 = await rodar(['--conferir-b5'], {estados: {m091: 'completa'}});
  assert.equal(e1.codigo, 0); assert.deepEqual(e1.saida.presentes, ['091:completa']);
});

test('B-15: contagens por tabela e formato; DV inválido pede a decisão D-OP-4 sem parar; documento nulo não conta', async () => {
  const docs = [['empresa_assinaturas', '11222333000180', false], ['empresa_assinaturas', '11222333000181', true], ['empresa_assinaturas', null, false],
    ['empresa_assinaturas', '52998224724', true], ['empresa_assinaturas', 'XYZ', false], ['assinatura_fundadores', '11222333000180', true], ['assinatura_fundadores', '12ABC34501DE35', true]]
    .map(([origem, doc, tem_concessao]) => ({origem, doc, tem_concessao}));
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({docs})});
  assert.equal(r.codigo, 0, JSON.stringify(r.saida)); assert.equal(r.saida.decisao, 'DECISAO_D_OP_4_NECESSARIA');
  assert.deepEqual(r.saida.b15.empresa_assinaturas, {total: 5, nulos: 1, cpf11: 1, cnpj14: 2, outroFormato: 1, dvInvalido: 3});
  assert.deepEqual(r.saida.b15.assinatura_fundadores, {total: 2, nulos: 0, cpf11: 0, cnpj14: 2, outroFormato: 0, dvInvalido: 1});
  assert.equal(r.saida.b15.empresasSemConcessaoComDvInvalido, 2); assert.equal(r.saida.b15.dvInvalidoTotal, 4);
  assert.ok(!JSON.stringify(r.saida).includes('11222333000180'));
  assert.ok(r.log.some(x => x.ro && x.sql === "SET LOCAL statement_timeout = '60s'"), 'leitura de documentos com tempo próprio');
  assert.throws(() => b5.inventarioDocumentos([{origem: 'outra', doc: 'x'}]), /ORIGEM_INESPERADA/);
});

test('Fundador: cobertura de todas as confirmadas; registro existente prevalece; prazos (30/33/30+14) e janelas pela regra do código', async () => {
  const concessoes = [concessao(), concessao({pagamento: 'pay_2', fim: '2027-01-10', ciclo: 'ANUAL', assinatura: 'sub_2', cliente: 'cus_2'}),
    concessao({pagamento: 'pay_3', registrada: '2027-06-01', assinatura: 'sub_3', cliente: 'cus_3'})];
  const cobrancas = {pay_1: cobranca(), pay_2: cobranca({id: 'pay_2', dueDate: '2026-01-05', subscription: 'sub_2', customer: 'cus_2'}),
    pay_3: cobranca({id: 'pay_3', subscription: 'sub_3', customer: 'cus_3'})};
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes}), cobrancas});
  const f = r.saida.fundador;
  assert.equal(r.codigo, 0, JSON.stringify(r.saida));
  assert.equal(f.confirmadas, 3); assert.equal(f.calculadas, 3); assert.equal(f.registradas, 1); assert.equal(f.registroDivergente, undefined);
  assert.equal(f.menorPrimeiraDataRegular, '2027-01-05', 'ANUAL: primeiro vencimento + 12 meses');
  assert.equal(f.limiteAviso, renovacao.diasAntes('2027-01-05', 30)); assert.equal(f.inicioJanelaAviso, renovacao.inicioJanelaAviso('2027-01-05'));
  assert.equal(f.prazoB9, renovacao.diasAntes('2027-01-05', 47), 'D-COM-5: −47'); assert.equal(f.hoje, '2026-11-10');
  assert.equal(f.janelasPerdidas, 0); assert.equal(f.janelasAbertas, 0); assert.deepEqual(r.lidas, ['pay_1', 'pay_2'], 'com registro, o Asaas nem é lido');
  // Registro existente MENOR que o calculado: é ele que vale (como no código), inclusive para os prazos.
  const reg = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: '2027-02-10'})]})});
  assert.equal(reg.saida.fundador.menorPrimeiraDataRegular, '2027-02-10'); assert.deepEqual(reg.lidas, []);
  assert.equal(reg.saida.fundador.prazoB9, renovacao.diasAntes('2027-02-10', 47));
});

test('Fundador: datas ausentes, cobrança ilegível/divergente, contratação ausente ou múltipla, prazo vencido e janela perdida = PARAR (código 3)', async () => {
  // [opções do cliente, cobranças no Asaas (undefined = a padrão de pay_1; {} = nenhuma), motivo esperado]
  const casos = [
    [{concessoes: [concessao({fim: null})]}, undefined, /FUNDADOR_DATAS_AUSENTES 1/],
    [{concessoes: [concessao({ciclo: 'SEMESTRAL'})]}, undefined, /FUNDADOR_DATAS_AUSENTES 1/],
    [{concessoes: [concessao({pagamento: null})]}, undefined, /FUNDADOR_DATAS_AUSENTES 1/],
    [{}, {pay_1: cobranca({subscription: 'sub_outro'})}, /FUNDADOR_COBERTURA_INCOMPLETA 0\/1/],
    [{}, {pay_1: cobranca({customer: 'cus_outro'})}, /FUNDADOR_COBERTURA_INCOMPLETA 0\/1/],
    [{}, {pay_1: cobranca({id: 'pay_x'})}, /FUNDADOR_COBERTURA_INCOMPLETA 0\/1/],
    [{}, {pay_1: cobranca({dueDate: '2026-02-30'})}, /FUNDADOR_COBERTURA_INCOMPLETA 0\/1/],
    [{}, {}, /FUNDADOR_COBERTURA_INCOMPLETA 0\/1/],
    [{concessoes: [concessao({tem_contratacao: false})]}, undefined, /FUNDADOR_COBERTURA_INCOMPLETA 0\/1/],
    [{concessoes: [concessao({linhas_da_concessao: '2'}), concessao({linhas_da_concessao: '2'})], total: 1}, undefined, /FUNDADOR_COBERTURA_INCOMPLETA 0\/1/],
    [{total: 2}, undefined, /FUNDADOR_COBERTURA_INCOMPLETA 1\/2/],
    [{concessoes: [concessao({fim: '2026-12-01'})]}, {pay_1: cobranca({dueDate: '2025-12-15'})}, /PRAZO_B9_VENCIDO/],
    [{concessoes: [concessao({fim: '2026-11-20'})]}, {pay_1: cobranca({dueDate: '2025-11-20'})}, /JANELAS_DE_AVISO_PERDIDAS 1/]];
  for (const [cliente, cobrancas, motivo] of casos) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso(cliente), cobrancas: cobrancas ?? {pay_1: cobranca()}});
    assert.equal(r.codigo, 3, JSON.stringify(r.saida)); assert.match(r.saida.motivos.join(' | '), motivo, JSON.stringify(r.saida.motivos));
  }
  // Janela aberta hoje (entre −33 e −30): conta, não para.
  const aberta = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({fim: '2026-12-10'})]}), cobrancas: {pay_1: cobranca({dueDate: '2025-12-11'})}});
  assert.equal(aberta.saida.fundador.menorPrimeiraDataRegular, '2026-12-11'); assert.equal(aberta.saida.fundador.janelasAbertas, 1);
  assert.match(aberta.saida.motivos.join(' '), /PRAZO_B9_VENCIDO/, 'prazo do B-9 (−47) já passou');
  // Cobrança não confirmada (pendente/removida) é contada à parte, mas a data é calculada (o B-9 a tratará como divergente).
  const pend = await rodar(['--conferir-b5'], {cobrancas: {pay_1: cobranca({status: 'PENDING'})}});
  assert.equal(pend.codigo, 0); assert.equal(pend.saida.fundador.cobrancaNaoConfirmada, 1);
  // Nenhuma concessão confirmada: nada a ler, sem parada.
  const zero = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: []})});
  assert.equal(zero.codigo, 0); assert.equal(zero.saida.fundador.menorPrimeiraDataRegular, null); assert.deepEqual(zero.lidas, []);
});

test('Asaas: só GET da cobrança, URL e cabeçalhos de produção, redirect recusado, id validado, erros sem chave; ambiente/chave errados recusam', async () => {
  const chamadas = [];
  const leitor = b5.criarLeitorAsaas(ENV, async (url, init) => { chamadas.push({url, init}); return {ok: true, status: 200, json: async () => cobranca()}; });
  assert.deepEqual(await leitor('pay_1'), cobranca());
  assert.equal(chamadas[0].url, 'https://api.asaas.com/v3/payments/pay_1'); assert.equal(chamadas[0].init.method, 'GET'); assert.equal(chamadas[0].init.redirect, 'error');
  assert.equal(chamadas[0].init.headers.access_token, CHAVE); assert.equal(chamadas[0].init.body, undefined);
  await assert.rejects(leitor('pay/../x'), /ID_COBRANCA_INVALIDO/); await assert.rejects(leitor(''), /ID_COBRANCA_INVALIDO/);
  const http = b5.criarLeitorAsaas(ENV, async () => ({ok: false, status: 404, body: {cancel: async () => {}}}));
  await assert.rejects(http('pay_1'), e => /ASAAS_HTTP_404/.test(e.message) && !e.message.includes('aact'));
  const rede = b5.criarLeitorAsaas(ENV, async () => { throw new Error('getaddrinfo ' + CHAVE); });
  await assert.rejects(rede('pay_1'), e => e.message === 'ASAAS_REDE');
  const lento = b5.criarLeitorAsaas(ENV, (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort')))), 20);
  await assert.rejects(lento('pay_1'), /ASAAS_TEMPO_ESGOTADO/);
  const invalido = b5.criarLeitorAsaas(ENV, async () => ({ok: true, status: 200, json: async () => [1]}));
  await assert.rejects(invalido('pay_1'), /ASAAS_RESPOSTA_INVALIDA/);
  assert.throws(() => b5.criarLeitorAsaas({...ENV, ASAAS_AMBIENTE: 'sandbox'}), /ASAAS_AMBIENTE_RECUSADO/);
  assert.throws(() => b5.criarLeitorAsaas({...ENV, ASAAS_API_KEY: '$aact_hmlg_x'}), /ASAAS_CHAVE_RECUSADA/);
  // Sem leitor injetado, o modo completo exige a configuração do Asaas antes de conectar (código 1 na CLI).
  await assert.rejects(b5.principal(['--conferir-b5'], {...ENV, ASAAS_API_KEY: undefined}, {Client: clienteFalso()}), /ASAAS_CHAVE_RECUSADA/);
  const estado = await b5.principal(['--conferir-b5-estado'], {...ENV, ASAAS_API_KEY: undefined}, {Client: clienteFalso(), carregar: nucleos().carregar});
  assert.equal(estado.codigo, 0, 'E2c não precisa do Asaas');
});

test('falha de consulta no meio: FALHA (código 2), ROLLBACK, mensagem sem URL; plano sem conexão descreve leituras e nunca-executa', async () => {
  const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({falharEm: 'assinatura_fundadores f\n'})});
  assert.equal(r.codigo, 2, JSON.stringify(r.saida)); assert.equal(r.saida.resultado, 'FALHA'); assert.ok(!r.saida.mensagem.includes('SENHA_FALSA'));
  assert.ok(r.log.at(-1).sql === 'ROLLBACK');
  const p = (await b5.principal([], {})).saida;
  assert.equal(p.resultado, 'PLANO'); assert.equal(p.conecta, false); assert.deepEqual(p.excluidas, {'098': 'SEM_NUCLEO_VER_COMBINADOS'});
  assert.ok(p.nuncaExecuta.includes('escrita no Asaas') && p.nuncaExecuta.includes('leitura de dados da agenda (combinados: só catálogo)'));
  assert.ok(p.leituras.some(l => /combinados \(B-21\)/.test(l)) && p.paradas.some(l => /combinados \(B-21, E1 e E2c\)/.test(l)));
  assert.deepEqual(p.migracoes.map(m => m.migration), ['089', '090', '091', '092-094', '095', '096', '097', '099', '100']);
});

test('núcleos reais: cada um carrega, expõe SQL_ESTADO e lerEstado, e o campo de estado que o B-5 lê; nenhum é o da 098', () => {
  for (const [rotulo, modulo, campos] of b5.MIGRACOES) {
    const n = require(modulo);
    assert.equal(typeof n.SQL_ESTADO, 'string', rotulo); assert.equal(typeof n.lerEstado, 'function', rotulo);
    const fonte = fs.readFileSync(path.join(__dirname, modulo), 'utf8');
    for (const c of campos) assert.ok(new RegExp(`\\b${c}\\b`).test(fonte), `${rotulo} ${c}`);
    assert.ok(!modulo.includes('098'));
  }
});

test('P2-1 da revisão: papel_trocado preservado; trocado sem previsão, ilegível ou inconsistente entre núcleos = PARAR; previsto = passa', async () => {
  const normal = await rodar(['--conferir-b5-estado']);
  assert.equal(normal.codigo, 0); assert.equal(normal.saida.papelTrocado, false);
  const trocado = await rodar(['--conferir-b5-estado'], {estados: {papel_trocado: true}});
  assert.equal(trocado.codigo, 3); assert.equal(trocado.saida.papelTrocado, true); assert.match(trocado.saida.motivos.join(' '), /PAPEL_TROCADO_INESPERADO/);
  const previsto = await rodar(['--conferir-b5-estado'], {estados: {papel_trocado: true}, env: {...ENV, KIDMAIS_B5_PAPEL_TROCADO_ESPERADO: 'sim'}});
  assert.equal(previsto.codigo, 0, JSON.stringify(previsto.saida)); assert.equal(previsto.saida.papelTrocado, true);
  const naoVeio = await rodar(['--conferir-b5-estado'], {env: {...ENV, KIDMAIS_B5_PAPEL_TROCADO_ESPERADO: 'sim'}});
  assert.equal(naoVeio.codigo, 3); assert.match(naoVeio.saida.motivos.join(' '), /PAPEL_TROCADO_ESPERADO_MAS_AUSENTE/);
  for (const estados of [{papelPor: {'095': true}}, {papelPor: {'099': 'x'}}, {ilegivel097: true}]) {
    const r = await rodar(['--conferir-b5'], {estados});
    assert.equal(r.codigo, 3, JSON.stringify(estados)); assert.equal(r.saida.papelTrocado, 'INCONSISTENTE'); assert.match(r.saida.motivos.join(' '), /PAPEL_TROCADO_ILEGIVEL_OU_INCONSISTENTE/);
  }
});

test('P2-2 da revisão: cabeçalhos imediatos com corpo pendurado esgotam o tempo (ASAAS_TEMPO_ESGOTADO), inclusive com json que ignora o sinal', {timeout: 10000}, async () => {
  for (const json of [() => new Promise(() => {}), init => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('AbortError'))))]) {
    const leitor = b5.criarLeitorAsaas(ENV, async (url, init) => ({ok: true, status: 200, json: () => json(init)}), 30);
    const t0 = Date.now();
    await assert.rejects(leitor('pay_1'), e => e.message === 'ASAAS_TEMPO_ESGOTADO');
    assert.ok(Date.now() - t0 < 2000);
  }
  // Corpo que falha sem tempo esgotado = resposta inválida (não "tempo").
  const ruim = b5.criarLeitorAsaas(ENV, async () => ({ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); }}), 1000);
  await assert.rejects(ruim('pay_1'), e => e.message === 'ASAAS_RESPOSTA_INVALIDA');
  // Fetch que nunca resolve e ignora o sinal também esgota.
  const surdo = b5.criarLeitorAsaas(ENV, () => new Promise(() => {}), 30);
  await assert.rejects(surdo('pay_1'), e => e.message === 'ASAAS_TEMPO_ESGOTADO');
});

test('P2-3 da revisão: registro de renovação válido vale sem o Asaas — cobrança 404, timeout ou divergente não tornam a cobertura incompleta', async () => {
  for (const cobrancas of [{}, {pay_1: cobranca({subscription: 'sub_outro'})}, {pay_1: cobranca({dueDate: 'lixo'})}]) {
    const r = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: '2027-04-01'})]}), cobrancas});
    assert.equal(r.codigo, 0, JSON.stringify(r.saida)); assert.equal(r.saida.fundador.calculadas, 1); assert.equal(r.saida.fundador.registradas, 1);
    assert.equal(r.saida.fundador.menorPrimeiraDataRegular, '2027-04-01'); assert.deepEqual(r.lidas, []);
  }
  // Registro inválido (formato) não vale: cai na regra normal com o Asaas.
  const inv = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: '2027-02-30'})]})});
  assert.equal(inv.saida.fundador.registradas, 0); assert.deepEqual(inv.lidas, ['pay_1']);
});

test('P2-4 da revisão: dueDate só com a string inteira de 10 caracteres (sufixo, timestamp, espaço e tipo errado = divergente)', async () => {
  for (const dueDate of ['2026-03-20INVALIDO', '2026-03-20T00:00:00Z', '2026-03-20 ', ' 2026-03-20', '2026-3-20', 20260320, null, '2026-02-30']) {
    const r = await rodar(['--conferir-b5'], {cobrancas: {pay_1: cobranca({dueDate})}});
    assert.equal(r.codigo, 3, String(dueDate)); assert.equal(r.saida.fundador.cobrancaDivergente, 1, String(dueDate)); assert.equal(r.saida.fundador.calculadas, 0);
  }
});

test('P3 da revisão: erros só com códigos conhecidos — e-mail, URL HTTPS, id e usuário nunca saem; erro do servidor vira ERRO_INESPERADO com SQLSTATE', async () => {
  const C = clienteFalso();
  const D = class extends C {
    async query(sql) {
      if (sql === b5.SQL_DOCUMENTOS) throw Object.assign(new Error('password authentication failed for user "fulano@exemplo.com" pay_1 https://api.asaas.com/v3/x'), {code: '28P01'});
      return super.query(sql);
    }
  };
  D.log = C.log;
  const r = await rodar(['--conferir-b5'], {cliente: D});
  assert.equal(r.codigo, 2); assert.equal(r.saida.mensagem, 'ERRO_INESPERADO SQLSTATE 28P01');
  const t = JSON.stringify(r.saida);
  for (const proibido of ['fulano', '@', 'https', 'pay_1', 'asaas.com']) assert.ok(!t.includes(proibido), proibido);
  const E0 = clienteFalso();
  const E = class extends E0 { async query(sql) { if (sql === b5.SQL_DOCUMENTOS) throw new Error('relation "x" does not exist'); return super.query(sql); } };
  E.log = E0.log;
  const r2 = await rodar(['--conferir-b5'], {cliente: E});
  assert.equal(r2.saida.mensagem, 'ERRO_INESPERADO');
  const outro = await rodar(['--conferir-b5'], {cliente: clienteFalso({identidade: {...ID, db: 'outro'}})});
  assert.equal(outro.saida.mensagem, 'BANCO_DIVERGENTE');
});

test('P3 da re-revisão: só a lista fechada de códigos sai; texto externo com cara de código vira ERRO_INESPERADO (sondas do revisor)', async () => {
  for (const mensagem of ['FALHA pay_SONDA_SINTETICA', 'ERRO 12345678901', 'CODIGO_INVENTADO', 'BANCO_DIVERGENTE pay_1', 'FORA_DO_RENDER ', ' FORA_DO_RENDER',
    'ESTADO_ILEGIVEL 095', 'ASAAS_HTTP_404', 'TLS_OBRIGATORIO\nfulano@exemplo.com']) {
    const C0 = clienteFalso();
    const C = class extends C0 { async query(sql) { if (sql === b5.SQL_DOCUMENTOS) throw new Error(mensagem); return super.query(sql); } };
    C.log = C0.log;
    const r = await rodar(['--conferir-b5'], {cliente: C});
    assert.equal(r.codigo, 2, mensagem); assert.equal(r.saida.mensagem, 'ERRO_INESPERADO', JSON.stringify(mensagem));
  }
  // SQLSTATE só com exatamente 5 caracteres [0-9A-Z]; outro "code" não sai.
  for (const [code, esperado] of [['57014', 'ERRO_INESPERADO SQLSTATE 57014'], ['42P01', 'ERRO_INESPERADO SQLSTATE 42P01'], ['ECONNRESET', 'ERRO_INESPERADO'],
    ['pay_1', 'ERRO_INESPERADO'], ['1234', 'ERRO_INESPERADO'], [undefined, 'ERRO_INESPERADO']])
    assert.equal(b5.curta(Object.assign(new Error('qualquer coisa fulano@exemplo.com'), {code})), esperado, String(code));
  // A lista contém exatamente códigos (sem espaço/complemento) e cobre todos os que as travas reais de produção lançam.
  for (const c of b5.CODIGOS_PUBLICOS) { assert.match(c, /^[A-Z][A-Z0-9_]+$/); assert.equal(b5.curta(new Error(c)), c); }
  const lancados = new Set();
  const tentar = f => { try { f(); } catch (e) { lancados.add(e.message); } };
  for (const delta of [{RENDER: undefined}, {RENDER_SERVICE_ID: 'x'}, {KIDMAIS_DEPLOY_ENV: 'staging'}, {DATABASE_SSL: 'false'}, {DATABASE_URL: 'nao-e-url'},
    {DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'outro')}, {DATABASE_URL: URL_PROD.replace('kidmais_production', 'x')},
    {DATABASE_URL: URL_PROD.replace(':5432', ':1')}, {DATABASE_URL: URL_PROD + '?a=b'}]) tentar(() => prod.alvo({...ENV, ...delta}));
  for (const delta of [{db: 'x'}, {tls: false}, {tls_versao: 'TLSv1.1'}, {servidor_privado: false}]) tentar(() => prod.identidade({...ID, ...delta}));
  tentar(() => b5.criarLeitorAsaas({...ENV, ASAAS_AMBIENTE: 'sandbox'})); tentar(() => b5.criarLeitorAsaas({...ENV, ASAAS_API_KEY: 'x'}));
  tentar(() => b5.modo(['--x'])); tentar(() => b5.inventarioDocumentos([{origem: 'outra'}]));
  const fundadorIlegivel = await rodar(['--conferir-b5'], {cliente: clienteFalso({total: 'x'})});
  assert.equal(fundadorIlegivel.codigo, 2); lancados.add(fundadorIlegivel.saida.mensagem);
  // Bijeção: todo código real está na lista e a lista não tem código que nada lança.
  assert.deepEqual([...lancados].sort(), [...b5.CODIGOS_PUBLICOS].sort());
});

test('D-COM-5: prazo do B-9 em −47 (margem de 14 dias antes da abertura da janela, −33) — vencido entre −47 e −44, no dia exato ainda não', async () => {
  assert.equal(b5.AVISO_DIAS + b5.ANTECIPADO_DIAS + b5.MARGEM_B9_DIAS, 47);
  // hoje = 2026-11-10. Data regular 2026-12-26: −47 = 2026-11-09 (vencido); −44 seria 2026-11-12 (não vencido).
  const vencido = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: '2026-12-26'})]})});
  assert.equal(vencido.saida.fundador.prazoB9, '2026-11-09'); assert.equal(vencido.codigo, 3); assert.match(vencido.saida.motivos.join(' '), /PRAZO_B9_VENCIDO/);
  assert.equal(vencido.saida.fundador.janelasPerdidas, 0); assert.equal(vencido.saida.fundador.inicioJanelaAviso, '2026-11-23');
  // Data regular 2026-12-27: −47 = hoje (2026-11-10) → ainda não vencido.
  const noDia = await rodar(['--conferir-b5'], {cliente: clienteFalso({concessoes: [concessao({registrada: '2026-12-27'})]})});
  assert.equal(noDia.saida.fundador.prazoB9, '2026-11-10'); assert.equal(noDia.codigo, 0, JSON.stringify(noDia.saida.motivos));
});

// ---------- B-21: salões combinados (098 histórica / 108) ----------
const detector = () => import('../lib/agenda/estado-combinados.ts');

test('B-21: SQL dos combinados é o TEXTO de lerCatalogoCombinados (lib/agenda/estado-combinados.ts) e só lê o catálogo', async () => {
  const det = await detector();
  let sqlTs, params;
  await det.lerCatalogoCombinados({query: async (sql, p) => { sqlTs = sql; params = p; return {rows: []}; }});
  assert.equal(b5.SQL_COMBINADOS, sqlTs); assert.equal(params, undefined);
  assert.equal(b5.CONFLITO_098, det.HASHES_COMBINADOS.conflito098);
  const tabelas = [...b5.SQL_COMBINADOS.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/gi)].map(m => m[1]);
  assert.ok(tabelas.length >= 8);
  for (const t of tabelas) assert.match(t, /^pg_(proc|attribute|constraint|trigger)$/, 'só catálogo: ' + t);
  assert.doesNotMatch(b5.SQL_COMBINADOS, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE|COPY|LOCK|SET)\b/);
});

test('B-21: lerCombinados mapeia a linha como o detector; classificarCombinados = regra do .ts em matriz completa (4 estados alcançados)', async () => {
  const det = await detector();
  // Sonda de mapeamento: cada campo com valor distinto dos vizinhos (contagens diferentes entre si, booleanos alternados).
  const sonda = {funcoes: NF - 1, funcoes_qualquer: NF + 2, combinado: true, membros: false, check_ok: true, gatilhos_ok: NG - 1, gatilhos_qualquer: NG + 3,
    conflito: b5.CONFLITO_098, contrato: ret108.NOVA.hashes.contrato, revisao: null, marcador: false};
  for (const linha of [...Object.values(LINHAS), sonda]) {
    assert.deepEqual(b5.lerCombinados(linha), await det.lerCatalogoCombinados({query: async () => ({rows: [linha]})}));
  }
  const vistos = new Set(); let n = 0;
  const H = ret108.NOVA.hashes;
  for (const funcoes of [0, NF - 1, NF]) for (const funcoesQualquer of [0, NF, NF + 1]) for (const colunaCombinado of [false, true])
  for (const colunaMembros of [false, true]) for (const checkValidado of [false, true]) for (const gatilhosOk of [0, NG - 1, NG])
  for (const gatilhosQualquer of [0, NG, NG + 1]) for (const conflito of [null, b5.CONFLITO_098, H.conflito108, 'f'.repeat(64)])
  for (const contrato of [null, H.contrato]) for (const revisao of [null, H.revisao]) for (const marcador108 of [false, true]) {
    const c = {funcoes, funcoesQualquer, colunaCombinado, colunaMembros, checkValidado, gatilhosOk, gatilhosQualquer, conflito, contrato, revisao, marcador108};
    const e = b5.classificarCombinados(c);
    assert.equal(e, det.classificarCombinados(c), JSON.stringify(c)); vistos.add(e); n++;
  }
  assert.equal(n, 20736); assert.deepEqual([...vistos].sort(), ['ANTIGA', 'AUSENTE', 'NOVA', 'PARCIAL']);
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
    }
  }
  // O motivo dos combinados soma-se aos dos núcleos (não os substitui).
  const ambos = await rodar(['--conferir-b5-estado'], {cliente: clienteFalso({combinados: [LINHAS.ANTIGA]}), estados: {m093: 'parcial'}});
  assert.equal(ambos.codigo, 3); assert.match(ambos.saida.motivos.join(' '), /APLICACAO_PARCIAL 093.*COMBINADOS_ANTIGA/);
});

test('B-21: sem linha, várias linhas ou linha ilegível = PARAR (COMBINADOS_ILEGIVEIS) — ao contrário do detector, nunca AUSENTE por omissão', async () => {
  const ruins = [[], [LINHA_AUSENTE, LINHA_AUSENTE], [{...LINHA_AUSENTE, funcoes: '0'}], [{...LINHA_AUSENTE, gatilhos_qualquer: -1}],
    [{...LINHA_AUSENTE, funcoes_qualquer: 1.5}], [{...LINHA_AUSENTE, combinado: 'f'}], [{...LINHA_AUSENTE, marcador: null}],
    [{...LINHA_AUSENTE, conflito: 'A'.repeat(64)}], [{...LINHA_AUSENTE, revisao: 'abc'}], [{...LINHA_AUSENTE, contrato: undefined}], [null],
    // P2 da revisão: hash válido embrulhado em tipo que não é string primitiva (RegExp.test converteria para texto).
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
    'funcoesQualquer', 'gatilhosOk', 'gatilhosQualquer', 'marcador108', 'revisao'].sort());
  assert.ok(!JSON.stringify(ok.saida).includes('pg_proc'));
});
