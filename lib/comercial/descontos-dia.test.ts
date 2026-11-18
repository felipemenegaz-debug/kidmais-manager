/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { aindaPodeValer, avisoEconomize, descontoSobreBase, origemDoDescontoCotado, textoPercentual, diaSemanaIso, regraDoDia, rotuloDias, tituloDescontoDia, TETO_DESCONTO_DIA, type RegraDescontoDiaPublica } from './descontos-dia.ts';

/**
 * D3/D4 (18/11/2026) — desconto por dia da semana. Prova sem banco: escolha da regra igual à do servidor, frases, validação
 * (teto 50%), Gestão no servidor, calendário/aviso pelas regras da empresa e Kidmais pelo caminho de sempre.
 * Gravação, vigência, isolamento entre empresas e "fechamento feito não muda": descontos-dia-admin.postgres.test.ts.
 */
const admin = carregarModulo('lib/comercial/descontos-dia-admin.ts', { 'lib/db/postgres': { withTransaction() { throw new Error('sem banco'); } } }) as any;
const descontos = carregarModulo('lib/comercial/descontos.ts', {}) as any;
const ler = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const codigo = (f: string) => ler(f).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const erroDe = (f: () => unknown) => { try { f(); } catch (e: any) { return { code: e.code, status: e.httpStatus ?? e.status, msg: e.message }; } return null; };
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const VALIDO = { dias: [1, 2, 3, 4], percentual: 10, pacoteIds: [P1], inicio: '2026-12-01', versao: 'v' };
const r = (p: Partial<RegraDescontoDiaPublica>): RegraDescontoDiaPublica =>
  ({ dia: 1, percentual: 10, titulo: null, vigenciaInicio: '2026-01-01', vigenciaFim: null, configuracaoId: null, prioridade: 100, ...p });

test('dia ISO e frases dos dias', () => {
  assert.equal(diaSemanaIso('2026-11-16'), 1, 'segunda');
  assert.equal(diaSemanaIso('2026-11-22'), 7, 'domingo');
  assert.equal(rotuloDias([4, 1, 2, 3]), 'de segunda a quinta');
  assert.equal(rotuloDias([1, 3, 5]), 'segunda, quarta e sexta');
  assert.equal(rotuloDias([6, 7]), 'sábado e domingo');
  assert.equal(rotuloDias([1, 2, 3, 4, 5, 6, 7]), 'todos os dias');
  assert.equal(tituloDescontoDia(10, [1, 2, 3, 4]), '10% de desconto de segunda a quinta');
});

test('regraDoDia repete o servidor: dia, vigência pela data da festa, horário específico antes, prioridade, início mais recente', () => {
  const seg = '2026-11-16';
  assert.equal(regraDoDia([r({ dia: 2 })], seg, null), null, 'outro dia da semana');
  assert.equal(regraDoDia([r({ vigenciaInicio: '2026-11-17' })], seg, null), null, 'começa depois da festa');
  assert.equal(regraDoDia([r({ vigenciaFim: '2026-11-15' })], seg, null), null, 'terminou antes da festa');
  assert.equal(regraDoDia([r({ vigenciaFim: seg })], seg, null)?.percentual, 10, 'último dia ainda vale');
  assert.equal(regraDoDia([r({ configuracaoId: 'X' })], seg, 'Y'), null, 'regra de outro horário não vale');
  assert.equal(regraDoDia([r({ configuracaoId: 'X' })], seg, null), null, 'sem horário escolhido, só a genérica');
  assert.equal(regraDoDia([r({ percentual: 5 }), r({ percentual: 20, configuracaoId: 'X', prioridade: 999 })], seg, 'X')?.percentual, 20, 'específica vence a genérica');
  assert.equal(regraDoDia([r({ percentual: 5, prioridade: 200 }), r({ percentual: 7, prioridade: 50 })], seg, null)?.percentual, 7, 'menor prioridade');
  assert.equal(regraDoDia([r({ percentual: 5, vigenciaInicio: '2026-01-01' }), r({ percentual: 8, vigenciaInicio: '2026-06-01' })], seg, null)?.percentual, 8, 'início mais recente');
  assert.equal(regraDoDia([r({})], 'lixo', null), null);
});

