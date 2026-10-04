import assert from 'node:assert/strict';
import test from 'node:test';
import { categorias, comporRascunho, filtrarProntas, linkSeguro, prontaEntradaSchema, type Pronta } from './prontas.ts';
import { EXPLICACAO_SEM_LINK, resolverLinkFechamento, variantesTelefone, type PortasLinkFechamento } from './prontas-link.ts';

const base = { titulo: 'Tabela 2027', categoria: 'Comercial', tipo: 'TEXTO' as const, texto: 'Segue a tabela.', link: null, atalho: null };
const p = (x: Partial<Pronta>): Pronta => ({ id: crypto.randomUUID(), titulo: 'T', categoria: 'Geral', tipo: 'TEXTO', texto: 'x', link: null, atalho: null, versao: 0, atualizada_em: '', ...x });

test('cadastro: texto sem link; link só https completo; individual nunca digitado', () => {
  assert.equal(prontaEntradaSchema.safeParse(base).success, true);
  assert.equal(prontaEntradaSchema.safeParse({ ...base, link: 'https://kidmais.com.br' }).success, false, 'texto não leva link');
  assert.equal(prontaEntradaSchema.safeParse({ ...base, tipo: 'LINK', link: 'https://kidmais.com.br/tabela' }).success, true);
  for (const ruim of ['http://kidmais.com.br', 'https://user:senha@kidmais.com.br', 'https://kidmais.com.br/a b', 'javascript:alert(1)', 'https://localhost', 'kidmais.com.br', null])
    assert.equal(prontaEntradaSchema.safeParse({ ...base, tipo: 'LINK', link: ruim }).success, false, String(ruim));
  assert.equal(prontaEntradaSchema.safeParse({ ...base, tipo: 'LINK_FECHAMENTO_INDIVIDUAL' }).success, true);
  const digitado = prontaEntradaSchema.safeParse({ ...base, tipo: 'LINK_FECHAMENTO_INDIVIDUAL', link: 'https://kidmais.com.br/contrato/x' });
  assert.equal(digitado.success, false); assert.match(digitado.error!.issues[0].message, /vem do sistema/);
  assert.equal(prontaEntradaSchema.safeParse({ ...base, atalho: 'TABELA_PRECOS' }).success, true);
  assert.equal(prontaEntradaSchema.safeParse({ ...base, atalho: 'OUTRO' }).success, false);
  assert.equal(prontaEntradaSchema.safeParse({ ...base, tipo: 'LINK', link: 'https://k.com/' + 'a'.repeat(40), texto: 'x'.repeat(3990) }).success, false, 'texto + link acima do limite da resposta');
  assert.equal(prontaEntradaSchema.safeParse({ ...base, extra: 1 }).success, false, 'campos desconhecidos recusados');
  assert.equal(linkSeguro('https://kidmais.com.br/tabela?x=1'), 'https://kidmais.com.br/tabela?x=1');
});

test('busca sem acento/caixa em título, categoria e texto; categoria e favoritas filtram', () => {
  const lista = [p({ titulo: 'Tabela de preços', categoria: 'Comercial', texto: 'Valores 2027' }), p({ titulo: 'Endereço', categoria: 'Informações', texto: 'Rua das Festas' }), p({ titulo: 'Disponibilidade', categoria: 'Comercial', texto: 'Consulte as datas' })];
  assert.deepEqual(filtrarProntas(lista, { busca: 'PRECOS', categoria: null, favoritas: null }).map(x => x.titulo), ['Tabela de preços']);
  assert.deepEqual(filtrarProntas(lista, { busca: 'rua festas', categoria: null, favoritas: null }).map(x => x.titulo), ['Endereço']);
  assert.deepEqual(filtrarProntas(lista, { busca: '', categoria: 'Comercial', favoritas: null }).length, 2);
  assert.deepEqual(filtrarProntas(lista, { busca: '', categoria: null, favoritas: new Set([lista[1].id]) }).map(x => x.titulo), ['Endereço']);
  assert.deepEqual(categorias(lista), ['Comercial', 'Informações']);
  assert.equal(comporRascunho('Olá', null), 'Olá');
  assert.equal(comporRascunho('Olá', 'https://k.com/x'), 'Olá\n\nhttps://k.com/x');
});

test('telefone do WhatsApp procura com e sem o 55; sem heurística do nono dígito', () => {
  assert.deepEqual(variantesTelefone('5561999998888'), ['5561999998888', '61999998888']);
  assert.deepEqual(variantesTelefone('556133334444'), ['556133334444', '6133334444']);
  assert.deepEqual(variantesTelefone('14155550100'), ['14155550100']);
});

