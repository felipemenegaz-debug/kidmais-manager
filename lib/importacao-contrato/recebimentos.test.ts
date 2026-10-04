import assert from 'node:assert/strict';
import test from 'node:test';
import { lerRecebimentos, leituraRecebimentosGuardada, recebimentosIntegrais } from './recebimentos.ts';
import { extrairPorRegras } from './extracao.ts';
import { montarRevisao } from './rascunho.ts';
import { formInicial, decisoesDoForm, errosPagamentos } from '../../components/admin/importacao/integracao-form.ts';

const texto = 'Recebido: R$ 3.905,75 em 10/08/2026 via PIX\nRecebido: R$ 3.905,75 em 10/09/2026 via PIX';
const hoje = '2026-10-04';
test('dois recebimentos explícitos preservam centavos, datas, forma e página até o formulário', () => {
  const lida = lerRecebimentos(['Contrato', texto]);
  assert.deepEqual(lida.recebimentos.map(r => [r.valorCentavos, r.data, r.forma, r.pagina]), [[390575, '2026-08-10', 'PIX', 2], [390575, '2026-09-10', 'PIX', 2]]);
  assert.equal(recebimentosIntegrais(lida, 781150, hoje)?.length, 2);
  const revisao = montarRevisao(extrairPorRegras([texto]), [texto], { nome: 'sintetico.pdf', tipo: 'application/pdf', tamanhoBytes: 200 });
  assert.deepEqual(revisao.recebimentosDocumento, lerRecebimentos([texto]));
  assert.match(revisao.secoes.find(s => s.id === 'pagamentos')!.campos.find(c => c.id === 'pagamentos.realizados')!.valor!, /3.905,75/);
  const sugestao = { evento: { data: '2026-10-18', horarioInicio: '10:00', horarioFim: '14:00', convidados: 50 }, valorContratadoCentavos: 781150, condicaoDocumento: 'à vista', parcelasPrevistas: [], recebimentosDocumento: lida };
  const f = formInicial({ sugestao, estabelecimentos: [], hoje });
  assert.equal(f.situacaoFinanceira, 'PAGO');
  assert.equal(f.conferenciaDeclarada, false, 'preenchimento não é confirmação humana');
  assert.equal(f.situacaoContrato, '', 'não inventa vigência');
  assert.deepEqual(f.parcelas.map(p => [p.valor, p.recebidaEm, p.forma, p.recebida]), [['3.905,75', '2026-08-10', 'PIX', true], ['3.905,75', '2026-09-10', 'PIX', true]]);
  assert.deepEqual(errosPagamentos(f, sugestao, hoje), []);
  assert.equal(decisoesDoForm(f, sugestao).conferenciaDeclarada, false);
});
test('à vista, entrada, previsão, negação e exemplo nunca viram recebimento', () => {
  for (const frase of ['Pagamento: à vista por PIX', 'Entrada de R$ 1.000,00 em 10/08/2026 via PIX', 'Será pago R$ 1.000,00 em 10/08/2026 via PIX', 'Não recebido: R$ 1.000,00 em 10/08/2026 via PIX', 'Exemplo: Recebido: R$ 1.000,00 em 10/08/2026 via PIX', 'Pago se confirmado: R$ 1.000,00 em 10/08/2026 via PIX']) {
    assert.equal(lerRecebimentos([frase]).recebimentos.length, 0, frase);
  }
});
test('recebimento incompleto, ambíguo, repetido, parcial, futuro ou maior que total impede preencher como quitado', () => {
  for (const frase of ['Recebido: R$ 1.000,00 em 10/08/2026', 'Recebido: R$ 123.45 em 10/08/2026 via PIX', 'Recebido: R$ 1.000,00 em 31/02/2026 via PIX', 'Recebido: R$ 1.000,00 em 10/08/26 via PIX']) {
    const lida = lerRecebimentos([frase]); assert.ok(lida.pendencias.length); assert.equal(recebimentosIntegrais(lida, 100000, hoje), null);
  }
  assert.equal(recebimentosIntegrais(lerRecebimentos([texto, texto]), 781150, hoje), null);
  assert.equal(recebimentosIntegrais(lerRecebimentos([texto.split('\n')[0]]), 781150, hoje), null);
  assert.equal(recebimentosIntegrais(lerRecebimentos([texto]), 780000, hoje), null);
  assert.equal(recebimentosIntegrais(lerRecebimentos([texto]), 781150, '2026-08-15'), null);
});
test('metadados alterados não reaproveitam uma evidência de outro valor, data ou forma', () => {
  const lida = lerRecebimentos([texto]);
  for (const alteracao of [{ valorCentavos: 1 }, { data: '2026-01-01' }, { forma: 'DINHEIRO' }, { pagina: 0 }]) {
    assert.deepEqual(leituraRecebimentosGuardada({ ...lida, recebimentos: [{ ...lida.recebimentos[0], ...alteracao }] }).recebimentos, []);
  }
  assert.deepEqual(leituraRecebimentosGuardada(undefined), { recebimentos: [], pendencias: [] });
  assert.deepEqual(leituraRecebimentosGuardada({ recebimentos: lida.recebimentos, pendencias: [1] }).recebimentos, []);
});
