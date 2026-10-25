import test from 'node:test';
import assert from 'node:assert/strict';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';
import * as contratoUrl from './contrato-url.ts';
import * as contratoTela from './contrato-tela.ts';
import * as versaoReferencia from '../../lib/contratos/versao-referencia.ts';

/** Regressões da revisão do código da fase 1 (C-1 a C-4): navegação por versão, confirmação de agenda e recusa financeira. */
const ID = '00000000-0000-4000-8000-000000000001', OUTRO = '00000000-0000-4000-8000-000000000002';
const V2 = '00000000-0000-4000-8000-0000000000a2';
const snapshot = (pacote: string, convidados: number) => ({ contratante: { nomeCompleto: 'Cliente de teste' }, aniversariante: { nome: 'Helena', idadeNoEvento: 6, temaFesta: 'Frozen' }, evento: { data: '2027-04-20', horarioInicio: '10:00:00', horarioFim: '14:00:00', pacote: { nome: pacote, codigo: 'X' }, convidados }, comercial: { valorFinalContrato: 6000 } });
const dados = () => ({
  festaId: null, contrato: { id: ID, status: 'ASSINADO' }, origemHistorica: null, tela: { salao: null, salaoAlteracao: null, estadoFesta: null },
  fluxo: { versao_vigente_id: '00000000-0000-4000-8000-0000000000a1', versao_em_preparacao_id: '00000000-0000-4000-8000-0000000000a3' }, documentos: [], assinaturas: [], financeiro: [], pendencias: [],
  revisoesOperacionais: [{ id: 'r3', contrato_versao_id: '00000000-0000-4000-8000-0000000000a3', estado: 'EM_ELABORACAO', hold_destino_adquirido_em: null, status_fechamento: 'X', ocupa_vigente: true, data_evento: '2027-04-20', data_vigente: '2027-04-20', horario_inicio: '10:00:00', horario_fim: '14:00:00', slot_alterado: false }],
  versoes: [
    { id: '00000000-0000-4000-8000-0000000000a3', numero_versao: 3, estado_edicao: 'EM_ELABORACAO', status: 'ATIVA', revisao: 1, origem_versao_id: '00000000-0000-4000-8000-0000000000a1', documento_revisado_id: null, criado_em: '2026-10-20T10:00:00Z', snapshot: snapshot('Festa Completa', 100) },
    { id: '00000000-0000-4000-8000-0000000000a2', numero_versao: 2, estado_edicao: 'CANCELADA', status: 'CANCELADA', revisao: 1, origem_versao_id: '00000000-0000-4000-8000-0000000000a1', documento_revisado_id: null, criado_em: '2026-10-10T10:00:00Z', snapshot: snapshot('Premium', 80), motivo_nova_versao: 'Teste descartado' },
    { id: '00000000-0000-4000-8000-0000000000a1', numero_versao: 1, estado_edicao: 'CONCLUIDA', status: 'ASSINADA', revisao: 1, origem_versao_id: null, documento_revisado_id: null, criado_em: '2026-10-04T10:00:00Z', snapshot: snapshot('Standard', 50) },
  ],
});
function Filho() { return null; }

