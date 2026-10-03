import assert from 'node:assert/strict';
import test from 'node:test';
import * as form from './integracao-form.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../teste-componente.ts';

const IMP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const opcoes = {
  disponivel: true, hoje: '2026-10-02', integracao: null,
  cliente: { id: 'c1', nome: 'Ana Souza', ativo: true },
  documento: { pacote: 'Festa Completa 2019', aniversariante: 'Lia', tema: 'Fundo do mar' },
  sugestao: { evento: { data: '2026-11-14', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 }, valorContratadoCentavos: 850000, condicaoDocumento: 'Entrada de 30% e saldo à vista', parcelasPrevistas: [{ valorCentavos: 255000, vencimento: '2026-08-01' }, { valorCentavos: 595000, vencimento: '2026-11-14' }] },
  estabelecimentos: [{ id: 'u1', nome: 'Unidade Centro' }],
  pacotes: [{ id: 'p1', codigo: 'COMPLETA', nome: 'Festa Completa', duracaoMinutos: 240, ativo: true }],
  formas: ['PIX'], declaracao: 'Conferi o documento original assinado em papel.',
};
const resumo = {
  contrato: { cliente: 'Ana Souza', pacoteDocumento: 'Festa Completa 2019', pacoteReferencia: 'Festa Completa (COMPLETA)', unidade: 'Unidade Centro', valorContratadoCentavos: 850000, conferencia: 'Contrato assinado em papel.' },
  festa: { data: '2026-11-14', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80, aniversariante: 'Lia', tema: 'Fundo do mar', aniversarianteCadastro: 'NOVO' },
  agenda: { ocupa: true, descricao: 'Ocupa a agenda em 14/11/2026, das 14:00 às 18:00 (Unidade Centro).' },
  financeiro: { situacao: 'PARCIALMENTE_PAGO', contratadoCentavos: 850000, recebidoCentavos: 255000, saldoCentavos: 595000, parcelas: [], recebimentos: [{ numero: 1, valorCentavos: 255000, data: '2026-08-03', forma: 'PIX' }], aReceber: [{ numero: 2, valorCentavos: 595000, vencimento: '2026-11-14', situacao: 'A_RECEBER', recebidaEm: null, forma: null }] },
  campos: [],
};

function montar(confirmarResposta: () => Promise<unknown>) {
  const chamadas: Array<{ fn: string; args: unknown[] }> = [];
  const Link = 'a';
  const tela = carregarComponente('components/admin/importacao/IntegracaoContrato.tsx', {
    'next/link': { default: Link },
    '@/lib/http/admin-fetch': { adminFetch: async () => new Response() },
    './integracao-form': form,
    './importacao.module.css': cssFalso, './integracao.module.css': cssFalso,
    './cliente-integracao': {
      lerOpcoes: async () => ({ ok: true, dados: structuredClone(opcoes) }),
      novaChave: () => '88888888-8888-4888-8888-888888888888',
      simular: async (...args: unknown[]) => { chamadas.push({ fn: 'simular', args }); const d = args[2] as { conferenciaDeclarada: boolean };
        return { ok: true, dados: { integrada: false, pronto: true, bloqueios: [], avisos: d.conferenciaDeclarada ? [] : ['Para confirmar, declare a conferência do documento original.'], resumo, resumoHash: d.conferenciaDeclarada ? 'b'.repeat(64) : 'a'.repeat(64), possiveisVinculos: [] } }; },
      confirmar: async (...args: unknown[]) => { chamadas.push({ fn: 'confirmar', args }); return confirmarResposta(); },
      simularFinanceiro: async () => { throw Error('não usado'); },
      conferirFinanceiro: async () => { throw Error('não usado'); },
    },
  });
  return { tela, chamadas };
}

