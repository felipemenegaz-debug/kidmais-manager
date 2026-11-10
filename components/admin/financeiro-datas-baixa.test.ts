import test from 'node:test';
import assert from 'node:assert/strict';
import { carregarComponente, cssFalso, elementos, achar, type Elemento } from './teste-componente.ts';
import * as calculos from '../../lib/financeiro/calculos.ts';
import * as submissao from '../../lib/financeiro/submissao.ts';

// 21:30 de 30/11 em Brasília: em UTC já é 01/12.
const NOITE_DO_ULTIMO_DIA = new Date('2026-12-01T00:30:00.000Z');
const DIA_ESPERADO = '2026-11-30';

function telas() {
  return carregarComponente('components/admin/FinanceiroTelas.tsx', {
    'next/link': { default: function Link() {} },
    '@/lib/http/admin-fetch': { adminFetch: async () => { throw new Error('não acessar rede'); } },
    '@/lib/financeiro/calculos': calculos,
    '@/lib/financeiro/submissao': submissao,
    './AdminPrimaryButton': { AdminPrimaryButton: 'button' },
    './financeiro.module.css': cssFalso,
    './PixParcela': { PixParcela: 'div' },
  });
}

function sugestaoDoDialogo(tela: 'receber' | 'pagar', amostra: object) {
  const carregado = telas();
  const antes = carregado.render('default', { tela, amostra }) as Elemento;
  const tabela = elementos(antes).find((e) => (e.type as { name?: string }).name === 'Tabela');
  assert(tabela);
  (tabela.props.linhas as Array<{ acao: () => void }>)[0].acao();
  const depois = carregado.render('default', { tela, amostra });
  const campo = elementos(depois).find((e) => (e.type as { name?: string }).name === 'Campo' && e.props.nome === 'data');
  assert(campo, 'campo Data do diálogo');
  return campo.props.padrao;
}

test('às 21:30 de Brasília no último dia do mês, recebimento e pagamento sugerem o próprio dia', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOITE_DO_ULTIMO_DIA });
  assert.equal(new Date().toISOString().slice(0, 10), '2026-12-01', 'o relógio do caso já virou em UTC');
  assert.equal(sugestaoDoDialogo('receber', { recebiveis: [
    { id: 'p', cliente: 'Ana', pacote: 'Premium', vencimento: '2026-11-30', valorCentavos: 1000, saldoCentavos: 1000, status: 'A receber' },
  ] }), DIA_ESPERADO);
  assert.equal(sugestaoDoDialogo('pagar', { contas: [
    { id: 'c', descricao: 'Aluguel', favorecido: null, categoria: 'Fixos', vencimento: '2026-11-30', valorCentavos: 1000, saldoCentavos: 1000, status: 'A pagar' },
  ] }), DIA_ESPERADO);
});

test('na festa, o recebimento sugere o dia de Brasília', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOITE_DO_ULTIMO_DIA });
  const festa = carregarComponente('components/festas/FestaFinanceiro.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async () => { throw new Error('não acessar rede'); } },
    '@/lib/financeiro/calculos': calculos,
    '@/lib/financeiro/submissao': submissao,
    './festa.module.css': cssFalso,
    '@/components/admin/PixParcela': { PixParcela: 'div' },
  });
  const amostra = {
    contratadoCentavos: 1000, recebidoCentavos: 0, saldoCentavos: 1000, custosCentavos: null, margemEstimadaCentavos: null, resultadoCaixaCentavos: null,
    recebimentos: [{ id: 'p', parcela: 1, vencimento: '2026-11-30', valorCentavos: 1000, status: 'A receber' }], despesas: [],
  };
  const antes = festa.render('default', { festaId: 'f', amostra });
  (achar(antes, 'button', 'Registrar recebimento').props.onClick as () => void)();
  const depois = festa.render('default', { festaId: 'f', amostra });
  assert.equal(achar(depois, 'input', 'Data').props.defaultValue, DIA_ESPERADO);
});
