import test from 'node:test';
import assert from 'node:assert/strict';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';
import * as contratoTela from './contrato-tela.ts';
import * as contratoUrl from './contrato-url.ts';

/** Lista de contratos (fase 2): filtros, busca, páginas, importados, recusas e resposta atrasada. */
const item = (n: number, x: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, origem: 'CORE', status: 'ASSINADO', cancelado: false, alteracao: false, aguardandoCliente: false,
  contratante: `Cliente ${n}`, aniversariante: 'Helena', idade: 6, dataEvento: '2027-04-20', pacote: 'Standard', convidados: 50, valor: 6000,
  referencia: { origem: 'VIGENTE_FLUXO', diagnostico: false }, financeiro: { tipo: 'OK', recebido: '200000', aCobrar: '400000', obrigacao: '600000', encerrada: false }, ...x,
});
const contagens = { proximas: 2, aguardando: 1, alteracao: 1, todas: 3, canceladas: 0 };
function Link() { return null; }

function montar(responder: (url: string) => Promise<Response>) {
  const urls: string[] = [], abertos: string[] = [];
  const tela = carregarComponente('components/admin/ListaContratos.tsx', {
    'next/link': { default: Link }, './contratos-ux.module.css': cssFalso, './contrato-tela': contratoTela, './contrato-url': contratoUrl,
    '@/lib/http/admin-fetch': { adminFetch: async (u: string) => { urls.push(u); return responder(u); } },
  });
  const render = () => tela.render('default', { onAbrir: (s: string) => abertos.push(s) });
  const ciclo = async () => { render(); tela.efeitos(); for (let i = 0; i < 4; i++) await tique(); return render(); };
  return { urls, abertos, render, ciclo, efeitos: () => tela.efeitos() };
}
const ok = (data: unknown) => Response.json({ ok: true, data });

test('lista: linhas legíveis, contagens nos filtros, abrir contrato e importado, carregar mais acumula', async () => {
  const m = montar(async (u) => {
    if (u.includes('cursor=')) return ok({ itens: [item(3)], proximoCursor: null, contagens, importados: [] });
    return ok({ itens: [item(1, { alteracao: true }), item(2, { financeiro: { tipo: 'CONFERIR' }, referencia: { origem: 'VIGENTE_FLUXO', diagnostico: false } })], proximoCursor: 'abc', contagens,
      importados: [{ id: '00000000-0000-4000-8000-0000000000aa', nome: 'Importado', data_evento: '2026-12-01', pacote: 'Histórico', convidados: 40 }] });
  });
  const r = await m.ciclo();
  assert.equal(m.urls[0], '/api/admin/contratos/lista?filtro=proximas');
  const t = texto(r);
  // Componente filho (pagamento) é expandido à parte pelo simulador.
  const pagamentos = elementos(r).filter(e => typeof e.type === 'function' && (e.type as { name: string }).name === 'Pagamento').map(e => texto((e.type as (p: unknown) => unknown)(e.props)).replace(/\u00a0/g, ' '));
  assert.deepEqual(pagamentos, ['R$ 2.000,00 de R$ 6.000,00 · a cobrar R$ 4.000,00', 'Conferir pagamentos']);
  // Linha em conferência não mostra valor (L-2).
  const valores = elementos(r).filter(e => e.type === 'strong' && e.props.className === 'valorLinha').map(e => texto(e).replace(/\u00a0/g, ' '));
  assert.deepEqual(valores, ['R$ 6.000,00', '—']);
  assert.match(t, /Aniversário de Helena · 6 anos/); assert.match(t, /Alteração em andamento/);
  assert.match(t, /Próximas festas · 2/); assert.match(t, /Importados em conferência · 1/);
  assert.doesNotMatch(t, /ref\.|EM_ELABORACAO|ASSINADO/);
  assert.doesNotMatch(t, /Conferir data/, 'datas válidas não pedem conferência');
  (elementos(r).filter(e => e.type === 'button' && /Cliente 1/.test(texto(e)))[0].props.onClick as () => void)();
  assert.deepEqual(m.abertos, ['00000000-0000-4000-8000-000000000001']);
  (achar(r, 'button', 'Carregar mais').props.onClick as () => void)(); await m.ciclo();
  assert.match(m.urls.at(-1)!, /filtro=proximas&cursor=abc/);
  assert.equal(elementos(m.render()).filter(e => e.type === 'button' && /Cliente \d/.test(texto(e))).length, 3, 'acumula a página seguinte');
  (achar(m.render(), 'button', /^Importados em conferência/).props.onClick as () => void)(); await m.ciclo();
  (elementos(m.render()).find(e => e.type === 'button' && /Importado — em conferência/.test(texto(e)))!.props.onClick as () => void)();
  assert.equal(m.abertos.at(-1), 'importacao:00000000-0000-4000-8000-0000000000aa');
});

