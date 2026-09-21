import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import * as core from './criacao-financeira.ts';
import { sugerirParcelamentoPix } from '../../lib/pagamentos/services/sugestao-pix.ts';
import { statusPagamentoPorLiquido, statusParcelaPorLiquido } from '../../lib/pagamentos/services/financeiro-core.ts';
import type { ContratoSnapshotV1 } from '../../lib/contratos/repositories/models';

const contexto: core.ContextoCriacao = { fechamentoId: 'f', versaoId: 'v2', numeroVersao: 2, valor: 9700, dataFesta: '2027-06-15', forma: 'PIX_PARCELADO' };
for (const [forma, meio, modalidade, permitido] of [
  ['PIX_AVISTA', 'PIX', 'AVISTA', true], ['PIX_AVISTA', 'CARTAO', 'AVISTA', false],
  ['PIX_AVISTA', 'PIX', 'PARCELADO', false], ['PIX_PARCELADO', 'PIX', 'PARCELADO', true],
  ['PIX_PARCELADO', 'PIX', 'AVISTA', false], ['PIX_PARCELADO', 'CARTAO', 'PARCELADO', false],
  ['PIX_PARCELADO', 'CARTAO', 'AVISTA', false], ['CARTAO_CIELO', 'CARTAO', 'AVISTA', true],
  ['CARTAO_CIELO', 'CARTAO', 'PARCELADO', true], ['CARTAO_CIELO', 'PIX', 'AVISTA', false],
  ['CARTAO_CIELO', 'PIX', 'PARCELADO', false], ['', 'PIX', 'AVISTA', false],
  ['DESCONHECIDA', 'CARTAO', 'AVISTA', false],
] as const) test(`condição congelada ${forma || 'ausente'}: ${meio}/${modalidade} permitido=${permitido}`, async () => {
  const ctx = { ...contexto, forma };
  const linhas = modalidade === 'AVISTA' ? [{ valor: '9700', vencimento: contexto.dataFesta }]
    : [{ valor: '4850', vencimento: '2027-05-15' }, { valor: '4850', vencimento: contexto.dataFesta }];
  const criar = () => core.planoExplicito(ctx, meio, modalidade, linhas);
  if (permitido) assert.doesNotThrow(criar);
  else {
    assert.throws(criar, { message: core.erroCondicaoComercial });
    let chamadas = 0;
    await assert.rejects(core.enviarPlanoInicial(async () => { chamadas++; throw Error('Não chamar'); }, ctx,
      { meioPagamento: meio, modalidade, parcelas: [] }, 'key'), { message: core.erroCondicaoComercial });
    assert.equal(chamadas, 0);
  }
});
for (const meio of ['PIX', 'CARTAO'] as const) test(`${meio} à vista usa uma parcela integral da versão vigente, sem novo desconto`, () => {
  const p = core.planoExplicito({ ...contexto, forma: meio === 'PIX' ? 'PIX_AVISTA' : 'CARTAO_CIELO' }, meio, 'AVISTA', [{ valor: '10000', vencimento: contexto.dataFesta }]);
  assert.deepEqual(p.parcelas, [{ valor: 9700, vencimento: contexto.dataFesta, confirmaReserva: true }]);
});
test('cartão parcelado valida soma, precisão, quantidade, valor e limite da Festa no validador real', () => {
  const linhas = [{ valor: '3200,01', vencimento: '2027-05-15' }, { valor: '6499,99', vencimento: contexto.dataFesta }];
  assert.equal(core.planoExplicito({ ...contexto, forma: 'CARTAO_CIELO' }, 'CARTAO', 'PARCELADO', linhas).parcelas.length, 2);
  for (const valor of ['0', '-1', '3200', '1.001']) assert.throws(() => core.planoExplicito({ ...contexto, forma: 'CARTAO_CIELO' }, 'CARTAO', 'PARCELADO', [{ ...linhas[0], valor }, linhas[1]]));
  for (const meio of ['PIX', 'CARTAO'] as const) assert.throws(() => core.planoExplicito({ ...contexto, forma: meio === 'PIX' ? 'PIX_AVISTA' : 'CARTAO_CIELO' }, meio, 'AVISTA', [{ valor: '', vencimento: '2027-06-16' }]));
  assert.throws(() => core.planoExplicito({ ...contexto, forma: 'CARTAO_CIELO' }, 'CARTAO', 'PARCELADO', [linhas[0]]));
  assert.throws(() => core.planoExplicito({ ...contexto, forma: 'CARTAO_CIELO' }, 'CARTAO', 'PARCELADO', Array(61).fill(linhas[0])));
});
test('contexto ignora versão histórica/preparação e usa somente a corrente assinada', () => {
  const versao = (id: string, numero_versao: number, valor: number, status = 'ASSINADA') => ({ id, numero_versao, status, snapshot: {
    comercial: { valorFinalContrato: valor, formaPagamentoPretendida: 'PIX_PARCELADO' }, evento: { data: contexto.dataFesta },
  } as ContratoSnapshotV1 });
  const p = { contrato: { status: 'ASSINADO', fechamento_id: 'f', versao_atual: 2 }, fluxo: { versao_vigente_id: 'v2' },
    versoes: [versao('v3', 3, 11000, 'ATIVA'), versao('v1', 1, 10000), versao('v2', 2, 9700)] };
  assert.deepEqual(core.contextoCriacao(p), contexto);
  assert.equal(core.contextoCriacao({ ...p, fluxo: { versao_vigente_id: null } }), null);
  assert.equal(core.contextoCriacao({ ...p, contrato: { ...p.contrato, status: 'CANCELADO' } }), null);
  assert.deepEqual(core.contextoCriacao({ ...p, fluxo: null }), contexto);
});