test('aviso "Economize": percentual único, vários percentuais, regra vencida não conta', () => {
  assert.equal(avisoEconomize([r({ dia: 1 }), r({ dia: 2 }), r({ dia: 3 }), r({ dia: 4 })], '2026-11-18'), 'Economize 10% escolhendo de segunda a quinta.');
  assert.equal(avisoEconomize([r({ dia: 1, percentual: 10 }), r({ dia: 2, percentual: 15 })], '2026-11-18'), 'Economize até 15% em alguns dias da semana.');
  assert.equal(avisoEconomize([r({ vigenciaFim: '2026-11-17' })], '2026-11-18'), null);
  assert.equal(avisoEconomize([], '2026-11-18'), null);
});

test('validação: teto 50, inteiro, dias e pacotes obrigatórios, 0 desliga, campo extra recusado', () => {
  assert.equal(TETO_DESCONTO_DIA, 50);
  assert.equal(admin.validarDescontoDia({ ...VALIDO, percentual: 50 }).percentual, 50);
  assert.equal(admin.validarDescontoDia({ ...VALIDO, percentual: '12' }).percentual, 12, 'número digitado como texto');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, percentual: 51 }))?.code, 'DESCONTO_ACIMA_DO_TETO');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, percentual: 10.5 }))?.code, 'DESCONTO_INVALIDO');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, percentual: -1 }))?.code, 'DESCONTO_INVALIDO');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, dias: [] }))?.code, 'DIAS_OBRIGATORIOS');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, pacoteIds: [] }))?.code, 'PACOTES_OBRIGATORIOS');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, dias: [0] }))?.code, 'DADOS_INVALIDOS');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, dias: [8] }))?.code, 'DADOS_INVALIDOS');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, pacoteIds: ['nao-uuid'] }))?.code, 'DADOS_INVALIDOS');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, inicio: '01/12/2026' }))?.code, 'INICIO_INVALIDO');
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, empresaId: P2 }))?.code, 'DADOS_INVALIDOS', 'empresa nunca vem do corpo');
  assert.deepEqual(admin.validarDescontoDia({ ...VALIDO, percentual: 0 }), { dias: [], percentual: 0, pacoteIds: [], inicio: '2026-12-01', versao: 'v' }, '0% desliga');
  assert.deepEqual(admin.validarDescontoDia({ ...VALIDO, dias: [3, 1, 1], pacoteIds: [P2, P1.toUpperCase()] }).dias, [1, 3]);
});

test('Gestão no servidor: equipe recebe 403 antes de qualquer SQL, na leitura e na gravação', async () => {
  let sql = 0;
  const tx = { query: async () => { sql++; return { rows: [] }; } };
  const EQUIPE = { empresaComprovada: P1, membershipId: 'm', usuarioId: 'u', papelAtual: 'ADMINISTRATIVO' };
  await assert.rejects(admin.lerDescontoDiaAdmin(tx, EQUIPE), (e: any) => e.code === 'PAPEL_NAO_AUTORIZADO' && e.httpStatus === 403);
  await assert.rejects(admin.salvarDescontoDiaAdmin(tx, EQUIPE, VALIDO, { requestId: null }), (e: any) => e.code === 'PAPEL_NAO_AUTORIZADO');
  assert.equal(sql, 0);
});

test('agrupamento e histórico', () => {
  const l = (pacote_id: string, dia: number, inicio = '2026-12-01', fim: string | null = null, ativo = true) => ({ pacote_id, dia, percentual: '10.00', inicio, fim, ativo });
  assert.deepEqual(admin.agruparRegras([l(P2, 2), l(P1, 1), l(P1, 2), l(P1, 3, '2026-12-01', null, false)]),
    [{ dias: [1, 2], percentual: 10, pacoteIds: [P1, P2], inicio: '2026-12-01', fim: null }]);
  assert.equal(admin.agruparRegras([l(P1, 1, '2027-01-01'), l(P1, 1, '2026-12-01', '2026-12-31')]).map((g: any) => g.inicio).join(), '2026-12-01,2027-01-01');
  assert.equal(admin.textoDoHistorico({ percentual: 10, dias: [1, 2, 3, 4], todosPacotes: true, inicio: '2026-12-01' }), '10% de segunda a quinta · todos os pacotes para festas a partir de 01/12/2026');
  assert.equal(admin.textoDoHistorico({ percentual: 0, inicio: '2026-12-01' }), 'Desconto por dia desligado para festas a partir de 01/12/2026');
});