test('lista: data anômala no snapshot (P3-R1) mostra "Conferir data" no lugar da data, sem esconder a situação', async () => {
  const anomala = { dataEvento: null, dataInvalida: true };
  const m = montar(async () => ok({ itens: [
    item(1, { ...anomala, cancelado: true }), item(2, { ...anomala, alteracao: true }), item(3, { ...anomala, aguardandoCliente: true, status: 'AGUARDANDO_ASSINATURA' }),
    item(4, anomala), item(5), item(6, { dataEvento: null }),
  ], proximoCursor: null, contagens, importados: [] }));
  const r = await m.ciclo();
  const linhas = elementos(r).filter(e => e.type === 'button' && /Cliente \d/.test(texto(e))).map(texto);
  assert.equal(linhas.length, 6);
  for (const [i, situacao] of [[0, /Cancelado/], [1, /Alteração em andamento/], [2, /Aguardando assinatura/], [3, /Assinado/]] as const) {
    assert.match(linhas[i], situacao, 'situação preservada'); assert.match(linhas[i], /Conferir data/); assert.doesNotMatch(linhas[i], /2027|abril|Data não informada/);
  }
  assert.doesNotMatch(linhas[4], /Conferir data/);
  assert.match(linhas[5], /Data não informada/); assert.doesNotMatch(linhas[5], /Conferir data/, 'data ausente não é anômala');
});

