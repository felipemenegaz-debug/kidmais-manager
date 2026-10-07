import test from 'node:test';
import assert from 'node:assert/strict';
import { carregarComponente, cssFalso, elementos, type Elemento } from './teste-componente.ts';
import * as calculos from '../../lib/financeiro/calculos.ts';
import * as submissao from '../../lib/financeiro/submissao.ts';

test('contato abre o cadastro em desktop e mobile, sem acionar a baixa; entrada avulsa sem contato não tem link', () => {
  const Link = function Link() {};
  const tela = carregarComponente('components/admin/FinanceiroTelas.tsx', {
    'next/link': { default: Link },
    '@/lib/http/admin-fetch': { adminFetch: async () => { throw new Error('não acessar rede'); } },
    '@/lib/financeiro/calculos': calculos,
    '@/lib/financeiro/submissao': submissao,
    './AdminPrimaryButton': { AdminPrimaryButton: 'button' },
    './financeiro.module.css': cssFalso,
    './PixParcela': { PixParcela: 'div' },
  });
  const clienteId = '11111111-1111-4111-8111-111111111111';
  const arvore = tela.render('default', { tela: 'receber', amostra: { recebiveis: [
    { id: 'p', clienteId, cliente: 'Ana', pacote: 'Premium', vencimento: '2026-10-10', valorCentavos: 55000, saldoCentavos: 55000, status: 'A receber' },
    { id: 'm', origem: 'ENTRADA_MANUAL', cliente: 'Avulsa', pacote: 'Entrada manual', vencimento: '2026-10-10', valorCentavos: 10000, saldoCentavos: 10000, status: 'A receber' },
  ] } });
  const tabela = elementos(arvore).find((e) => typeof e.type === 'function' && (e.type as { name?: string }).name === 'Tabela');
  assert(tabela);
  const renderizada = (tabela.type as (p: unknown) => Elemento)(tabela.props);
  const links = elementos(renderizada).filter((e) => e.type === Link);
  assert.equal(links.length, 2, 'um link em cada apresentação');
  for (const link of links) {
    assert.equal(link.props.href, `/clientes/${clienteId}`);
    let parou = false;
    (link.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => { parou = true; } });
    assert(parou, 'não propaga para registrar recebimento');
  }
  // 066: Pix só na parcela de contrato com saldo (desktop e mobile); entrada avulsa não tem Pix.
  const pix = elementos(renderizada).filter((e) => e.type === 'button' && (e.props.children === 'Pix'));
  assert.equal(pix.length, 2, 'um botão Pix por apresentação, só da parcela de contrato');
});