function montar(url: { q: string }, fetchFalso: (u: string, init?: RequestInit) => Promise<Response>) {
  const tela = carregarComponente('components/admin/ContratoAdmin.tsx', {
    'next/navigation': { useSearchParams: () => new URLSearchParams(url.q), usePathname: () => '/admin/contratos', useRouter: () => ({ push() {}, replace() {} }) },
    'next/link': { default: Filho }, './contratos-ux.module.css': cssFalso,
    '@/lib/http/admin-fetch': { adminFetch: fetchFalso, reautenticarSessao: async () => ({ ok: true }) },
    '@/lib/contratos/services/alteracoes': { analisarRevisao: (a: { evento: { pacote: { nome: string } } }, b: { evento: { pacote: { nome: string } } }) => ({ natureza: 'MATERIAL', campos: [{ campo: 'evento.pacote.nome', antes: a.evento.pacote.nome, depois: b.evento.pacote.nome }] }) },
    '@/lib/contratos/assinatura-papel': { versaoAssinadaEmPapel: () => false, TEXTO_ASSINADO_EM_PAPEL: '' },
    '../../lib/contratos/documento/oficial/configuracao': { configuracaoModeloOficial: () => true },
    '@/lib/contratos/documento/formatters': { formatarMoeda: String, formatarFormaPagamento: () => 'A definir', formatarCondicaoPix: String },
    '@/lib/festas/apresentacao': { retornoFestaSeguro: () => null },
    './EdicaoFesta': { default: Filho }, './CancelarContratoFesta': { default: Filho },
    './inteligencia/PerguntarKidmais': { ContextoKidmais: Filho }, './PagamentosResumo': { default: Filho },
    './CriarPlanoFinanceiro': { default: Filho }, './criacao-financeira': { contextoCriacao: () => null },
    './financeiro-apresentacao': { contratoApresentacao: () => 'Contrato' },
    './contrato-url': { ...contratoUrl, opcaoForaDaLista: () => null },
    './contrato-tela': contratoTela, '@/lib/contratos/versao-referencia': versaoReferencia,
    './ContratoImportado': { default: Filho }, './OrigemHistoricaContrato': { default: Filho }, './importacao/IntegracaoContrato': { default: Filho },
  });
  const ciclo = async () => { tela.render(); tela.efeitos(); for (let i = 0; i < 6; i++) await tique(); tela.render(); tela.efeitos(); return tela.render(); };
  return { tela, ciclo, render: () => tela.render() };
}
async function comJanela(trabalho: () => Promise<void>) {
  const anterior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '', search: '?contratoId=' + ID, pathname: '/admin/contratos' }, history: { state: null, replaceState() {} }, addEventListener() {}, removeEventListener() {} } });
  try { await trabalho(); } finally { if (anterior) Object.defineProperty(globalThis, 'window', anterior); else Reflect.deleteProperty(globalThis, 'window'); }
}
const clicar = (arvore: unknown, rotulo: string) => (achar(arvore, 'button', rotulo).props.onClick as () => void)();

test('C-1: mudar só o versaoId (ver versão, fechar consulta, voltar/avançar) mantém o detalhe, sem nova leitura nem "Carregando"', () => comJanela(async () => {
  const url = { q: `contratoId=${ID}` }; let detalhes = 0;
  const m = montar(url, async (u: string) => { if (u.includes('contratoId=')) detalhes++; return Response.json({ ok: true, data: u.includes('contratoId=') ? dados() : [] }); });
  await m.ciclo(); assert.equal(detalhes, 1);
  for (const passo of [`contratoId=${ID}&versaoId=00000000-0000-4000-8000-0000000000a2`, `contratoId=${ID}`, `contratoId=${ID}&versaoId=00000000-0000-4000-8000-0000000000a2`]) {
    url.q = passo; const r = await m.ciclo();
    assert.equal(elementos(r).some(e => e.type === 'p' && texto(e) === 'Carregando contrato…'), false, 'sem aviso de carregamento');
    assert.match(texto(r), /Aniversário de Helena/);
    assert.equal(/Consultando V2/.test(texto(r)), passo.includes('versaoId'), passo);
  }
  assert.equal(detalhes, 1, 'nenhuma nova leitura do detalhe');
  // C-4: a consulta mostra as diferenças em relação à própria origem (V1), sem controles além de "Fechar consulta".
  const consulta = achar(m.render(), 'section', 'Consulta da versão V2');
  const dif = elementos(consulta).find(e => typeof e.type === 'function' && (e.type as { name: string }).name === 'DiferencasDaVersao')!;
  assert.equal((dif.props.origem as { numero_versao: number }).numero_versao, 1);
  const arvoreDif = (dif.type as (p: unknown) => unknown)(dif.props);
  assert.match(texto(arvoreDif), /Diferenças em relação à V1/); assert.match(texto(arvoreDif), /Standard.*Premium/);
  assert.equal(elementos(arvoreDif).some(e => e.type === 'button'), false, 'diferenças só leitura');
  assert.deepEqual(elementos(consulta).filter(e => e.type === 'button').map(texto), ['Fechar consulta']);
  // Trocar de contrato continua limpando o detalhe e lendo de novo.
  url.q = `contratoId=${OUTRO}`; await m.ciclo(); assert.equal(detalhes, 2);
}));