test('lista: busca vai ao servidor, 400 vira orientação, filtro trocado descarta resposta atrasada', async () => {
  let liberar: (() => void) | null = null;
  const m = montar(async (u) => {
    if (u.includes('busca=x')) return Response.json({ ok: false, erro: 'Busca ou página inválida.' }, { status: 400 });
    if (u.includes('filtro=todas')) { await new Promise<void>(r => { liberar = r; }); return ok({ itens: [item(9, { contratante: 'Atrasado' })], proximoCursor: null, contagens, importados: [] }); }
    return ok({ itens: [item(1)], proximoCursor: null, contagens, importados: [] });
  });
  await m.ciclo();
  // Busca curta demais: orientação ao usuário.
  const form = elementos(m.render()).find(e => e.type === 'form')!;
  (elementos(m.render()).find(e => e.type === 'input')!.props.onChange as (e: unknown) => void)({ target: { value: 'x' } });
  (elementos(m.render()).find(e => e.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); void form;
  await m.ciclo();
  assert.match(m.urls.at(-1)!, /busca=x/); assert.match(texto(m.render()), /Use de 2 a 80 caracteres/);
  // Limpa a busca e troca para "Todas" (resposta segura), depois volta a "Próximas": a resposta atrasada de "Todas" é descartada.
  (achar(m.render(), 'button', 'Limpar').props.onClick as () => void)(); await m.ciclo();
  (achar(m.render(), 'button', /^Todas/).props.onClick as () => void)(); m.render(); m.efeitos(); await tique();
  (achar(m.render(), 'button', /^Próximas festas/).props.onClick as () => void)(); await m.ciclo();
  liberar!(); await m.ciclo(); await m.ciclo();
  assert.doesNotMatch(texto(m.render()), /Atrasado/); assert.match(texto(m.render()), /Cliente 1/);
});

test('O-1: a lista abre com o filtro e a busca vindos da URL e avisa cada troca para gravá-la', async () => {
  const urls: string[] = [], trocas: Array<[string, string]> = [];
  const tela = carregarComponente('components/admin/ListaContratos.tsx', {
    'next/link': { default: Link }, './contratos-ux.module.css': cssFalso, './contrato-tela': contratoTela, './contrato-url': contratoUrl,
    '@/lib/http/admin-fetch': { adminFetch: async (u: string) => { urls.push(u); return ok({ itens: [item(1)], proximoCursor: null, contagens, importados: [] }); } },
  });
  const render = () => tela.render('default', { onAbrir() {}, filtroInicial: 'todas', buscaInicial: 'lucas', onFiltro: (a: string, b: string) => trocas.push([a, b]) });
  render(); tela.efeitos(); for (let i = 0; i < 4; i++) await tique();
  let r = render();
  assert.equal(urls[0], '/api/admin/contratos/lista?filtro=todas&busca=lucas');
  assert.equal(achar(r, 'input', '').props.value, 'lucas', 'o campo mostra a busca restaurada');
  assert.equal(elementos(r).find(e => e.type === 'button' && /^Todas/.test(texto(e)))!.props['aria-pressed'], true);
  (elementos(r).find(e => e.type === 'button' && /^Canceladas/.test(texto(e)))!.props.onClick as () => void)();
  r = render(); (achar(r, 'button', 'Limpar').props.onClick as () => void)();
  assert.deepEqual(trocas, [['canceladas', 'lucas'], ['canceladas', '']]);
});

test('O-2: contrato cancelado aparece como "Cancelado", mesmo sem versão de referência válida; o valor continua oculto', async () => {
  const sem = { referencia: { origem: 'SEM_VERSAO_VALIDA', diagnostico: true } };
  const m = montar(async () => ok({ itens: [item(1, { ...sem, cancelado: true, status: 'CANCELADO' }), item(2, sem)], proximoCursor: null, contagens, importados: [] }));
  const r = await m.ciclo();
  const linhas = elementos(r).filter(e => e.type === 'button' && /Cliente \d/.test(texto(e))).map(texto);
  assert.match(linhas[0], /Cancelado/); assert.doesNotMatch(linhas[0], /Conferir/);
  assert.match(linhas[1], /Conferir/, 'sem versão válida e ativo continua "Conferir"');
  const valores = elementos(r).filter(e => e.type === 'strong' && e.props.className === 'valorLinha').map(texto);
  assert.deepEqual(valores, ['—', '—']);
});

test('O-1 (revisão): a URL que muda com a lista montada (ex.: menu "Contratos") reaplica filtro e busca, sem laço nem leitura dupla', async () => {
  const urls: string[] = [], trocas: Array<[string, string]> = [];
  const tela = carregarComponente('components/admin/ListaContratos.tsx', {
    'next/link': { default: Link }, './contratos-ux.module.css': cssFalso, './contrato-tela': contratoTela, './contrato-url': contratoUrl,
    '@/lib/http/admin-fetch': { adminFetch: async (u: string) => { urls.push(u); return ok({ itens: [item(1)], proximoCursor: null, contagens, importados: [] }); } },
  });
  let props = { filtroInicial: 'todas', buscaInicial: 'Helena' };
  // Como o ContratoAdmin: cada onFiltro grava na URL e volta como props no render seguinte.
  const onFiltro = (a: string, b: string) => { trocas.push([a, b]); props = { filtroInicial: a, buscaInicial: b }; };
  const ciclo = async () => { tela.render('default', { onAbrir() {}, onFiltro, ...props }); tela.efeitos(); for (let i = 0; i < 4; i++) await tique(); tela.render('default', { onAbrir() {}, onFiltro, ...props }); tela.efeitos(); for (let i = 0; i < 4; i++) await tique(); return tela.render('default', { onAbrir() {}, onFiltro, ...props }); };
  let r = await ciclo();
  assert.deepEqual(urls.splice(0), ['/api/admin/contratos/lista?filtro=todas&busca=Helena']);
  // Mudança externa da URL, sem desmontar: aplica, lê uma vez, não devolve onFiltro (sem laço com o router).
  props = { filtroInicial: 'canceladas', buscaInicial: 'Theo' }; r = await ciclo();
  assert.deepEqual(urls.splice(0), ['/api/admin/contratos/lista?filtro=canceladas&busca=Theo']);
  assert.equal(achar(r, 'input', '').props.value, 'Theo');
  assert.equal(elementos(r).find(e => e.type === 'button' && /^Canceladas/.test(texto(e)))!.props['aria-pressed'], true);
  // Menu "Contratos" (URL sem parâmetros): volta ao padrão.
  props = { filtroInicial: 'proximas', buscaInicial: '' }; r = await ciclo();
  assert.deepEqual(urls.splice(0), ['/api/admin/contratos/lista?filtro=proximas']);
  assert.equal(achar(r, 'input', '').props.value, '');
  assert.deepEqual(trocas, [], 'mudança externa não regrava a URL');
  // Troca feita pela própria lista: grava a URL e lê uma única vez (as props que voltam iguais não releem).
  (elementos(r).find(e => e.type === 'button' && /^Todas/.test(texto(e)))!.props.onClick as () => void)();
  r = await ciclo();
  assert.deepEqual(trocas, [['todas', '']]); assert.deepEqual(urls.splice(0), ['/api/admin/contratos/lista?filtro=todas']);
});
