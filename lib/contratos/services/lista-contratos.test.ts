import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FILTROS, FINANCEIRO_SQL, LIMITE_PAGINA, codificarCursor, decodificarCursor, financeiroDaLinha, interpretarBusca, listarContratosPaginados } from './lista-contratos.ts';

const UUID = '00000000-0000-4000-8000-000000000001', EMPRESA = '00000000-0000-4000-8000-0000000000e1';
const linha = (x: Partial<Parameters<typeof financeiroDaLinha>[2][number]> = {}) => ({ contrato_id: 'c', n: 1, status: 'PARCIAL', valor_total_contratado: '6000.00', rec: '200000', est: null, dev: null, aj: null, res: null, invalido: false, ...x });

test('busca: dd/mm/aaaa vira data exata; texto de 2 a 80 caracteres, sem curingas do usuário', () => {
  assert.deepEqual(interpretarBusca('20/04/2027'), { texto: null, data: '2027-04-20' });
  assert.deepEqual(interpretarBusca(''), { texto: null, data: null });
  assert.deepEqual(interpretarBusca('  Helena  '), { texto: 'helena', data: null });
  assert.deepEqual(interpretarBusca('50%_off\\x'), { texto: '50\\%\\_off\\\\x', data: null });
  assert.deepEqual(interpretarBusca('31/02/2027'), { texto: '31/02/2027', data: null }, 'data impossível vira texto');
  assert.deepEqual(interpretarBusca('01/01/0000'), { texto: '01/01/0000', data: null }, 'ano 0000 não vira data (o tipo date recusaria)');
  assert.throws(() => interpretarBusca('a'), /BUSCA_INVALIDA/); assert.throws(() => interpretarBusca('x'.repeat(81)), /BUSCA_INVALIDA/);
});

test('cursor: ida e volta; recusa filtro trocado, formato ou id inválido e combinação nula incoerente', () => {
  const c = { f: 'todas' as const, n: 0 as const, d: '2027-04-20', i: UUID };
  assert.deepEqual(decodificarCursor(codificarCursor(c), 'todas'), c);
  assert.deepEqual(decodificarCursor(codificarCursor({ ...c, n: 1, d: null }), 'todas'), { ...c, n: 1, d: null });
  assert.equal(decodificarCursor(null, 'todas'), null);
  for (const ruim of [codificarCursor(c).slice(2), codificarCursor({ ...c, i: 'x' }), codificarCursor({ ...c, n: 1 }), codificarCursor({ ...c, d: '20/04/2027' }),
    // L-4: data impossível e tipos que não são texto.
    codificarCursor({ ...c, d: '2027-02-31' }), codificarCursor({ ...c, d: '0000-01-01' }), codificarCursor({ ...c, d: '0999-12-31' }), codificarCursor({ ...c, d: ['2027-04-20'] as never }), codificarCursor({ ...c, i: [UUID] as never }), Buffer.from('null').toString('base64url')])
    assert.throws(() => decodificarCursor(ruim, 'todas'), /CURSOR_INVALIDO/);
  assert.throws(() => decodificarCursor(codificarCursor(c), 'proximas'), /CURSOR_INVALIDO/);
});