test('D4: descontoEfetivo com regras da empresa usa a regra do dia; sem elas, Kidmais intacta (15% de segunda a quinta)', () => {
  const base = { agenda: [], pacoteOverrides: [], descontos: [] };
  const empresa = { ...base, descontosEmpresa: { FESTA: [r({ dia: 1, percentual: 12, titulo: '12% de desconto segunda' }), r({ dia: 2, percentual: 30, configuracaoId: 'NOITE' })] } };
  assert.deepEqual(descontos.descontoEfetivo(empresa, 'FESTA', '2026-11-16', '', false, 'TARDE'), { ativo: true, percentual: 0.12, origem: 'empresa', titulo: '12% de desconto segunda' });
  assert.equal(descontos.descontoEfetivo(empresa, 'FESTA', '2026-11-17', '', true, 'TARDE').ativo, false, 'regra de outro horário');
  assert.equal(descontos.descontoEfetivo(empresa, 'FESTA', '2026-11-17', '', true, 'NOITE').percentual, 0.3);
  assert.equal(descontos.descontoEfetivo(empresa, 'FESTA', '2026-11-17', '', true, 'NOITE').titulo, '30% de desconto nesta data');
  assert.equal(descontos.descontoEfetivo(empresa, 'essencial', '2026-11-16', 'almoco', true).ativo, false, 'com regras da empresa, nunca os 15% fixos');
  assert.equal(descontos.descontoEfetivo({ ...base, descontosEmpresa: {} }, 'FESTA', '2026-11-16', '', true).ativo, false, 'empresa sem regra: sem desconto');
  // Kidmais (sem descontosEmpresa): exatamente como antes.
  assert.deepEqual(descontos.descontoEfetivo(base, 'essencial', '2026-11-16', 'almoco', true), { ativo: true, percentual: 0.15, origem: 'dia_util', titulo: '15% de desconto de segunda a quinta' });
  assert.equal(descontos.descontoEfetivo(base, 'essencial', '2026-11-20', 'almoco', true).ativo, false, 'sexta');
  assert.equal(descontos.descontoEfetivo(base, 'festa_personalizada', '2026-11-16', 'almoco', true).ativo, false);
});

test('D4: aviso do pacote pelas regras da empresa; Kidmais com o aviso de sempre', () => {
  const base = { agenda: [], pacoteOverrides: [], descontos: [] };
  const empresa = { ...base, descontosEmpresa: { FESTA: [1, 2, 3].map((dia) => r({ dia, percentual: 20 })) } };
  assert.deepEqual(descontos.avisoDescontoDoPacote(empresa, 'FESTA', false, '2026-11-18'), { titulo: 'Economize 20% escolhendo de segunda a quarta.', selo: '-20%' });
  assert.equal(descontos.avisoDescontoDoPacote(empresa, 'OUTRO', true, '2026-11-18'), null, 'pacote sem regra');
  assert.deepEqual(descontos.avisoDescontoDoPacote(base, 'essencial', true, '2026-11-18'), { titulo: 'Economize 15% escolhendo de segunda a quinta.', selo: '-15%' });
  assert.equal(descontos.avisoDescontoDoPacote(base, 'essencial', false, '2026-11-18'), null);
});