test('C-2: "Destino conferido" some ao editar observações, não vale com o editor aberto e resposta atrasada é descartada', () => comJanela(async () => {
  const url = { q: `contratoId=${ID}` }; let liberar: (() => void) | null = null; let segurar = false;
  const m = montar(url, async (u: string, init?: RequestInit) => {
    if (init?.method === 'POST') { if (segurar) await new Promise<void>(r => { liberar = r; }); return Response.json({ ok: true, data: { revalidado: true } }); }
    return Response.json({ ok: true, data: u.includes('contratoId=') ? dados() : [] });
  });
  await m.ciclo();
  const conferido = () => /Destino conferido às/.test(texto(m.render()));
  clicar(m.render(), 'Revalidar destino'); await m.ciclo(); assert.equal(conferido(), true);
  // Editar observações invalida.
  (elementos(m.render()).find(e => e.type === 'textarea')!.props.onChange as (e: unknown) => void)({ target: { value: 'nova observação' } });
  await m.ciclo(); assert.equal(conferido(), false);
  // Editor aberto: revalidar não mostra confirmação; fechar o editor também não traz de volta.
  clicar(m.render(), 'Editar dados desta revisão'); await m.ciclo();
  clicar(m.render(), 'Revalidar destino'); await m.ciclo(); assert.equal(conferido(), false);
  clicar(m.render(), 'Fechar edição'); await m.ciclo(); assert.equal(conferido(), false);
  // Resposta atrasada: uma edição acontece antes de a revalidação responder.
  segurar = true; clicar(m.render(), 'Revalidar destino'); await m.ciclo();
  (elementos(m.render()).find(e => e.type === 'textarea')!.props.onChange as (e: unknown) => void)({ target: { value: 'outra' } });
  await m.ciclo(); liberar!(); await m.ciclo(); await m.ciclo(); assert.equal(conferido(), false);
  // Sair e voltar ao mesmo contrato com a resposta pendente: descartada.
  clicar(m.render(), 'Revalidar destino'); await m.ciclo();
  url.q = `contratoId=${OUTRO}`; await m.ciclo(); url.q = `contratoId=${ID}`; await m.ciclo();
  liberar!(); await m.ciclo(); await m.ciclo(); assert.equal(conferido(), false);
  // Navegar entre versões (consultar e voltar, sem recarregar o detalhe) também invalida.
  segurar = false; clicar(m.render(), 'Revalidar destino'); await m.ciclo(); assert.equal(conferido(), true);
  url.q = `contratoId=${ID}&versaoId=${V2}`; await m.ciclo(); assert.equal(conferido(), false, 'durante a consulta');
  url.q = `contratoId=${ID}`; await m.ciclo(); assert.equal(conferido(), false, 'depois de voltar');
  // Resposta pendente e navegação por versão antes de ela chegar: descartada.
  segurar = true; clicar(m.render(), 'Revalidar destino'); await m.ciclo();
  url.q = `contratoId=${ID}&versaoId=${V2}`; await m.ciclo(); url.q = `contratoId=${ID}`; await m.ciclo();
  liberar!(); await m.ciclo(); await m.ciclo(); assert.equal(conferido(), false);
}));

test('C-3: recusa numa leitura posterior do painel financeiro tira os números dos cartões', async () => {
  const props: Record<string, unknown>[] = [];
  function Fin(p: Record<string, unknown>) { props.push(p); return null; }
  const painel = { valorVigente: '600000', posicao: { obrigacao: '600000', liquido: '200000', saldo: '400000', credito: '0', reservado: '0' }, cobranca: { encerrada: false, saldoACobrar: '400000', acertoAdministrativoPendente: false }, futuro: [] };
  const tela = carregarComponente('components/admin/PagamentosResumo.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async () => Response.json({ ok: true, data: { painel } }) },
    './FinanceiroContrato': { default: Fin }, './contrato-tela': contratoTela, './contratos-ux.module.css': cssFalso,
  });
  const render = () => tela.render('default', { contratoId: ID, temVigente: true });
  render(); tela.efeitos(); await tique(); await tique();
  assert.match(texto(render()), /A cobrar/);
  const fin = elementos(render()).find(e => e.type === Fin)!;
  (fin.props.onFalha as (s: number, c: string) => void)(409, 'POSICAO_INCONSISTENTE');
  const depois = texto(render());
  assert.match(depois, /precisam de conferência \(POSICAO_INCONSISTENTE\)/); assert.doesNotMatch(depois, /A cobrar|Recebido/);
  assert.equal(elementos(render()).some(e => e.type === Fin), false);
});