test('financeiro: mesmas recusas da leitura do contrato viram CONFERIR (inclusive zero pagamentos); sem assinatura e cobrança encerrada', () => {
  assert.deepEqual(financeiroDaLinha('ASSINADO', 'VIGENTE_FLUXO', [linha()]), { tipo: 'OK', recebido: '200000', aCobrar: '400000', obrigacao: '600000', encerrada: false });
  // Ajuste (pode ser negativo), estorno e devolução: obrigação = original + ajustes; líquido = recebido − estornado − devolvido.
  assert.deepEqual(financeiroDaLinha('ASSINADO', 'VIGENTE_LEGADA', [linha({ aj: '-100000', est: '50000', dev: '10000' })]), { tipo: 'OK', recebido: '140000', aCobrar: '360000', obrigacao: '500000', encerrada: false });
  // Reserva ativa não muda líquido nem saldo (só o crédito disponível, fora da lista).
  assert.deepEqual(financeiroDaLinha('ASSINADO', 'VIGENTE_FLUXO', [linha({ rec: '700000', res: '50000' })]), { tipo: 'OK', recebido: '700000', aCobrar: '0', obrigacao: '600000', encerrada: false });
  // Contrato ou pagamento cancelado: nada a cobrar.
  assert.equal((financeiroDaLinha('CANCELADO', 'VIGENTE_FLUXO', [linha()]) as { aCobrar: string }).aCobrar, '0');
  assert.equal((financeiroDaLinha('ASSINADO', 'VIGENTE_FLUXO', [linha({ status: 'CANCELADO' })]) as { encerrada: boolean }).encerrada, true);
  // Recusas: 2 pagamentos, valor negativo, obrigação negativa, reserva maior que o crédito, precisão incompatível.
  for (const [nome, ls] of [['dois pagamentos', [linha({ n: 2 }), linha({ n: 2 })]], ['movimento inválido', [linha({ invalido: true })]], ['obrigação negativa', [linha({ aj: '-700000' })]],
    ['reserva > crédito', [linha({ res: '1' })]], ['precisão', [linha({ valor_total_contratado: '6000.123' })]], ['líquido negativo', [linha({ est: '300000' })]], ['zero pagamentos', []]] as const)
    assert.deepEqual(financeiroDaLinha('ASSINADO', 'VIGENTE_FLUXO', [...ls]), { tipo: 'CONFERIR' }, nome);
  // L-5: somas acima do limite de UM movimento, com movimentos válidos (2 × R$ 6 bi recebidos, estornos quase iguais): a leitura individual aceita; a lista também.
  assert.deepEqual(financeiroDaLinha('ASSINADO', 'VIGENTE_FLUXO', [linha({ rec: '1200000000000', est: '1199999800000' })]), { tipo: 'OK', recebido: '200000', aCobrar: '400000', obrigacao: '600000', encerrada: false });
  for (const o of ['PREPARACAO_INICIAL', 'ATIVA_SEM_FLUXO', 'SEM_VERSAO_VALIDA'] as const) assert.deepEqual(financeiroDaLinha('AGUARDANDO_ASSINATURA', o, [linha()]), { tipo: 'SEM_ASSINATURA' });
});

