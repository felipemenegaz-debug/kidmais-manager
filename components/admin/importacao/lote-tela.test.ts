import test from 'node:test';
import assert from 'node:assert/strict';
import * as cliente from './cliente-importacao.ts';
import * as revisao from '../../../lib/importacao-contrato/revisao.ts';
import * as filaLote from './fila-lote.ts';
import * as executorLote from './executor-lote.ts';
import { achar, carregarComponente, cssFalso, elementos, talvez, texto, tique } from '../teste-componente.ts';
import * as errosFormulario from '../../../lib/ui/erros-formulario.ts';

/**
 * Lote L1 na tela real (ImportacaoReal + FilaLote + ListaAguardando), com o adminFetch falso contando cada chamada.
 * Os painéis do lote são inspecionados pelas props (o harness não renderiza componentes filhos).
 */
const ERROS_FORMULARIO = {
  '@/components/ui/ErrosFormulario': carregarComponente('components/ui/ErrosFormulario.tsx', { '@/lib/ui/erros-formulario': errosFormulario, './erros-formulario.module.css': cssFalso }).modulo,
  '@/lib/ui/erros-formulario': errosFormulario,
};
const FilaLote = function FilaLote() { return null; };
const ListaAguardando = function ListaAguardando() { return null; };
const IntegracaoContrato = function IntegracaoContrato() { return null; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const importacaoDe = (id: string, status = 'EM_REVISAO') => ({ id, versao: 2, status, extracao: { fonte: 'DOCUMENTO', arquivo: { nome: 'c.pdf', tipo: 'application/pdf', tamanhoBytes: 10 }, secoes: [] }, revisados: [], decisaoCliente: null });

type Chamada = { url: string; acao?: string; aberturaId?: string; documentoId?: string };
function tela(opcoes: { agir?: (acao: { acao: string }) => unknown; abrirDocumento?: (id: string) => unknown; segurarPrimeiroEnvio?: Promise<void>; envios?: Array<(() => Response | Promise<Response>) | undefined> } = {}) {
  const chamadas: Chamada[] = [];
  const acoes: unknown[] = [];
  let n = 0;
  const adminFetch = async (url: string, init: RequestInit = {}) => {
    if (url === cliente.ENDPOINT_DOCUMENTOS) {
      chamadas.push({ url });
      n += 1;
      if (n === 1 && opcoes.segurarPrimeiroEnvio) await opcoes.segurarPrimeiroEnvio;
      const roteirizado = opcoes.envios?.[n - 1];
      if (roteirizado) return roteirizado();
      return Response.json({ ok: true, data: { documentoId: `d000000${n}-0000-4000-8000-000000000000`, avisos: [], extracao: { secoes: [{ campos: [{ valor: 'Ana' }] }] } } });
    }
    const corpo = JSON.parse(String(init.body));
    chamadas.push({ url, acao: corpo.acao, aberturaId: corpo.aberturaId, documentoId: corpo.documentoId });
    return Response.json({ ok: true, data: { importacao: { id: `1${corpo.documentoId.slice(1)}`, versao: 2, status: 'EM_REVISAO' } } });
  };
  const t = carregarComponente('components/admin/importacao/ImportacaoReal.tsx', {
    'next/navigation': { useRouter: () => ({ replace() {} }) }, 'next/link': { default: 'a' }, '@/lib/http/admin-fetch': { adminFetch },
    '@/components/admin/inteligencia/cliente-inteligencia': { decidirOperacao: async () => { throw Error('sem gate'); } },
    '@/components/admin/inteligencia/AcaoKidmais': { PreviewAcao: () => null }, '@/lib/importacao-contrato/revisao': revisao,
    './cliente-importacao': {
      ...cliente,
      agirNaImportacao: async (_b: unknown, estado: { id: string }, acao: { acao: string }) => { acoes.push({ id: estado.id, ...acao }); return opcoes.agir ? opcoes.agir(acao) : { ok: true, dados: { importacao: importacaoDe(estado.id), plano: null } }; },
      abrirDocumento: async (_b: unknown, id: string) => { acoes.push({ abrirDocumento: id }); return opcoes.abrirDocumento ? opcoes.abrirDocumento(id) : { ok: true, dados: { importacao: importacaoDe(`1${id.slice(1)}`), plano: null } }; },
    },
    './importacao.module.css': cssFalso, './importacao-real.module.css': cssFalso, ...ERROS_FORMULARIO, './IntegracaoContrato': { default: IntegracaoContrato },
    './FilaLote': { default: FilaLote }, './ListaAguardando': { default: ListaAguardando }, './fila-lote': filaLote, './executor-lote': executorLote,
  });
  t.render(); t.efeitos();
  const entrada = () => elementos(t.render()).find((e) => e.type === 'input' && e.props.type === 'file')!;
  const escolher = (arquivos: File[]) => (entrada().props.onChange as (e: unknown) => void)({ target: { files: arquivos, value: 'x' } });
  const fila = () => elementos(t.render()).find((e) => e.type === FilaLote)?.props as { lote: filaLote.Lote; ocupado: boolean; onRevisar(i: filaLote.ItemLote): void; onRetirar(i: filaLote.ItemLote): void } | undefined;
  const lista = () => elementos(t.render()).find((e) => e.type === ListaAguardando)?.props as { onRevisar(i: unknown): void } | undefined;
  const soltar = (arquivos: File[]) => (elementos(t.render()).find((e) => typeof e.props.onDrop === 'function')!.props.onDrop as (e: unknown) => void)({ preventDefault() {}, dataTransfer: { files: arquivos } });
  return { t, chamadas, acoes, entrada, escolher, soltar, fila, lista };
}
const pdf = (nome: string) => new File(['%PDF-1.4'], nome, { type: 'application/pdf' });
const esperar = async (vezes = 12) => { for (let k = 0; k < vezes; k++) await tique(); };

test('tela: 21 PDFs são recusados antes de qualquer envio; nenhum lote começa', async () => {
  const s = tela();
  assert.equal(s.entrada().props.multiple, true);
  s.escolher(Array.from({ length: 21 }, (_, k) => pdf(`c${k}.pdf`)));
  await esperar();
  const arvore = s.t.render();
  assert.match(texto(achar(arvore, 'p', /Escolha até 20 PDFs/)), /foram 21.*Nada foi enviado/);
  assert.equal(s.chamadas.length, 0);
  assert.equal(s.fila(), undefined);
});

test('tela: lote de 2 PDFs envia um por vez, abre cada um com identidade própria e fica pronto; arquivo único segue o fluxo de sempre', async () => {
  const s = tela();
  s.escolher([pdf('a.pdf'), pdf('b.pdf'), new File(['x'], 'nota.txt', { type: 'text/plain' })]);
  await esperar();
  assert.deepEqual(s.chamadas.map((c) => c.acao ?? 'upload'), ['upload', 'abrir', 'upload', 'abrir']);
  const ids = s.chamadas.filter((c) => c.acao).map((c) => c.aberturaId!);
  assert.ok(ids.every((i) => UUID.test(i)) && new Set(ids).size === 2, 'uma identidade UUID por item');
  const f = s.fila()!;
  assert.deepEqual(f.lote.itens.map((i) => [i.nome, i.estado]), [['a.pdf', 'PRONTO'], ['b.pdf', 'PRONTO']]);
  assert.equal(f.ocupado, false);
  assert.match(texto(s.t.render()), /Ficaram fora do lote \(não são PDF\): nota\.txt/);
  assert.equal(s.entrada().props.disabled, false, 'lote ocioso: pode escolher outros arquivos');
});

test('tela: Revisar e Próximo da fila sempre leem de novo; descartar volta à fila e encerra o item; lista abre o lido pelo abrir', async () => {
  const s = tela();
  s.escolher([pdf('a.pdf'), pdf('b.pdf')]);
  await esperar();
  const [a] = s.fila()!.lote.itens;
  s.fila()!.onRevisar(a);
  await esperar();
  assert.deepEqual(s.acoes, [{ id: a.importacaoId, acao: 'ler' }], 'R1-5: Revisar lê a versão atual');
  assert.ok(achar(s.t.render(), 'button', 'Cancelar importação'));
  // Descartar pela própria revisão: volta ao envio (como sempre) e o item sai dos pendentes.
  (achar(s.t.render(), 'button', 'Cancelar importação').props.onClick as () => void)();
  (achar(s.t.render(), 'button', 'Sim, cancelar importação').props.onClick as () => void)();
  await esperar();
  const depois = s.fila()!;
  assert.deepEqual(depois.lote.itens.map((i) => [i.estado, i.encerramento, i.concluido]), [['ENCERRADO', 'DESCARTADA', true], ['PRONTO', null, false]]);
  assert.equal(filaLote.proximoParaRevisar(depois.lote)?.nome, 'b.pdf');
  // Lista "aguardando revisão": LIDO abre pelo `abrir` sem identidade; REVISAO lê.
  s.acoes.length = 0;
  s.lista()!.onRevisar({ grupo: 'LIDO', documentoId: 'e0000000-0000-4000-8000-000000000000', importacaoId: null, versao: null, arquivo: 'x.pdf', enviadoEm: '', contratante: null, dataFesta: null });
  await esperar();
  assert.deepEqual(s.acoes, [{ abrirDocumento: 'e0000000-0000-4000-8000-000000000000' }]);
});

test('tela: falha ao ler na revisão do lote volta ao envio com a mensagem, sem perder o lote', async () => {
  const s = tela({ agir: () => ({ ok: false, mensagem: 'A empresa ou a sessão mudou. Nada foi alterado.' }) });
  s.escolher([pdf('a.pdf'), pdf('b.pdf')]);
  await esperar();
  s.fila()!.onRevisar(s.fila()!.lote.itens[0]);
  await esperar();
  assert.ok(talvez(s.t.render(), 'p', 'A empresa ou a sessão mudou. Nada foi alterado.'));
  assert.deepEqual(s.fila()!.lote.itens.map((i) => i.estado), ['PRONTO', 'PRONTO']);
});

test('tela (r2 P2-3): com o primeiro envio do lote pendente, soltar outro PDF ou escolher pelo seletor não envia nada', async () => {
  let soltarEnvio!: () => void;
  const s = tela({ segurarPrimeiroEnvio: new Promise<void>((r) => { soltarEnvio = r; }) });
  s.escolher([pdf('a.pdf'), pdf('b.pdf')]);
  await esperar();
  assert.equal(s.chamadas.length, 1, 'primeiro envio em voo');
  assert.equal(s.entrada().props.disabled, true);
  s.soltar([pdf('solto.pdf')]);
  await esperar();
  assert.equal(s.chamadas.length, 1, 'arquivo solto não sai em paralelo ao lote');
  s.soltar([pdf('x.pdf'), pdf('y.pdf')]);
  (s.entrada().props.onChange as (e: unknown) => void)({ target: { files: [pdf('z.pdf')], value: 'x' } });
  await esperar();
  assert.equal(s.chamadas.length, 1, 'nada novo saiu: nem envio avulso, nem outro lote');
  assert.ok(talvez(s.t.render(), 'p', filaLote.MENSAGEM_LOTE_OCUPADO));
  assert.deepEqual(s.fila()!.lote.itens.map((i) => i.nome), ['a.pdf', 'b.pdf'], 'o lote não foi trocado');
  soltarEnvio();
  await esperar(20);
  assert.deepEqual(s.chamadas.map((c) => c.acao ?? 'upload'), ['upload', 'abrir', 'upload', 'abrir'], 'sequência única preservada');
  // Lote ocioso: arrastar volta a funcionar (envio único de sempre).
  s.soltar([pdf('depois.pdf')]);
  await esperar();
  assert.deepEqual(s.chamadas.slice(4).map((c) => [c.acao ?? 'upload', c.aberturaId]), [['upload', undefined], ['abrir', undefined]], 'envio único: upload + abrir sem identidade');
});

test('tela (r3 P2-3): retirar o item cuja reconciliação está em voo não libera a tela até a chamada terminar', async () => {
  let soltarReconciliacao!: (r: Response) => void;
  const reconciliacao = new Promise<Response>((r) => { soltarReconciliacao = r; });
  // 1º PRONTO; 2º recebe 500 (resultado desconhecido) e a reconciliação automática fica pendente.
  const s = tela({ envios: [undefined, () => new Response('erro', { status: 500 }), () => reconciliacao] });
  s.escolher([pdf('a.pdf'), pdf('b.pdf')]);
  await esperar(20);
  assert.deepEqual(s.chamadas.map((c) => c.acao ?? 'upload'), ['upload', 'abrir', 'upload', 'upload'], 'reconciliação do 2º em voo');
  const b = s.fila()!.lote.itens[1];
  s.fila()!.onRetirar(b);
  await esperar();
  const depois = s.fila()!;
  assert.equal(depois.lote.itens[1].estado, 'RETIRADO', 'o item saiu do lote');
  assert.equal(filaLote.loteOcupado(depois.lote), false, 'pelo estado visual o lote está livre');
  assert.equal(depois.ocupado, true, 'mas a chamada em voo mantém a fila ocupada');
  assert.equal(s.entrada().props.disabled, true, 'seletor desabilitado com a chamada em voo');
  s.soltar([pdf('solto.pdf')]);
  await esperar();
  assert.equal(s.chamadas.length, 4, 'arquivo solto não sai em paralelo à chamada pendente');
  (s.entrada().props.onChange as (e: unknown) => void)({ target: { files: [pdf('z.pdf'), pdf('w.pdf')], value: 'x' } });
  await esperar();
  assert.equal(s.chamadas.length, 4, 'nada sai em paralelo à chamada pendente');
  assert.ok(talvez(s.t.render(), 'p', filaLote.MENSAGEM_LOTE_OCUPADO));
  assert.deepEqual(s.fila()!.lote.itens.map((i) => i.nome), ['a.pdf', 'b.pdf'], 'o lote não foi trocado');
  // A resposta tardia chega: o item continua retirado e a tela libera.
  soltarReconciliacao(Response.json({ ok: true, data: { documentoId: 'd0000009-0000-4000-8000-000000000000', avisos: [], extracao: { secoes: [] } } }));
  await esperar(20);
  assert.equal(s.fila()!.lote.itens[1].estado, 'RETIRADO');
  assert.equal(s.fila()!.ocupado, false);
  assert.equal(s.entrada().props.disabled, false);
  assert.equal(s.chamadas.length, 4, 'item retirado não é aberto');
  s.soltar([pdf('depois.pdf')]);
  await esperar();
  assert.deepEqual(s.chamadas.slice(4).map((c) => c.acao ?? 'upload'), ['upload', 'abrir'], 'livre: arrastar volta a funcionar');
});

for (const fim of ['corpo chega', 'leitura do corpo falha'] as const) {
  test(`tela (r4 P2-3): reconciliação entrega os cabeçalhos e o corpo fica pendente; retirar não libera até o fim da leitura (${fim})`, async () => {
    let corpo!: ReadableStreamDefaultController<Uint8Array>;
    // Response e ReadableStream reais: status 200 já entregue, corpo ainda chegando.
    const pendente = () => new Response(new ReadableStream<Uint8Array>({ start(c) { corpo = c; } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const s = tela({ envios: [undefined, () => new Response('erro', { status: 500 }), pendente] });
    s.escolher([pdf('a.pdf'), pdf('b.pdf')]);
    await esperar(20);
    assert.deepEqual(s.chamadas.map((c) => c.acao ?? 'upload'), ['upload', 'abrir', 'upload', 'upload'], 'reconciliação do 2º com corpo pendente');
    s.fila()!.onRetirar(s.fila()!.lote.itens[1]);
    await esperar();
    assert.equal(s.fila()!.lote.itens[1].estado, 'RETIRADO');
    assert.equal(s.fila()!.ocupado, true, 'corpo pendente mantém a fila ocupada');
    assert.equal(s.entrada().props.disabled, true, 'seletor desabilitado enquanto o corpo não terminou');
    s.soltar([pdf('solto.pdf')]);
    await esperar();
    assert.equal(s.chamadas.length, 4, 'arquivo solto não sai antes de terminar a leitura do corpo anterior');
    if (fim === 'corpo chega') {
      corpo.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, data: { documentoId: 'd0000009-0000-4000-8000-000000000000', avisos: [], extracao: { secoes: [] } } })));
      corpo.close();
    } else {
      corpo.error(new Error('conexão caiu no meio do corpo'));
    }
    await esperar(20);
    assert.equal(s.fila()!.lote.itens[1].estado, 'RETIRADO', 'resultado tardio não ressuscita o item');
    assert.equal(s.fila()!.ocupado, false);
    assert.equal(s.entrada().props.disabled, false);
    assert.equal(s.chamadas.length, 4);
    s.soltar([pdf('depois.pdf')]);
    await esperar();
    assert.deepEqual(s.chamadas.slice(4).map((c) => c.acao ?? 'upload'), ['upload', 'abrir'], 'livre depois da leitura: arrastar volta a funcionar');
  });
}

