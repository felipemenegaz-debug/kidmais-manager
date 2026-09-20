import { validarPretensaoPix, type PretensaoPixInput } from '../../comercial/condicao-pagamento.ts';
import { distribuirCentavos } from './alteracao-financeira-core.ts';
import { dinheiroParaCentavos, validarPlanoPagamento } from './financeiro-core.ts';
import { PagamentoServiceError } from './errors.ts';
import type { PlanoPagamentoInput } from './models';

function recusar(mensagem: string): never {
  throw new PagamentoServiceError('SUGESTAO_PIX_INVALIDA', mensagem, 422);
}
function dataCivil(value: string) {
  const data = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') ||
    Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== value) recusar('Data inválida para o calendário PIX.');
  return data;
}

/** Total já descontado do snapshot assinado. Quantidade refere-se somente ao saldo. */
export function sugerirParcelamentoPix(valorFinal: number, dataFesta: string, dataReferencia: string, input: PretensaoPixInput = {}) {
  const total = dinheiroParaCentavos(valorFinal);
  let pedido;
  try { pedido = validarPretensaoPix(input); } catch { recusar('Condição PIX inválida; informe valores em centavos e quantidade inteira positiva.'); }
  const entrada = pedido?.entradaCentavos ?? 0, pretendido = pedido?.parcelaCentavos ?? null, quantidade = pedido?.quantidadeParcelas ?? null;
  if (entrada > total) recusar('A entrada não pode superar o valor final do contrato.');
  const referencia = dataCivil(dataReferencia), festa = dataCivil(dataFesta);
  if (festa < referencia) recusar('A Festa já passou; não existe cronograma viável.');
  const saldo = total - entrada;
  const limite = Math.min(60 - (entrada > 0 ? 1 : 0), saldo);
  const datas: string[] = [];
  for (let mes = 1; mes <= limite; mes++) {
    // Sempre partir do dia original: 31/jan → 28/fev → 31/mar, sem deriva.
    const data = new Date(referencia);
    data.setUTCFullYear(referencia.getUTCFullYear(), referencia.getUTCMonth() + mes + 1, 0);
    data.setUTCDate(Math.min(referencia.getUTCDate(), data.getUTCDate()));
    if (data > festa) break;
    datas.push(data.toISOString().slice(0, 10));
  }
  if (saldo > 0 && datas.length === 0) datas.push(dataFesta);
  const maxima = datas.length;
  const necessaria = pretendido === null ? null : Math.ceil(saldo / pretendido);
  let motivo: string | null = null;
  if (quantidade !== null && pretendido !== null && quantidade !== necessaria) motivo = 'Valor e quantidade não quitam o saldo com uma última parcela positiva até o valor pretendido.';
  const solicitada = quantidade ?? necessaria ?? maxima;
  if (solicitada > maxima) motivo = 'A quantidade pretendida não cabe no calendário até a Festa ou no limite de 60 lançamentos.';
  if (saldo === 0 && (quantidade !== null || pretendido !== null)) motivo = 'A entrada já cobre o contrato; não há saldo a parcelar.';
  const n = motivo ? maxima : solicitada;
  let valores: number[] = [];
  if (saldo > 0) {
    if (!motivo && pretendido !== null) {
      valores = Array.from({ length: n }, (_, i) => i === n - 1 ? saldo - pretendido * (n - 1) : pretendido);
    } else valores = distribuirCentavos(BigInt(saldo), n).map(Number);
  }
  const parcelas: PlanoPagamentoInput['parcelas'] = [
    ...(entrada > 0 ? [{ valor: entrada / 100, vencimento: dataReferencia }] : []),
    ...valores.map((valor, i) => ({ valor: valor / 100, vencimento: datas[i] })),
  ].map((p, i) => ({ ...p, confirmaReserva: i === 0 }));
  // Modalidade é a cardinalidade do plano financeiro, não a forma comercial do contrato.
  const plano: PlanoPagamentoInput = { meioPagamento: 'PIX', modalidade: parcelas.length === 1 ? 'AVISTA' : 'PARCELADO', parcelas };
  validarPlanoPagamento(valorFinal, plano, dataFesta);
  return {
    dataReferencia, dataFesta, valorFinal, entrada: entrada / 100, saldoParcelado: saldo / 100,
    quantidadeParcelas: n, quantidadeMaxima: maxima,
    valorMinimoPorParcela: maxima ? Math.ceil(saldo / maxima) / 100 : 0,
    contraproposta: motivo !== null, motivo, pedido: pedido ?? null, plano,
  };
}
export type SugestaoPix = ReturnType<typeof sugerirParcelamentoPix>;
