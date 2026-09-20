export const LIMITE_CENTAVOS = 999999999999n;
export class AlteracaoFinanceiraError extends Error {
  code: string;
  status: number;
  constructor(code: string, mensagem: string, status = 409) { super(mensagem); this.code = code; this.status = status; }
}
export function recusarFinanceiro(code: string, mensagem: string, status = 409): never {
  throw new AlteracaoFinanceiraError(code, mensagem, status);
}
export function centavosInteiros(valor: string, permiteZero = false, permiteNegativo = false): bigint {
  if (typeof valor !== 'string' || !/^-?(0|[1-9]\d*)$/.test(valor)) recusarFinanceiro('DADOS_INVALIDOS', 'Informe centavos inteiros.', 400);
  const n = BigInt(valor);
  if (n > LIMITE_CENTAVOS || n < (permiteNegativo ? -LIMITE_CENTAVOS : permiteZero ? 0n : 1n)) recusarFinanceiro('DADOS_INVALIDOS', 'Valor fora do limite monetário.', 400);
  return n;
}
/** Somente para valores reais provenientes do domínio existente (numeric(12,2)/snapshot). */
export function reaisCentavos(valor: string | number): bigint {
  const s = String(valor);
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) recusarFinanceiro('DADOS_INVALIDOS', 'Valor histórico com precisão incompatível.', 400);
  const [i, d = ''] = s.split('.');
  return centavosInteiros((BigInt(i) * 100n + BigInt(d.padEnd(2, '0'))).toString(), true);
}
export function reaisSql(n: bigint) { return `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`; }
export function posicaoEconomica(original: bigint, ajustes: bigint, recebido: bigint, estornado: bigint, devolvido: bigint, reservado: bigint) {
  const obrigacao = original + ajustes, liquido = recebido - estornado - devolvido;
  if (obrigacao < 0n || obrigacao > LIMITE_CENTAVOS || liquido < 0n || [recebido, estornado, devolvido, reservado].some(n => n < 0n)) recusarFinanceiro('POSICAO_INCONSISTENTE', 'Posição financeira inconsistente.');
  const saldo = obrigacao > liquido ? obrigacao - liquido : 0n;
  const credito = liquido > obrigacao ? liquido - obrigacao : 0n;
  if (reservado > credito) recusarFinanceiro('CREDITO_RESERVADO_INCOMPATIVEL', 'Cancele explicitamente a reserva de devolução incompatível antes desta operação.');
  return { obrigacao, recebido, estornado, devolvido, liquido, saldo, credito, reservado, disponivel: credito - reservado };
}
export function distribuirCentavos(total: bigint, quantidade: number): bigint[] {
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 60 || total < BigInt(quantidade) || total > LIMITE_CENTAVOS) recusarFinanceiro('CRONOGRAMA_INCONSISTENTE', 'Quantidade incompatível com o saldo.', 422);
  const q = BigInt(quantidade), base = total / q, resto = total % q;
  return Array.from({ length: quantidade }, (_, i) => base + (BigInt(i) < resto ? 1n : 0n));
}
export type ParcelaProposta = { parcelaId?: string; valorCentavos: string; vencimento: string };
export function validarVencimentoAteFesta(vencimento: string, dataFesta: string, meio: 'PIX' | 'CARTAO' = 'PIX') {
  const data = new Date(dataFesta + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataFesta) || dataFesta.startsWith('0000') ||
    Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== dataFesta) {
    recusarFinanceiro('DADOS_INVALIDOS', 'Data da festa inválida no contrato.', 400);
  }
  if (vencimento > dataFesta) recusarFinanceiro(
    meio === 'PIX' ? 'PIX_APOS_DATA_FESTA' : 'PARCELA_APOS_DATA_FESTA',
    meio === 'PIX' ? 'Todas as parcelas PIX devem vencer até a data da festa.' : 'Todas as parcelas devem vencer até a data da festa.', 422);
}
export function validarCronogramaConsolidado(parcelas: ParcelaProposta[], saldo: bigint, dataFesta: string, pixParcelado: boolean) {
  if (parcelas.length > 60 || (saldo > 0n && parcelas.length === 0)) recusarFinanceiro('CRONOGRAMA_INCONSISTENTE', 'Programe todo o saldo em até 60 parcelas.', 422);
  const ids = new Set<string>();
  let soma = 0n;
  for (const p of parcelas) {
    soma += centavosInteiros(p.valorCentavos);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.vencimento) || p.vencimento.startsWith('0000')) recusarFinanceiro('DADOS_INVALIDOS', 'Vencimento inválido.', 400);
    const data = new Date(p.vencimento + 'T00:00:00Z');
    if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== p.vencimento) recusarFinanceiro('DADOS_INVALIDOS', 'Vencimento inválido.', 400);
    if (pixParcelado) validarVencimentoAteFesta(p.vencimento, dataFesta);
    if (p.parcelaId) {
      const id = p.parcelaId.toLowerCase();
      if (ids.has(id)) recusarFinanceiro('CRONOGRAMA_INCONSISTENTE', 'Parcela repetida.', 422);
      ids.add(id);
    }
  }
  if (soma !== saldo) recusarFinanceiro('CRONOGRAMA_INCONSISTENTE', 'A soma deve coincidir exatamente com o saldo futuro.', 422);
}
export function situacaoAlteracao(necessaria: boolean, tentativa?: string) {
  if (!necessaria) return 'SEM_PENDENCIA';
  if (tentativa === 'RESOLVIDA') return 'RESOLVIDA';
  return tentativa === 'EM_TRATAMENTO' ? 'EM_TRATAMENTO' : 'PENDENTE';
}