const EMPRESA = 'e1';
const CONTRATO = '2b6f0f9e-6c1d-4a8e-9a55-3f0a5b1c2d3e';
function portas(op: { clientes?: Record<string, { id: string; empresaId: string | null }[]>; contratos?: Record<string, { contratoId: string | null; acessoPublico: string | null }[]>; origem?: string }) {
  const chamadas: string[] = [];
  const pt: PortasLinkFechamento = {
    clientesPorTelefone: async t => { chamadas.push('tel:' + t); return op.clientes?.[t] ?? []; },
    contratacoesDoCliente: async id => { chamadas.push('cli:' + id); return op.contratos?.[id] ?? []; },
    origemPublica: op.origem ?? 'https://admin.kidmais.com.br',
  };
  return { pt, chamadas };
}
const liberado = (contratoId: string) => ({ contratoId, acessoPublico: '/contrato/' + contratoId });

test('link individual: só com um cliente da empresa e um contrato aguardando a assinatura dele', async () => {
  const ok = portas({ clientes: { '61999998888': [{ id: 'c1', empresaId: EMPRESA }] }, contratos: { c1: [liberado(CONTRATO), { contratoId: 'outro', acessoPublico: null }] } });
  assert.deepEqual(await resolverLinkFechamento(EMPRESA, '5561999998888', ok.pt), { ok: true, link: `https://admin.kidmais.com.br/contrato/${CONTRATO}` });
  assert.deepEqual(ok.chamadas, ['tel:5561999998888', 'tel:61999998888', 'cli:c1'], 'contratos só do cliente identificado');
  // O mesmo cliente achado pelas duas formas do telefone conta uma vez.
  const duasFormas = portas({ clientes: { '5561999998888': [{ id: 'c1', empresaId: EMPRESA }], '61999998888': [{ id: 'c1', empresaId: EMPRESA }] }, contratos: { c1: [liberado(CONTRATO)] } });
  assert.equal((await resolverLinkFechamento(EMPRESA, '5561999998888', duasFormas.pt)).ok, true);
});

test('sem vínculo inequívoco o link não é preenchido, com o motivo', async () => {
  const casos: [string, Parameters<typeof portas>[0], keyof typeof EXPLICACAO_SEM_LINK][] = [
    ['nenhum cliente', {}, 'SEM_CLIENTE'],
    ['cliente de outra empresa não conta', { clientes: { '61999998888': [{ id: 'cx', empresaId: 'outra' }] } }, 'SEM_CLIENTE'],
    ['cliente legado sem empresa não conta', { clientes: { '61999998888': [{ id: 'cl', empresaId: null }] } }, 'SEM_CLIENTE'],
    ['dois clientes com o telefone', { clientes: { '61999998888': [{ id: 'c1', empresaId: EMPRESA }], '5561999998888': [{ id: 'c2', empresaId: EMPRESA }] } }, 'CLIENTES_AMBIGUOS'],
    ['sem contrato aguardando o cliente', { clientes: { '61999998888': [{ id: 'c1', empresaId: EMPRESA }] }, contratos: { c1: [{ contratoId: CONTRATO, acessoPublico: null }] } }, 'SEM_CONTRATO_LIBERADO'],
    ['dois contratos aguardando', { clientes: { '61999998888': [{ id: 'c1', empresaId: EMPRESA }] }, contratos: { c1: [liberado(CONTRATO), liberado('3c7a1f0e-1d2e-4f3a-8b4c-5d6e7f8a9b0c')] } }, 'CONTRATOS_AMBIGUOS'],
    ['origem http (ex.: demonstração local)', { clientes: { '61999998888': [{ id: 'c1', empresaId: EMPRESA }] }, contratos: { c1: [liberado(CONTRATO)] }, origem: 'http://localhost:3040' }, 'ORIGEM_NAO_SEGURA'],
    ['sem origem configurada', { clientes: { '61999998888': [{ id: 'c1', empresaId: EMPRESA }] }, contratos: { c1: [liberado(CONTRATO)] }, origem: '' }, 'ORIGEM_NAO_SEGURA'],
  ];
  for (const [nome, op, motivo] of casos) assert.deepEqual(await resolverLinkFechamento(EMPRESA, '5561999998888', portas(op).pt), { ok: false, motivo }, nome);
  for (const texto of Object.values(EXPLICACAO_SEM_LINK)) assert.match(texto, /não foi preenchido/);
});