test('consulta: presa à empresa, contagens sem cursor, página de 50 + 1 e próximo cursor; financeiro só dos itens da página', async () => {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const linhas = Array.from({ length: LIMITE_PAGINA + 1 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, status: 'ASSINADO', versao_id: 'v', prioridade: 1, data_evento: i === LIMITE_PAGINA ? null : '2027-04-20', versao_vigente_id: 'v', estado_preparacao: null, estado_referencia: 'CONCLUIDA',
    snapshot: { contratante: { nomeCompleto: 'Cliente' }, aniversariante: { nome: 'Helena', idadeNoEvento: 6 }, evento: { pacote: { nome: 'Standard' }, convidados: 50 }, comercial: { valorFinalContrato: 6000 } } }));
  const tx = { query: async (sql: string, params: unknown[]) => {
    assert.match(sql.trim(), /^WITH/); chamadas.push({ sql, params });
    if (sql.includes('count(*) FILTER')) return { rows: [Object.fromEntries(FILTROS.map((f, i) => [f, i]))] };
    if (sql.includes('FROM pg JOIN qtd')) return { rows: [] };
    return { rows: linhas };
  } };
  const r = await listarContratosPaginados(tx as never, EMPRESA, { filtro: 'todas', busca: { texto: 'helena', data: null }, cursor: { f: 'todas', n: 0, d: '2027-05-01', i: UUID }, hoje: '2026-10-25' });
  assert.equal(r.itens.length, LIMITE_PAGINA); assert.equal(r.itens[0].aniversariante, 'Helena'); assert.equal(r.itens[0].financeiro.tipo, 'CONFERIR', 'sem pagamento: conferência');
  assert.deepEqual(decodificarCursor(r.proximoCursor, 'todas'), { f: 'todas', n: 0, d: '2027-04-20', i: linhas[LIMITE_PAGINA - 1].id });
  const [contagens, pagina, fin] = chamadas;
  for (const c of [contagens, pagina]) { assert.match(c.sql, /fech\.empresa_id = \$1::uuid/); assert.match(c.sql, /pac\.empresa_id = \$1::uuid/); assert.equal(c.params[0], EMPRESA); }
  assert.deepEqual(contagens.params.slice(3, 6), [null, null, null], 'contagens antes do cursor');
  assert.deepEqual(pagina.params.slice(3, 6), [0, '2027-05-01', UUID]); assert.match(pagina.sql, new RegExp(`LIMIT ${LIMITE_PAGINA + 1}`));
  assert.match(pagina.sql, /b\.data_evento DESC, b\.id DESC/);
  assert.match(fin.sql, /fech\.empresa_id = \$2::uuid/); assert.deepEqual(fin.params, [linhas.slice(0, LIMITE_PAGINA).map((l) => l.id), EMPRESA]);
  // "Próximas festas" ordena do mais próximo para o mais distante.
  chamadas.length = 0;
  await listarContratosPaginados(tx as never, EMPRESA, { filtro: 'proximas', busca: { texto: null, data: null }, cursor: null, hoje: '2026-10-25' });
  assert.match(chamadas[1].sql, /b\.data_evento ASC, b\.id ASC/); assert.match(chamadas[1].sql, /b\.futura/);
  // L-1: referência sem edição (estado NULL) não vira NULL no filtro.
  assert.match(chamadas[1].sql, /b\.estado_referencia IS NOT DISTINCT FROM 'CANCELADA'/); assert.doesNotMatch(chamadas[1].sql, /b\.estado_referencia = 'CANCELADA'/);
});

test('financeiro SQL: só movimento válido (não NaN, não negativo, 2 casas, até o limite) chega ao cast; o resto marca invalido', () => {
  for (const c of ['r.valor_bruto', 'e.valor']) {
    assert.ok(FINANCEIRO_SQL.includes(`sum(CASE WHEN (${c} IS NOT NULL AND ${c} <> 'NaN'::numeric AND ${c} >= 0 AND ${c} * 100 = trunc(${c} * 100) AND ${c} * 100 <= 999999999999) THEN (${c} * 100)::bigint END)`), c);
    assert.ok(FINANCEIRO_SQL.includes(`bool_or(NOT (${c} IS NOT NULL AND ${c} <> 'NaN'::numeric`), c);
  }
  assert.doesNotMatch(FINANCEIRO_SQL, /sum(((r.valor_bruto|e.valor) * 100)::bigint)/, 'nenhum cast sem proteção');
});

test('rota da lista: valida busca e cursor antes, lê na transação da empresa comprovada e não mexe na lista antiga', () => {
  const rota = readFileSync('app/api/admin/contratos/lista/route.ts', 'utf8');
  assert.match(rota, /withTenantTransaction\(sessao, q\.get\('empresaId'\), async \(tx, tenant\) =>/);
  assert.match(rota, /listarContratosPaginados\(tx, tenant\.empresaComprovada,/);
  assert.match(rota, /listarContratosImportados\(tx, tenant\.empresaComprovada,/);
  assert.match(rota, /status: 400/); assert.doesNotMatch(rota, /db\(\)/);
  // Busca e cursor são decodificados ANTES da transação: entrada inválida responde 400 sem consulta.
  assert.ok(rota.indexOf('decodificarCursor(') < rota.indexOf('withTenantTransaction('), 'validação antes da transação');
  assert.match(readFileSync('app/api/admin/contratos/painel/route.ts', 'utf8'), /listarContratosDoTenant\(tx, tenant\.empresaComprovada/);
});