// Event handlers and rendered controls of the real component, with isolated hooks/HTTP.
type Elemento = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
function texto(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(texto).join('');
  return typeof node === 'object' ? texto((node as Elemento).props?.children) : String(node);
}
function elementos(node: unknown): Elemento[] {
  if (Array.isArray(node)) return node.flatMap(elementos);
  if (!node || typeof node !== 'object') return [];
  const e = node as Elemento; return [e, ...elementos(e.props?.children)];
}
function tela(fetcher: typeof fetch, ctx: core.ContextoCriacao | null = contexto) {
  const slots: unknown[] = []; let cursor = 0, loaded = 0;
  const exports: Record<string, unknown> = {};
  const hooks = {
    useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v: unknown) => { slots[i] = v; }]; },
    useRef: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
  };
  const deps: Record<string, unknown> = { react: hooks, 'react/jsx-runtime': jsx,
    '@/lib/http/admin-fetch': { adminFetch: fetcher }, './criacao-financeira': core, './financeiro.module.css': { default: {} } };
  const js = ts.transpileModule(readFileSync('components/admin/CriarPlanoFinanceiro.tsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('require', 'exports', js)((id: string) => { assert(id in deps, id); return deps[id]; }, exports);
  const render = () => { cursor = 0; return (exports.default as (p: object) => Elemento)({ contexto: ctx, onCreated: async () => { loaded++; } }); };
  const find = (type: string, label: string) => { const node = elementos(render()).find(e => e.type === type && texto(e) === label); assert(node, label); return node; };
  const click = async (label: string) => { const e = find('button', label); assert(!e.props.disabled); await (e.props.onClick as () => Promise<void>)(); };
  const change = (label: string, value: string) => {
    const e = elementos(render()).find(e => e.type === 'label' && texto(e).startsWith(label)); assert(e, label);
    const field = elementos(e).find(e => e.type === 'input' || e.type === 'select'); assert(field);
    (field.props.onChange as (e: object) => void)({ target: { value } });
  };
  const submit = async () => { const e = elementos(render()).find(e => e.type === 'form')!;
    (e.props.onSubmit as (e: object) => void)({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); };
  return { render, find, click, change, submit, loaded: () => loaded };
}
test('empty state, explicit review, double-click lock, reload and no automatic receipt', async () => {
  const requests: Array<{ url: string; body: unknown }> = []; let finish: (r: Response) => void = () => {};
  const ui = tela(async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return new Promise(r => { finish = r; }); }, { ...contexto, forma: 'PIX_AVISTA' });
  assert.match(texto(ui.render()), /Nenhum plano financeiro foi criado/);
  await ui.click('Criar plano financeiro'); ui.change('Vencimento da parcela 1', contexto.dataFesta); await ui.submit();
  assert.equal(requests.length, 0); assert.match(texto(ui.render()), /Total do plano/);
  const handler = ui.find('button', 'Confirmar plano financeiro').props.onClick as () => Promise<void>;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '' } } });
  try {
    const first = handler(); await handler(); assert.equal(requests.length, 1);
    assert(ui.find('button', 'Confirmar plano financeiro').props.disabled);
    finish(Response.json({ ok: true, data: { detalhe: { pagamento: { id: 'p' } }, reutilizado: false } }, { status: 201 })); await first;
    assert.equal(ui.loaded(), 1); assert.equal(window.location.hash, 'financeiro');
    assert.deepEqual(requests.map(r => r.url), ['/api/admin/pagamentos']);
    assert.match(texto(ui.render()), /Nenhum recebimento foi registrado/);
  } finally { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window'); }
});
test('PIX suggestion and counteroffer stay previews until explicit confirmation; editing clears preview', async () => {
  const calls: Array<{ plano: core.PedidoInicial }> = [];
  const suggestion = { ...sugerirParcelamentoPix(9700, contexto.dataFesta, '2027-01-31', { entrada: 1000, valorParcela: 1 }), hash: 'a'.repeat(64) };
  const ui = tela(async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json({ ok: false, codigo: 'CONDICAO_PIX_INVIAVEL', data: { sugestao: suggestion, exigeConfirmacao: true } }, { status: 422 }); });
  await ui.click('Criar plano financeiro'); ui.change('Entrada pretendida', '1000'); ui.change('Valor pretendido', '1'); await ui.submit();
  assert.equal(calls.length, 1); assert(!('parcelas' in calls[0].plano)); assert(!('confirmacao' in calls[0].plano));
  assert.match(texto(ui.render()), /Contraproposta/); assert.equal(ui.loaded(), 0);
  await ui.click('Confirmar plano financeiro');
  assert.deepEqual((calls[1].plano as { confirmacao: unknown }).confirmacao, { dataReferencia: suggestion.dataReferencia, hash: suggestion.hash });
  await ui.submit(); ui.change('Entrada pretendida', '2000'); assert(!texto(ui.render()).includes('Confirmar plano financeiro'));
});
test('card installments UI adds/removes obligations and rejects incoherent sums', async () => {
  const ui = tela(async () => { throw Error('No write expected'); }, { ...contexto, forma: 'CARTAO_CIELO' });
  await ui.click('Criar plano financeiro'); ui.change('Modalidade', 'PARCELADO');
  await ui.click('Adicionar parcela'); ui.change('Valor da parcela 1', '4000'); ui.change('Valor da parcela 2', '5700');
  ui.change('Vencimento da parcela 1', '2027-05-15'); ui.change('Vencimento da parcela 2', contexto.dataFesta); await ui.submit();
  assert.match(texto(ui.render()), /Confirmar plano financeiro/);
  ui.change('Valor da parcela 2', '5600'); await ui.submit(); assert.match(texto(ui.render()), /soma das parcelas/);
  assert(!texto(ui.render()).includes('Confirmar plano financeiro'));
  await ui.click('Remover parcela 2'); assert(!texto(ui.render()).includes('Valor da parcela 2'));
});
test('HTTP retry reuses provided key, handles idempotent 200 and never posts receipts', async () => {
  const keys: string[] = [];
  const fetcher: typeof fetch = async (url, init) => { assert.equal(url, '/api/admin/pagamentos'); keys.push(new Headers(init?.headers).get('Idempotency-Key')!); return Response.json({ ok: true, data: { detalhe: { pagamento: { id: 'p' } }, reutilizado: true } }); };
  const plano = core.planoExplicito({ ...contexto, forma: 'CARTAO_CIELO' }, 'CARTAO', 'AVISTA', [{ valor: '', vencimento: contexto.dataFesta }]);
  for (let i = 0; i < 2; i++) assert.deepEqual(await core.enviarPlanoInicial(fetcher, { ...contexto, forma: 'CARTAO_CIELO' }, plano, 'same-key'), { criado: true });
  assert.deepEqual(keys, ['same-key', 'same-key']);
  assert.equal(statusPagamentoPorLiquido({ valorTotalContratado: 9700, recebidoConfirmado: 9700, estornadoConfirmado: 0 }), 'QUITADO');
  assert.equal(statusParcelaPorLiquido({ valorPrevisto: 9700, recebidoConfirmado: 9700, estornadoConfirmado: 0 }), 'PAGA');
});
test('creation hands back to existing panel; receipt and revision mechanisms stay in that panel', () => {
  const source = readFileSync('components/admin/ContratoAdmin.tsx', 'utf8');
  assert.match(source, /data\.financeiro\.length\?<FinanceiroContrato/);
  assert.match(source, /contexto=\{contextoCriacao\(data\)\}/);
  assert.match(source, /onCreated=\{async\(\)=>\{await load\(cid,vid\)/);
  const panel = readFileSync('components/admin/FinanceiroContrato.tsx', 'utf8');
  for (const text of ['Registrar recebimento', 'CARTAO', 'registrarMovimento', 'Reprogramar cronograma', 'pendencias']) assert(panel.includes(text));
});

for (const forma of ['PIX_AVISTA', 'PIX_PARCELADO', 'CARTAO_CIELO', '', 'DESCONHECIDA']) test(`UI limita escolhas à condição ${forma || 'ausente'}`, async () => {
  const ui = tela(async () => { throw Error('Sem requisição'); }, { ...contexto, forma });
  if (!core.condicaoDoPlano(forma)) {
    assert.match(texto(ui.render()), /crie uma revisão contratual/);
    assert(!elementos(ui.render()).some(e => e.type === 'button' && texto(e) === 'Criar plano financeiro'));
    return;
  }
  await ui.click('Criar plano financeiro');
  const campo = (label: string) => elementos(ui.find('label', label)).find(e => e.type === 'input' || e.type === 'select')!;
  const meio = campo('Meio de pagamento');
  assert.equal(meio.props.readOnly, true);
  assert.equal(meio.props.value, forma === 'CARTAO_CIELO' ? 'Cartão' : 'PIX');
  if (forma === 'CARTAO_CIELO') {
    const select = elementos(ui.render()).find(e => e.type === 'select')!;
    assert.deepEqual(elementos(select).filter(e => e.type === 'option').map(e => e.props.value), ['AVISTA', 'PARCELADO']);
  } else {
    assert.equal(campo('Modalidade').props.readOnly, true);
    assert.equal(campo('Modalidade').props.value, forma === 'PIX_AVISTA' ? 'À vista' : 'Parcelado');
    assert(!elementos(ui.render()).some(e => e.type === 'select'));
    if (forma === 'PIX_PARCELADO') assert.match(texto(ui.render()), /Entrada pretendida/);
  }
});
