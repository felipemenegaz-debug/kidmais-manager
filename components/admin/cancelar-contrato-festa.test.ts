import test from 'node:test';
import assert from 'node:assert/strict';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';
import * as contratoUrl from './contrato-url.ts';
import * as contratoTela from './contrato-tela.ts';
import * as versaoReferencia from '../../lib/contratos/versao-referencia.ts';
import * as fonteDocumento from '../../lib/contratos/documento/fonte.ts';

test('cancelamento na tela do contrato exige permissão, motivo e confirmação; retry usa mesma chave', async () => {
  for (const permitido of [false, true]) {
    const pedidos: Record<string, unknown>[] = []; let concluido = 0;
    const tela = carregarComponente('components/admin/CancelarContratoFesta.tsx', {
      '@/lib/http/admin-fetch': { adminFetch: async (_url: string, init?: RequestInit) => {
        if (!init) return Response.json({ ok: true, data: { festa: { revisao: 7 }, contrato: { versao_id: 'vigente' }, capacidades: permitido ? ['FESTA_CORRIGIR'] : [] } });
        pedidos.push(JSON.parse(String(init.body)));
        return Response.json(pedidos.length === 1 ? { ok: false, erro: 'Tente novamente' } : { ok: true });
      } },
    });
    const render = () => tela.render('default', { festaId: 'festa', nome: 'Cliente de teste', onCancelado: async () => { concluido++; } });
    const clicar = async (rotulo: string) => { (achar(render(), 'button', rotulo).props.onClick as () => void)(); await tique(); };
    await clicar('Cancelar contrato');
    if (!permitido) { assert.match(texto(render()), /Seu acesso não permite cancelar/); assert.equal(pedidos.length, 0); continue; }
    assert.equal(achar(render(), 'button', 'Confirmar cancelamento').props.disabled, true);
    const motivo = elementos(render()).find(e => e.type === 'textarea')!;
    (motivo.props.onChange as (e: unknown) => void)({ target: { value: 'Cancelamento solicitado pelo cliente' } });
    assert.equal(achar(render(), 'button', 'Confirmar cancelamento').props.disabled, true);
    const confirmacao = elementos(render()).find(e => e.type === 'input' && e.props.type === 'checkbox')!;
    (confirmacao.props.onChange as (e: unknown) => void)({ target: { checked: true } });
    await clicar('Confirmar cancelamento');
    assert.match(texto(render()), /Tente novamente/); assert.equal(concluido, 0);
    await clicar('Confirmar cancelamento');
    assert.equal(concluido, 1); assert.deepEqual(pedidos[0], pedidos[1]);
    assert.equal(pedidos[0].versaoId, 'vigente'); assert.equal(pedidos[0].revisao, 7);
    assert.equal(pedidos[0].acao, 'cancelar_contratacao');
  }
});

test('contrato importado com V2 aberta: cancelamento fica só no menu "Mais", abre pelo #cancelar-contrato e sobrevive à edição', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const snapshot = { contratante: { nomeCompleto: 'Cliente de teste' }, aniversariante: { nome: 'Helena', idadeNoEvento: 6, temaFesta: 'Frozen' }, evento: { data: '2026-10-18', horarioInicio: '10:00:00', horarioFim: '14:00:00', pacote: { nome: 'Histórico', codigo: 'X' }, convidados: 50 }, comercial: { valorFinalContrato: 7811.5 } };
  const dados = { festaId: 'festa', contrato: { id, status: 'ASSINADO' }, origemHistorica: { caminhoFinanceiro: 'AGUARDAR_REVISAO' },
    fluxo: { versao_vigente_id: 'v1', versao_em_preparacao_id: 'v2' }, documentos: [], assinaturas: [], financeiro: [], pendencias: [], revisoesOperacionais: [],
    versoes: [{ id: 'v2', numero_versao: 2, estado_edicao: 'EM_ELABORACAO', status: 'ATIVA', snapshot, criado_em: '2026-10-20T10:00:00Z' }, { id: 'v1', numero_versao: 1, estado_edicao: 'CONCLUIDA', status: 'ASSINADA', snapshot, criado_em: '2026-10-04T10:00:00Z' }],
  };
  function Cancelar() { return null; }
  function Filho() { return null; }
  function Lista() { return null; }
  const anterior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  for (const hash of ['', '#cancelar-contrato']) {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash, search: '?contratoId=' + id, pathname: '/admin/contratos' }, history: { state: null, replaceState() {} }, addEventListener() {}, removeEventListener() {} } });
    try {
      const tela = carregarComponente('components/admin/ContratoAdmin.tsx', {
        'next/navigation': { useSearchParams: () => new URLSearchParams('contratoId=' + id), usePathname: () => '/admin/contratos', useRouter: () => ({}) },
        'next/link': { default: Filho }, './contratos-ux.module.css': cssFalso,
        '@/lib/http/admin-fetch': { adminFetch: async (url: string) => Response.json({ ok: true, data: url.includes('contratoId=') ? dados : [] }) },
        '@/lib/contratos/services/alteracoes': { analisarRevisao: () => null },
        '@/lib/contratos/assinatura-papel': { versaoAssinadaEmPapel: () => true },
        // Aviso da fonte do PDF (plano UX achados Frente C): função real; o botão principal recebe a classe visual.
        '../../lib/contratos/documento/fonte': fonteDocumento, './AdminPrimaryButton': { classePrimaria: 'primario' },
        '@/lib/contratos/documento/formatters': { formatarMoeda: String, formatarFormaPagamento: () => 'A definir', formatarCondicaoPix: String },
        '@/lib/festas/apresentacao': { retornoFestaSeguro: () => null },
        './EdicaoFesta': { default: Filho }, './CancelarContratoFesta': { default: Cancelar },
        './inteligencia/PerguntarKidmais': { ContextoKidmais: Filho }, './PagamentosResumo': { default: Filho },
        './CriarPlanoFinanceiro': { default: Filho }, './criacao-financeira': { contextoCriacao: () => null },
        './ListaContratos': { default: Lista },
        './contrato-url': { ...contratoUrl, opcaoForaDaLista: () => null },
        './contrato-tela': contratoTela, '@/lib/contratos/versao-referencia': versaoReferencia,
        './ContratoImportado': { default: Filho }, './OrigemHistoricaContrato': { default: Filho }, './importacao/IntegracaoContrato': { default: Filho },
      });
      tela.render(); tela.efeitos(); await tique();
      const render = () => tela.render();
      const quantos = () => elementos(render()).filter(e => e.type === Cancelar).length;
      assert.match(texto(render()), /Aniversário de Helena · 6 anos/);
      if (!hash) {
        assert.equal(quantos(), 0, 'cancelamento escondido até abrir o menu');
        (achar(render(), 'button', 'Mais').props.onClick as () => void)();
      }
      const menu = achar(render(), 'div', 'Mais ações');
      assert.equal(achar(menu, Cancelar).props.festaId, 'festa');
      assert.equal(quantos(), 1);
      (achar(render(), 'button', 'Editar dados desta revisão').props.onClick as () => void)();
      assert.equal(quantos(), 1, 'continua no menu com o editor aberto');
      assert.match(texto(render()), /Alteração em andamento/);
      assert.equal(elementos(render()).some(e => e.type === 'select' && e.props['aria-label'] === 'Versão contratual'), false, 'sem seletor de versão');
    } finally {
      if (anterior) Object.defineProperty(globalThis, 'window', anterior); else Reflect.deleteProperty(globalThis, 'window');
    }
  }
});