const evento = (value: unknown, checked?: boolean) => ({ target: { value, checked } });
/** Expande os subcomponentes puros do módulo (sem hooks), que o harness deixa como elementos. */
const SUBCOMPONENTES = new Set(['Erros', 'ResumoPagamentos', 'Concluida']);
function expandir(no: unknown): unknown {
  if (Array.isArray(no)) return no.map(expandir);
  if (!no || typeof no !== 'object') return no;
  const e = no as Elemento;
  if (typeof e.type === 'function' && SUBCOMPONENTES.has((e.type as { name: string }).name)) return expandir((e.type as (p: unknown) => unknown)(e.props));
  return { ...e, props: { ...e.props, children: expandir(e.props?.children) } };
}
const radio = (arvore: unknown, rotulo: RegExp) => {
  const label = elementos(arvore).find((e) => e.type === 'label' && rotulo.test(texto(e)))!;
  return elementos(label.props.children).find((e) => e.type === 'input') as Elemento;
};
async function carregar(tela: ReturnType<typeof montar>['tela']) {
  tela.render('default', { importacaoId: IMP }); tela.efeitos(); await tique();
  return tela.render('default', { importacaoId: IMP });
}
const ver = (tela: ReturnType<typeof montar>['tela']) => expandir(tela.render('default', { importacaoId: IMP }));

test('festa e agenda: situação começa em branco; cancelado não vira festa e não avança', async () => {
  const { tela } = montar(async () => ({ ok: true, dados: {} }));
  let a = await carregar(tela);
  assert.equal((achar(a, 'button', 'Continuar para pagamentos').props.disabled), true);
  assert.equal(radio(a, /Vigente/).props.checked, false);
  (radio(a, /Cancelado/).props.onChange as (e: unknown) => void)(evento('on'));
  a = ver(tela);
  assert.match(texto(a), /Contrato cancelado ou não confirmado não vira festa e não ocupa agenda/);
  assert.equal(achar(a, 'button', 'Continuar para pagamentos').props.disabled, true);
});

test('fluxo completo: pagamentos conferidos, revisão do servidor, declaração obrigatória e sucesso só após a resposta', async () => {
  let liberar!: (v: unknown) => void;
  const { tela, chamadas } = montar(() => new Promise((r) => { liberar = r; }));
  let a = await carregar(tela);
  const r = (rot: RegExp) => radio(tela.render('default', { importacaoId: IMP }), rot);
  (r(/Vigente/).props.onChange as (e: unknown) => void)(evento('on'));
  a = ver(tela);
  const pacote = elementos(a).find((e) => e.type === 'select' && elementos(e.props.children).some((o) => o.props?.value === 'p1'))!;
  (pacote.props.onChange as (e: unknown) => void)(evento('p1'));
  a = ver(tela);
  (achar(a, 'button', 'Continuar para pagamentos').props.onClick as () => void)();
  a = ver(tela);
  assert.match(texto(a), /não comprova que algo foi pago/);
  (r(/Parte foi paga/).props.onChange as (e: unknown) => void)(evento('on'));
  a = ver(tela);
  (achar(a, 'input', 'Parcela 1 foi recebida').props.onChange as (e: unknown) => void)(evento('on', true));
  a = ver(tela);
  (achar(a, 'input', 'Data em que a parcela 1 foi recebida').props.onChange as (e: unknown) => void)(evento('2026-08-03'));
  a = ver(tela);
  (achar(a, 'select', 'Forma da parcela 1').props.onChange as (e: unknown) => void)(evento('PIX'));
  a = ver(tela);
  (achar(a, 'button', 'Revisar e confirmar').props.onClick as () => void)();
  await tique();
  a = ver(tela);
  assert.match(texto(a), /Revisão final/);
  assert.match(texto(a), /Ocupa a agenda em 14\/11\/2026/);
  assert.match(texto(a), /Parcela 1: R\$ 2\.550,00 em 03\/08\/2026 · Pix/);
  assert.match(texto(a), /Parcela 2: R\$ 5\.950,00, vence 14\/11\/2026/);
  const decisoes = chamadas.find((c) => c.fn === 'simular')!.args[2] as Record<string, unknown>;
  assert.deepEqual(Object.keys(decisoes).sort(), ['conferenciaDeclarada', 'estabelecimentoId', 'evento', 'financeiro', 'motivos', 'outroContratoConfirmado', 'pacoteReferenciaId', 'situacaoContrato', 'valorContratadoCentavos']);
  assert.equal(achar(a, 'button', 'Confirmar integração').props.disabled, true, 'sem declaração não confirma');
  const declaracao = elementos(a).find((e) => e.type === 'label' && /Conferi o documento original/.test(texto(e)))!;
  (elementos(declaracao.props.children).find((e) => e.type === 'input')!.props.onChange as (e: unknown) => void)(evento('on', true));
  await tique();
  a = ver(tela);
  (achar(a, 'button', 'Confirmar integração').props.onClick as () => void)();
  await tique();
  a = ver(tela);
  assert.doesNotMatch(texto(a), /Contrato integrado ao sistema/, 'nada de sucesso antes da resposta');
  const conf = chamadas.find((c) => c.fn === 'confirmar')!;
  assert.deepEqual([conf.args[3], conf.args[4]], ['b'.repeat(64), '88888888-8888-4888-8888-888888888888']);
  liberar({ ok: true, dados: { reutilizado: false, contratoId: 'k1', festaId: 'f1', agendaOcupada: true, financeiro: { situacao: 'PARCIALMENTE_PAGO', pendente: false, recebidoCentavos: 255000, saldoCentavos: 595000 } } });
  await tique(); await tique();
  a = ver(tela);
  assert.match(texto(a), /Contrato integrado ao sistema/);
  assert.match(texto(a), /Festa criada e agenda ocupada/);
  assert.match(texto(a), /R\$ 2\.550,00 recebidos e R\$ 5\.950,00 a receber/);
  assert(elementos(a).some((e) => e.type === 'a' && e.props.href === '/admin/contratos?contratoId=k1'));
});