test('tela (r2): concluir a integração de um item do lote volta à fila, encerra o item como importado e Próximo da fila lê o seguinte', async () => {
  const plano = { pronto: true, bloqueios: [], avisos: [], recusa: null, match: null };
  const s = tela({ agir: () => ({ ok: true, dados: { importacao: importacaoDe('10000001-0000-4000-8000-000000000000'), plano } }) });
  s.escolher([pdf('a.pdf'), pdf('b.pdf')]);
  await esperar();
  const [a, b] = s.fila()!.lote.itens;
  s.fila()!.onRevisar(a);
  await esperar();
  (achar(s.t.render(), 'button', 'Continuar para festa e pagamentos').props.onClick as () => void)();
  await esperar();
  const integracao = elementos(s.t.render()).find((e) => e.type === IntegracaoContrato)!.props as { onIntegrado(r: { contratoId: string }): void };
  integracao.onIntegrado({ contratoId: 'c0000000-0000-4000-8000-000000000000' });
  await esperar();
  const f = s.fila()!;
  assert.deepEqual(f.lote.itens.map((i) => [i.nome, i.estado, i.encerramento, i.concluido]), [['a.pdf', 'ENCERRADO', 'IMPORTADA', true], ['b.pdf', 'PRONTO', null, false]]);
  assert.equal(filaLote.proximoParaRevisar(f.lote)?.id, b.id);
  s.acoes.length = 0;
  f.onRevisar(filaLote.proximoParaRevisar(f.lote)!);
  await esperar();
  assert.deepEqual(s.acoes, [{ id: b.importacaoId, acao: 'ler' }], 'Próximo da fila lê de novo o seguinte');
});