test('limites estáticos: serviço só toca regras_desconto_pacote e auditoria; nada apagado; API pública sem campos internos', () => {
  const s = codigo('lib/comercial/descontos-dia-admin.ts');
  const escritas = [...s.matchAll(/(?<!FOR )\b(INSERT INTO|UPDATE|DELETE FROM)\s+(?:public\.)?(\w+)/g)].map((x) => x[2]);
  assert.deepEqual([...new Set(escritas)].sort(), ['regras_desconto_pacote']);
  assert.doesNotMatch(s, /DELETE\s/i);
  assert.match(s, /empresaComprovada/);
  assert.match(s, /pg_advisory_xact_lock/);
  assert.match(s, /auditarMutacaoComercial\(/);
  const pub = codigo('lib/comercial/descontos-dia-publico.ts');
  assert.doesNotMatch(pub, /observacoes|r\.id\b/);
  assert.match(pub, /p\.empresa_id = \$1::uuid AND p\.ativo AND p\.vigente AND r\.ativo/);
  assert.match(pub, /codigo === "kidmais"/);
  const rota = codigo('app/api/disponibilidade/route.ts');
  assert.match(rota, /codigo === null\s*\? lerComercialPublico\(\)/, 'endereço atual (Kidmais) segue pelo arquivo legado');
  const wizard = codigo('components/fechamento/FechamentoWizard.tsx');
  assert.equal((wizard.match(/descontosEmpresa: json\.comercial\.descontosEmpresa/g) ?? []).length, 2, 'as duas leituras do assistente guardam as regras');
  assert.doesNotMatch(wizard, /Economize 15%/, 'o aviso não é mais fixo no assistente');
  const cal = codigo('components/fechamento/CalendarioDisponibilidade.tsx');
  assert.match(cal, /descontosEmpresa: json\.comercial\.descontosEmpresa/);
  assert.match(cal, /diaUtil,\s*turnoOperacional\?\.configuracaoId,/);
});

test('revisões: mesma festa mantém o desconto do dia gravado; trocar pacote, data ou horário recalcula; os três pontos usam a regra', () => {
  const { manterDescontoDoDia } = carregarModulo('lib/fechamentos/revisao-preco.ts', {}) as any;
  const resumo = (pct: number, regraId: string | null) => ({
    pacote: { valorTabelaBase: 1234.56, valorTabelaAplicado: 0, desconto: { aplicado: pct > 0, regraId, codigo: 'DIA_SEMANA_BUFFET', titulo: `${pct}%`, percentual: pct, valor: 0 } },
    adicionais: { itens: [], valorTotal: 200 }, valorTabelaPacoteBase: 1234.56, valorDescontoPacote: 0, valorTabelaPacoteAplicado: 0, valorAdicionais: 200, valorTotalTabela: 0,
  });
  const H = { horarioInicio: '14:00:00', horarioFim: '18:00:00' };
  const gravado = { pacoteId: P1, dataEvento: '2026-12-03', configuracaoAgendaId: 'c1', ...H, regraDescontoPacoteId: 'r10', descontoPercentual: 10 };
  const atual = resumo(25, 'r25');
  const mantido = manterDescontoDoDia(atual, gravado, { pacoteId: P1, dataEvento: '2026-12-03', configuracaoAgendaId: 'c1', horarioInicio: '14:00', horarioFim: '18:00' });
  assert.deepEqual([mantido.pacote.desconto.percentual, mantido.pacote.desconto.regraId, mantido.pacote.desconto.titulo, mantido.valorDescontoPacote, mantido.valorTabelaPacoteAplicado, mantido.pacote.valorTabelaAplicado, mantido.valorTotalTabela],
    [10, 'r10', null, 123.46, 1111.1, 1111.1, 1311.1]);
  // Gravado sem desconto: continua sem (a regra criada depois não entra).
  const zero = manterDescontoDoDia(atual, { ...gravado, regraDescontoPacoteId: null, descontoPercentual: 0 }, gravado);
  assert.deepEqual([zero.pacote.desconto.percentual, zero.pacote.desconto.regraId, zero.pacote.desconto.aplicado, zero.valorDescontoPacote, zero.valorTotalTabela], [0, null, false, 0, 1434.56]);
  // Mesma regra e percentual: devolve o cálculo do catálogo sem tocar.
  assert.equal(manterDescontoDoDia(resumo(10, 'r10'), gravado, gravado).pacote.desconto.titulo, '10%');
  // Horário livre (Astra r1 P1): mesma configuração, intervalo 14h–18h → 15h–19h (ou só o fim) recalcula.
  for (const troca of [{ pacoteId: P2 }, { dataEvento: '2026-12-04' }, { configuracaoAgendaId: 'c2' }, { horarioInicio: '15:00', horarioFim: '19:00' }, { horarioFim: '19:00' }]) {
    const destino = { pacoteId: P1, dataEvento: '2026-12-03', configuracaoAgendaId: 'c1', ...H, ...troca };
    assert.equal(manterDescontoDoDia(atual, gravado, destino), atual, `trocou ${Object.keys(troca)[0]}: regra vigente`);
  }
  const ed = codigo('lib/fechamentos/services/edicao-administrativa.service.ts');
  assert.match(ed, /const resumo = manterDescontoDoDia\(await calcularResumoComercial\(\{[^}]+\}, tx\), f, input\);/);
  const rev = codigo('lib/fechamentos/services/revisao-operacional.service.ts');
  assert.match(rev, /const resumo = preservarHistorico \? null : manterDescontoDoDia\(await calcularResumoComercial\(\{[^}]+\}, tx\), f, input\);/);
  const previa = codigo('app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts');
  assert.match(previa, /resumo = manterDescontoDoDia\(await calcularResumoComercial\(\{[^}]+\}\), fonte\.fechamento, \{ pacoteId, dataEvento, configuracaoAgendaId, horarioInicio, horarioFim \}\);/);
  // A prévia manda o intervalo do formulário (inicio/fim) para a mesma regra da gravação.
  assert.match(codigo('components/admin/EdicaoFesta.tsx'), /inicio: form\.horarioInicio, fim: form\.horarioFim/);
});