test('resumo desatualizado ou conflito: mostra o motivo, recalcula e não anuncia sucesso', async () => {
  const { tela, chamadas } = montar(async () => ({ ok: false, mensagem: 'O horário ficou indisponível na agenda durante a confirmação. Nada foi gravado.', codigo: 'CONFLITO_AGENDA', detalhes: null }));
  let a = await carregar(tela);
  const r = (rot: RegExp) => radio(tela.render('default', { importacaoId: IMP }), rot);
  (r(/Vigente/).props.onChange as (e: unknown) => void)(evento('on'));
  a = ver(tela);
  (elementos(a).find((e) => e.type === 'select' && elementos(e.props.children).some((o) => o.props?.value === 'p1'))!.props.onChange as (e: unknown) => void)(evento('p1'));
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Continuar para pagamentos').props.onClick as () => void)();
  (r(/Ainda não conferi/).props.onChange as (e: unknown) => void)(evento('on'));
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Revisar e confirmar').props.onClick as () => void)();
  await tique();
  a = ver(tela);
  const declaracao = elementos(a).find((e) => e.type === 'label' && /Conferi o documento original/.test(texto(e)))!;
  (elementos(declaracao.props.children).find((e) => e.type === 'input')!.props.onChange as (e: unknown) => void)(evento('on', true));
  await tique();
  (achar(tela.render('default', { importacaoId: IMP }), 'button', 'Confirmar integração').props.onClick as () => void)();
  await tique(); await tique();
  a = ver(tela);
  assert.match(texto(a), /O horário ficou indisponível na agenda/);
  assert.doesNotMatch(texto(a), /Contrato integrado ao sistema/);
  assert.ok(chamadas.filter((c) => c.fn === 'simular').length >= 3, 'recalcula o resumo depois da recusa');
  const ultimo = chamadas.filter((c) => c.fn === 'simular').at(-1)!.args[2] as { financeiro: unknown };
  assert.deepEqual(ultimo.financeiro, { situacao: 'NAO_CONFERIDO' });
});
