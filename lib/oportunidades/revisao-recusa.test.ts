import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

const id = '22222222-2222-4222-8222-222222222222';
const fechamento = { id, clienteId: 'cliente', status: 'AGUARDANDO_CONTRATO' };

for (const caso of [
  { nome: 'Gestão sem contrato', gestao: true, contrato: false, corrigir: false, esperado: 'SEM_CONTRATO' },
  { nome: 'Gestão com preparação', gestao: true, contrato: true, corrigir: true, esperado: 'COM_PREPARACAO' },
  { nome: 'equipe sem Gestão', gestao: false, contrato: false, corrigir: false, esperado: undefined },
  { nome: 'Gestão com preparação sem FESTA_CORRIGIR', gestao: true, contrato: true, corrigir: false, esperado: undefined },
]) {
  test('GET da revisão comercial — ' + caso.nome, async () => {
    const tx = executorFalso([
      [/to_regclass/, () => [{ ok: true }]],
      [/FROM contratos WHERE fechamento_id/, () => caso.contrato ? [{ id: 'contrato', status: 'AGUARDANDO_ASSINATURA' }] : []],
      [/FROM contrato_fluxos/, () => [{ versao_vigente_id: null, versao_em_preparacao_id: 'preparacao' }]],
      [/FROM festa_membership_capacidades.*FESTA_CORRIGIR/, () => caso.corrigir ? [{}] : []],
    ]);
    const tenant = { empresaComprovada: 'empresa', membershipId: 'membro', papelAtual: caso.gestao ? 'REPRESENTANTE_AUTORIZADO' : 'EQUIPE' };
    const rota = carregarModulo('app/api/admin/fechamentos/[fechamentoId]/revisao/route.ts', {
      'next/server': { NextResponse: Response },
      'http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => ({}) },
      'saas/provar-tenant': { withTenantTransaction: (_sessao: unknown, _empresa: unknown, executar: (db: typeof tx, t: typeof tenant) => unknown) => executar(tx, tenant) },
      'assinatura/paywall': { resumoComercialDaEmpresa: async () => ({ nivel: 'COMPLETO' }) },
      'fechamentos/services/revisao-comercial.service': { obterRevisaoComercial: async () => ({ fechamento, aprovacoes: [] }) },
      'clientes/services': {}, 'comercial/pacotes-admin': {}, 'db/postgres': {},
      'marketing/contatos': {}, 'fechamentos/services/revisao-operacional.service': {},
    });
    const get = rota.GET as (req: { nextUrl: URL }, ctx: { params: Promise<{ fechamentoId: string }> }) => Promise<Response>;
    const resposta = await get({ nextUrl: new URL('http://localhost/revisao') }, { params: Promise.resolve({ fechamentoId: id }) });
    assert.equal(resposta.status, 200);
    const body = await resposta.json();
    assert.deepEqual(body.data, { fechamento, aprovacoes: [], ...(caso.esperado ? { recusa: caso.esperado } : {}) });
    if (!caso.gestao) assert.equal(tx.executados.length, 0);
  });
}