test('Astra r1: centavos inteiros, data de calendário, aviso sem dia elegível, rota sem empresaId, versão sob trava', () => {
  // P2 arredondamento: 50% de R$ 20,15 = 1007,5 centavos → 1008 (não 10,07 do ponto flutuante).
  assert.deepEqual(descontoSobreBase(20.15, 50), { valor: 10.08, aplicado: 10.07 });
  assert.deepEqual(descontoSobreBase(5000, 15), { valor: 750, aplicado: 4250 });
  assert.deepEqual(descontoSobreBase(1234.56, 10), { valor: 123.46, aplicado: 1111.1 });
  // Astra r2 (P2): percentual com 2 casas vira pontos-base antes da conta (16.15 * 1000 = 16149,999… em ponto flutuante).
  assert.deepEqual(descontoSobreBase(10, 16.15), { valor: 1.62, aplicado: 8.38 });
  assert.deepEqual(descontoSobreBase(0.1, 50), { valor: 0.05, aplicado: 0.05 });
  // A cotação usa a mesma rotina da revisão.
  assert.match(codigo('lib/comercial/services/pricing.service.ts'), /= descontoSobreBase\(valorTabelaBase, percentual\);/);
  // P3: data que não existe no calendário é recusada.
  assert.equal(admin.dataDeCalendario('2027-02-30'), false);
  assert.equal(admin.dataDeCalendario('2027-02-28'), true);
  assert.equal(admin.dataDeCalendario('2028-02-29'), true);
  assert.equal(erroDe(() => admin.validarDescontoDia({ ...VALIDO, inicio: '2027-02-30' }))?.status, 400);
  // P2 aviso: regra de segunda que termina numa quinta (19/11/2026) sem segunda restante não conta.
  assert.equal(aindaPodeValer(r({ dia: 1, vigenciaFim: '2026-11-19' }), '2026-11-17'), false);
  assert.equal(aindaPodeValer(r({ dia: 4, vigenciaFim: '2026-11-19' }), '2026-11-17'), true);
  assert.equal(aindaPodeValer(r({ dia: 1, vigenciaInicio: '2026-12-07', vigenciaFim: '2026-12-07' }), '2026-11-17'), true);
  assert.equal(avisoEconomize([r({ dia: 1, vigenciaFim: '2026-11-19' })], '2026-11-17'), null);
  assert.equal(avisoEconomize([r({ dia: 1, percentual: 20, vigenciaFim: '2026-11-19' }), r({ dia: 2 })], '2026-11-17'), 'Economize 10% escolhendo terça.');
  // P2 rota: empresa sempre da sessão (null), empresaId no corpo recusado.
  const rota = codigo('app/api/admin/configuracoes/descontos/dia/route.ts');
  assert.equal((rota.match(/withTenantTransaction\(sessao, null,/g) ?? []).length, 2);
  assert.match(rota, /Object\.hasOwn\(bruto, "empresaId"\)\)\s*throw new PacoteAdminError\("DADOS_INVALIDOS"/);
  assert.doesNotMatch(rota, /bruto\.empresaId|body\.empresaId|\.empresaId\b(?!")/);
  // P1 corrida: a leitura pega a trava compartilhada antes de calcular a versão; a gravação, a exclusiva.
  const svc = codigo('lib/comercial/descontos-dia-admin.ts');
  const ler = svc.slice(svc.indexOf('export async function lerDescontoDiaAdmin'), svc.indexOf('export async function salvarDescontoDiaAdmin'));
  assert.ok(ler.indexOf('TRAVA_COMPARTILHADA') > 0 && ler.indexOf('TRAVA_COMPARTILHADA') < ler.indexOf('versaoAtual('), 'trava antes da versão');
  assert.match(svc, /pg_advisory_xact_lock_shared\(hashtextextended\('descontos-dia:'/);
  const salvar = svc.slice(svc.indexOf('export async function salvarDescontoDiaAdmin'));
  assert.ok(salvar.indexOf('TRAVA_EXCLUSIVA') > 0 && salvar.indexOf('TRAVA_EXCLUSIVA') < salvar.indexOf('versaoAtual('));
});

test('Astra r1: o wizard mostra percentual e valor da mesma cotação', () => {
  const w = codigo('components/fechamento/FechamentoWizard.tsx');
  assert.match(w, /const descontoTela = cotacaoAtual\?\.dados\s*\?/);
  assert.match(w, /percentual: cotacaoAtual\.dados\.desconto\.percentual \/ 100/);
  assert.match(w, /percentualDescontoDiaUtil:\s*descontoTela\.percentual/);
});

test('Astra r2: origem da cotação, cartão da data pela cotação, percentual com 2 casas e título no resumo', () => {
  assert.equal(origemDoDescontoCotado('DIA_SEMANA_BUFFET', 10), 'empresa');
  assert.equal(origemDoDescontoCotado('DIA_UTIL_15', 10), 'dia_util');
  assert.equal(origemDoDescontoCotado('PROMO_NATAL', 10), 'personalizado');
  assert.equal(origemDoDescontoCotado('DIA_UTIL_15', 0), 'nenhum');
  assert.equal(origemDoDescontoCotado(null, 0), 'nenhum');
  assert.equal(textoPercentual(16.15), '16,15');
  assert.equal(textoPercentual(0.1615 * 100), '16,15');
  assert.equal(textoPercentual(20), '20');
  // A rota devolve a origem pela regra aplicada; o wizard a usa no payload (nunca o calendário).
  const rota = codigo('app/api/fechamentos/cotacao/route.ts');
  assert.match(rota, /origem: origemDoDescontoCotado\(p\.desconto\.codigo, p\.desconto\.valor\)/);
  const w = codigo('components/fechamento/FechamentoWizard.tsx');
  assert.match(w, /origem: cotacaoAtual\.dados\.desconto\.valor > 0 \? cotacaoAtual\.dados\.desconto\.origem :/);
  assert.match(w, /descontoDiaUtilAtivo:\s*descontoTela\.origem === "dia_util"/);
  assert.match(w, /origemDesconto:\s*descontoTela\.origem/);
  // Cartão da data: percentual, título e "A partir de" da cotação quando existe, centavos como no servidor.
  assert.match(w, /descontoTela\.ativo\s*\?\s*descontoSobreBase\(pacote\.precoInicial, descontoTela\.percentual \* 100\)\.aplicado/);
  assert.match(w, /\{form\.dataFesta && descontoTela\.ativo \? \(/);
  assert.match(w, /<small>\{descontoTela\.titulo\}<\/small>/);
  const depoisDaCotacao = w.slice(w.indexOf('const descontoTela ='));
  assert.doesNotMatch(depoisDaCotacao, /descontoAtual\.(percentual|titulo|ativo|origem)/, 'depois de definir descontoTela, nada lê o calendário');
  // Percentual com até 2 casas no wizard e no calendário; resumo com o título da regra.
  assert.doesNotMatch(w, /Math\.round\(descontoTela\.percentual \* 100\)/);
  assert.doesNotMatch(codigo('components/fechamento/CalendarioDisponibilidade.tsx'), /Math\.round\(\s*desconto\.percentual \* 100/);
  assert.doesNotMatch(w, /Desconto dia útil/);
  assert.match(w, /label=\{descontoTela\.titulo \|\| "Desconto da data"\}/);
});