test('FilaLote real: botões por estado, parada, pausa de orçamento com Continuar, Tentar de novo só fora do envio automático', () => {
  const comp = carregarComponente('components/admin/importacao/FilaLote.tsx', {
    'next/link': { default: 'a' }, '@/lib/importacao-contrato/revisao': revisao, './fila-lote': filaLote, './importacao.module.css': cssFalso, './importacao-real.module.css': cssFalso,
  });
  const base = filaLote.novoLote(['pronto', 'incerto', 'falhou', 'fila', 'importado', 'descartado', 'ambiguo'].map((n, k) => ({ id: n, aberturaId: `a${k}`, nome: `${n}.pdf`, tamanho: 2048 })));
  const lote: filaLote.Lote = {
    pausas: ['ORCAMENTO'], parada: null,
    itens: [
      { ...base.itens[0], estado: 'PRONTO', importacaoId: 'i', documentoId: 'd0' },
      { ...base.itens[1], estado: 'INCERTO', etapaIncerta: 'UPLOAD', tentativas: 2, motivo: filaLote.MENSAGEM_INCERTA },
      { ...base.itens[2], estado: 'FALHOU', podeRepetir: true, motivo: 'Leitura expirou.' },
      base.itens[3],
      { ...base.itens[4], estado: 'ENCERRADO', encerramento: 'IMPORTADA', importacaoId: 'f0000000-0000-4000-8000-000000000001', documentoId: 'd4', motivo: 'Este contrato já foi importado.' },
      { ...base.itens[5], estado: 'ENCERRADO', encerramento: 'DESCARTADA', importacaoId: 'f0000000-0000-4000-8000-000000000002', documentoId: 'd5' },
      { ...base.itens[6], estado: 'LIDO_SEM_REVISAO', exigeAbertura: true, documentoId: 'd6', motivo: 'Este contrato foi concluído ou descartado depois do envio. Confira antes de abrir de novo.' },
    ],
  };
  const chamados: string[] = [];
  const props = (ocupado: boolean, l = lote) => ({ lote: l, ocupado, onRevisar: (i: filaLote.ItemLote) => chamados.push(`revisar:${i.id}`), onTentar: (i: filaLote.ItemLote) => chamados.push(`tentar:${i.id}`), onAbrirDeNovo: (i: filaLote.ItemLote) => chamados.push(`abrir:${i.id}`), onRetirar: (i: filaLote.ItemLote) => chamados.push(`retirar:${i.id}`), onContinuar: () => chamados.push('continuar'), onNovoLote: () => chamados.push('novo') });
  let arvore = comp.render('default', props(false));
  assert.ok(achar(arvore, 'button', 'Revisar pronto.pdf'));
  assert.equal(talvez(arvore, 'button', 'Revisar incerto.pdf'), undefined);
  assert.ok(achar(arvore, 'button', 'Tentar de novo incerto.pdf'));
  assert.ok(achar(arvore, 'button', 'Tentar de novo falhou.pdf'));
  assert.ok(achar(arvore, 'button', 'Retirar incerto.pdf do lote'));
  assert.equal(talvez(arvore, 'button', 'Retirar pronto.pdf do lote'), undefined, 'pronto não se retira: está na lista');
  assert.match(texto(arvore), /limite de leitura por IA/);
  // P3 (r2): importado ⇒ "Ver contrato" pela URL do contrato importado; descartado não tem link.
  assert.equal(achar(arvore, 'a', 'Ver contrato importado.pdf').props.href, '/admin/contratos?importacaoId=f0000000-0000-4000-8000-000000000001');
  assert.equal(talvez(arvore, 'a', 'Ver contrato descartado.pdf'), undefined);
  // P2-1 (r2): recuperação ambígua ⇒ só "Abrir de novo" (decisão da pessoa), sem "Tentar de novo" automático.
  assert.equal(talvez(arvore, 'button', 'Tentar de novo ambiguo.pdf'), undefined);
  assert.ok(achar(arvore, 'button', 'Retirar ambiguo.pdf do lote'));
  (achar(arvore, 'button', 'Continuar enviando').props.onClick as () => void)();
  (achar(arvore, 'button', 'Próximo da fila').props.onClick as () => void)();
  (achar(arvore, 'button', 'Abrir de novo ambiguo.pdf').props.onClick as () => void)();
  assert.deepEqual(chamados, ['continuar', 'revisar:pronto', 'abrir:ambiguo']);
  arvore = comp.render('default', props(true));
  assert.equal(talvez(arvore, 'button', 'Tentar de novo incerto.pdf'), undefined, 'ocupado: sem repetição manual');
  assert.equal(talvez(arvore, 'button', 'Enviar outros arquivos'), undefined);
  assert.equal(talvez(arvore, 'button', 'Abrir de novo ambiguo.pdf'), undefined, 'ocupado: sem abertura manual');
  arvore = comp.render('default', props(false, { ...lote, parada: { tipo: 'INVALIDAR', mensagem: 'A empresa mudou.' } }));
  assert.match(texto(achar(arvore, 'p', /Envio interrompido/)), /A empresa mudou\. Os arquivos já lidos continuam salvos\./);
  assert.equal(talvez(arvore, 'button', 'Continuar enviando'), undefined, 'parado: a pausa de orçamento não aparece');
});

