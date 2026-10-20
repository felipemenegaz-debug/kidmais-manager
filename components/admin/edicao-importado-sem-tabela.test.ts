import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';
import * as errosPreco from '../../lib/comercial/services/errors.ts';
import { preservarPrecoHistorico } from '../../lib/fechamentos/revisao-preco.ts';

const id = '00000000-0000-4000-8000-000000000001';
const fonte = {
  fechamento: { id, origemFechamento: 'IMPORTACAO_HISTORICA', pacoteId: id, configuracaoAgendaId: id,
    dataEvento: '2026-10-18', convidados: 50, horarioInicio: '10:00:00', horarioFim: '14:00:00', valorTabela: 7811.5,
    valorNegociado: null, buffetStatus: 'PENDENTE', clienteId: id, aniversarianteId: null },
  cliente: { nomeCompleto: 'Cliente de teste', cpf: null }, aniversariante: null,
  adicionais: [{ codigo: 'EXTRA_HISTORICO', quantidade: 2 }], fonteHash: 'hash',
};
const erroPreco = new errosPreco.PricingServiceError('TABELA_PRECO_NAO_CONFIGURADA', 'Não existe tabela de preço vigente para a data selecionada.', 503);

async function consultar(erroCatalogo: Error = erroPreco) {
  const chamadas: string[] = [];
  const tx = { query: async () => ({ rows: [] }) };
  const rota = carregarComponente('app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts', {
    zod: { z },
    '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => ({}) },
    '@/lib/http/api-response': { jsonNoStore: (b: unknown) => Response.json(b), apiErrorResponse: () => Response.json({ ok: false }, { status: 500 }) },
    '@/lib/saas/provar-tenant': { withTenantTransaction: async (_s: unknown, _e: unknown, fn: (t: typeof tx, tenant: object) => unknown) => fn(tx, { empresaComprovada: id }) },
    '@/lib/contratos/services/administrativo.service': { versaoDoTenant: async () => ({ versao: { id }, empresaId: id }) },
    '@/lib/contratos/services/revisao-inicial': {},
    '@/lib/fechamentos/services/revisao-operacional.service': { fontesPreparacao: async () => fonte },
    '@/lib/disponibilidade/services': { consultarDisponibilidadeData: async () => ({ periodos: [] }) },
    '@/lib/comercial/composicao': { listarCodigosInclusos: async () => [] },
    '@/lib/comercial/services/errors': errosPreco,
    '@/lib/comercial/regras-pagamento': { lerRegrasPagamento: async () => null },
    '@/lib/comercial/services': {
      listarPacotesComerciais: async () => [],
      listarCatalogoAdicionais: async (input: { empresaId: string }) => { chamadas.push(input.empresaId); throw erroCatalogo; },
      calcularResumoComercial: async () => { throw erroPreco; },
    },
  });
  const get = rota.modulo.GET as (req: object, ctx: object) => Promise<Response>;
  const r = await get({ nextUrl: new URL('https://exemplo.invalid/edicao') }, { params: Promise.resolve({ versaoId: id }) });
  return { r, chamadas };
}

test('GET da edição entrega o cadastro histórico sem tabela vigente, mantendo o erro de preço separado', async () => {
  const { r, chamadas } = await consultar();
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true); assert.deepEqual(b.data.fonte, fonte);
  assert.equal(b.data.catalogo, null); assert.equal(b.data.resumo, null);
  assert.equal(b.data.erroPreco, erroPreco.message); assert.deepEqual(chamadas, [id]);
});

test('GET da edição não mascara falha inesperada no catálogo como ausência de preço', async () => {
  const { r } = await consultar(new Error('Falha de conexão'));
  assert.equal(r.status, 500);
});

test('editor abre sem catálogo, salva cadastro preservando adicionais e bloqueia mudanças comerciais sem preço', async () => {
  const { r } = await consultar(); const resposta = await r.json();
  const salvos: Record<string, unknown>[] = [];
  const tela = carregarComponente('components/admin/EdicaoFesta.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async () => Response.json(resposta) },
    '@/lib/fechamentos/convidados': { atalhosConvidados: () => [] },
    '@/lib/comercial/condicao-pagamento': { calcularCondicaoComercial: () => ({ valorFinalContrato: 7811.5 }) },
    '@/lib/comercial/regras-pagamento': { percentualDaForma: () => 0 },
    '@/lib/contratos/documento/formatters': { formatarMoeda: String },
    '@/lib/fechamentos/revisao-preco': { preservarPrecoHistorico }, './admin.module.css': cssFalso,
  });
  const props = { versaoId: id, revisao: 1, serverError: '', onClose: () => {}, onSave: async (b: Record<string, unknown>) => { salvos.push(b); return true; } };
  const render = () => tela.render('default', props);
  render(); tela.efeitos(); await tique();
  assert.match(texto(render()), /Dados do contratante/);
  assert.match(texto(render()), /EXTRA_HISTORICO \(2\)/);
  assert.equal(achar(render(), 'button', 'Salvar alteração da festa').props.disabled, false);
  const nome = achar(render(), 'label', /^Nome completo/);
  const campo = achar(nome, 'input');
  (campo.props.onChange as (e: unknown) => void)({ target: { value: 'Nome corrigido' } });
  await (achar(render(), 'form').props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
  assert.deepEqual(salvos[0].adicionais, fonte.adicionais);
  assert.equal((salvos[0].cliente as { nomeCompleto: string }).nomeCompleto, 'Nome corrigido');
  const convidados = achar(achar(render(), 'label', 'Convidados pagantes'), 'input');
  (convidados.props.onChange as (e: unknown) => void)({ target: { value: '60' } });
  assert.equal(achar(render(), 'button', 'Salvar alteração da festa').props.disabled, true);
  (convidados.props.onChange as (e: unknown) => void)({ target: { value: '50' } });
  const com = elementos(render()).find(e => e.type === 'input' && e.props.type === 'checkbox')!;
  (com.props.onChange as (e: unknown) => void)({ target: { checked: true } });
  assert.equal(achar(render(), 'button', 'Salvar alteração da festa').props.disabled, true);
});