test('C-3: o painel financeiro existente comunica a recusa 409 da primeira leitura', async () => {
  const falhas: Array<[number, string]> = [];
  const tela = carregarComponente('components/admin/FinanceiroContrato.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async () => Response.json({ ok: false, erro: 'Posição financeira inconsistente.', codigo: 'POSICAO_INCONSISTENTE' }, { status: 409 }) },
    './financeiro.module.css': cssFalso,
    './financeiro-apresentacao': { propostaDeParcelas: () => [], origemApresentacao: String, dataApresentacao: String, textoHistorico: String },
    '@/lib/pagamentos/services/projecao-tratamento': { projetarTratamento: () => null, serializarEscolhaCredito: String },
  });
  tela.render('default', { contratoId: ID, onFalha: (s: number, c: string) => falhas.push([s, c]) }); tela.efeitos(); await tique(); await tique();
  assert.deepEqual(falhas, [[409, 'POSICAO_INCONSISTENTE']]);
});

test('C-3: falha de rede, resposta não-JSON (502 HTML) e falha em "Atualizar posição" também avisam onFalha', async () => {
  const base = { numero: 1, id: 'v1', snapshot: { evento: { data: '2027-04-20' }, comercial: { valorFinalContrato: 6000 } } };
  const painel = { valorVigente: '600000', motivos: [], posicao: { obrigacao: '600000', recebido: '200000', estornado: '0', devolvido: '0', liquido: '200000', saldo: '400000', credito: '0', reservado: '0', disponivel: '0' },
    cobranca: { encerrada: false, saldoACobrar: '400000', acertoAdministrativoPendente: false }, futuro: [], pagamento: { id: 'p', status: 'PARCIAL', valor_total_contratado: '6000.00' }, contrato: { id: ID, status: 'ASSINADO' },
    original: base, vigente: base, reconhecida: base, posicaoHash: 'a'.repeat(64), parcelas: [], planos: [], recebimentos: [], estornos: [], devolucoes: [], reservas: [], ajustes: [], versoes: [], tratamentos: [], pendencias: [], origens: [], provas: [], timeline: [], excecoesHistoricas: [], itens: [], cronograma: null, forma: 'PIX_PARCELADO' };
  const montarFin = (respostas: Array<'ok' | 'rede' | 'html'>) => {
    const falhas: Array<[number, string | undefined]> = [];
    const tela = carregarComponente('components/admin/FinanceiroContrato.tsx', {
      '@/lib/http/admin-fetch': { adminFetch: async () => {
        const r = respostas.shift() ?? 'ok';
        if (r === 'rede') throw new TypeError('Failed to fetch');
        if (r === 'html') return new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
        return Response.json({ ok: true, data: { painel, papel: 'REPRESENTANTE_AUTORIZADO' } });
      } },
      './financeiro.module.css': cssFalso,
      './financeiro-apresentacao': { propostaDeParcelas: () => [], origemApresentacao: String, dataApresentacao: String, textoHistorico: String },
      '@/lib/pagamentos/services/projecao-tratamento': { projetarTratamento: () => ({ delta: '0', saldo: '0', credito: '0' }), serializarEscolhaCredito: String },
    });
    const render = () => tela.render('default', { contratoId: ID, onFalha: (s: number, c?: string) => falhas.push([s, c]) });
    return { falhas, render, efeitos: () => tela.efeitos() };
  };
  const esperar = async () => { for (let i = 0; i < 6; i++) await tique(); };
  // Primeira leitura com a rede caída.
  let f = montarFin(['rede']); f.render(); f.efeitos(); await esperar(); assert.deepEqual(f.falhas, [[0, undefined]]);
  // Primeira leitura 502 com HTML.
  f = montarFin(['html']); f.render(); f.efeitos(); await esperar(); assert.deepEqual(f.falhas, [[502, undefined]]);
  // Painel carregado; "Atualizar posição" com a rede caída e, depois, com 502 HTML.
  f = montarFin(['ok', 'rede', 'html']); f.render(); f.efeitos(); await esperar(); assert.deepEqual(f.falhas, []);
  clicar(f.render(), 'Atualizar posição'); await esperar(); assert.deepEqual(f.falhas, [[0, undefined]]);
  clicar(f.render(), 'Atualizar posição'); await esperar(); assert.deepEqual(f.falhas, [[0, undefined], [502, undefined]]);
});