test('ListaAguardando real: some quando vazia; Mostrar mais pede a próxima página pelo cursor; erro aparece', async () => {
  const pedidos: Array<string | undefined> = [];
  const item = (n: number) => ({ grupo: 'REVISAO', documentoId: `d${n}`, importacaoId: `i${n}`, versao: 1, arquivo: `c${n}.pdf`, enviadoEm: '2026-11-03T12:00:00.000000Z', contratante: `Pessoa ${n}`, dataFesta: '2026-12-05' });
  let paginas: Array<{ ok: boolean; dados?: unknown; mensagem?: string }> = [];
  const comp = carregarComponente('components/admin/importacao/ListaAguardando.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async () => new Response() },
    './cliente-importacao': { listarParaRevisao: async (_b: unknown, cursor?: string) => { pedidos.push(cursor); return paginas.shift(); } },
    './importacao.module.css': cssFalso, './importacao-real.module.css': cssFalso,
  });
  paginas = [{ ok: true, dados: { itens: [], proximo: null } }];
  comp.render('default', { atualizar: 0, onRevisar() {} }); comp.efeitos(); await tique();
  assert.equal(comp.render('default', { atualizar: 0, onRevisar() {} }), null);
  paginas = [{ ok: true, dados: { itens: [item(1)], proximo: 'CUR' } }, { ok: true, dados: { itens: [item(2)], proximo: null } }];
  comp.render('default', { atualizar: 1, onRevisar() {} }); comp.efeitos(); await tique();
  let arvore = comp.render('default', { atualizar: 1, onRevisar() {} });
  assert.match(texto(arvore), /Pessoa 1.*05\/12\/2026/);
  (achar(arvore, 'button', 'Mostrar mais').props.onClick as () => void)();
  await tique();
  arvore = comp.render('default', { atualizar: 1, onRevisar() {} });
  assert.deepEqual(pedidos, [undefined, undefined, 'CUR']);
  assert.match(texto(arvore), /Pessoa 1.*Pessoa 2/);
  assert.equal(talvez(arvore, 'button', 'Mostrar mais'), undefined);
  paginas = [{ ok: false, mensagem: 'Sem acesso.' }];
  comp.render('default', { atualizar: 2, onRevisar() {} }); comp.efeitos(); await tique();
  assert.ok(talvez(comp.render('default', { atualizar: 2, onRevisar() {} }), 'p', 'Sem acesso.'));
});
