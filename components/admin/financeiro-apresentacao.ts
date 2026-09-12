import type { PedidoResolucao } from '../../lib/pagamentos/services/alteracao-financeira.models';

export function propostaDeParcelas(saldoCentavos: string, futuro: PedidoResolucao['parcelas'], vencimento: string, pixAvista: boolean) {
  const saldo = BigInt(saldoCentavos);
  const existentes = futuro.filter(p => BigInt(p.valorCentavos) > 0n);
  if (saldo <= 0n) return { modo: 'SEM_SALDO' as const, parcelas: [] };
  if (pixAvista) return { modo: 'REPROGRAMAR' as const, parcelas: existentes.length === 1 && BigInt(existentes[0].valorCentavos) === saldo
    ? existentes : [{ valorCentavos: saldo.toString(), vencimento: existentes[0]?.vencimento ?? vencimento }] };
  const total = existentes.reduce((s, p) => s + BigInt(p.valorCentavos), 0n);
  if (total > saldo) return { modo: 'REPROGRAMAR' as const, parcelas: [{ valorCentavos: saldo.toString(), vencimento }] };
  return { modo: 'MANTER_E_COMPLEMENTAR' as const, parcelas: [...existentes, ...(total < saldo ? [{ valorCentavos: (saldo - total).toString(), vencimento }] : [])] };
}
export function dataApresentacao(valor?: string | null) {
  const dia = valor?.slice(0, 10);
  return dia && /^\d{4}-\d{2}-\d{2}$/.test(dia) ? dia.split('-').reverse().join('/') : 'Data não informada';
}
export function origemApresentacao(origem: { valor_bruto?: string; recebido_em?: string; meio_pagamento?: string }) {
  const valor = origem.valor_bruto ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(origem.valor_bruto)) : 'valor não informado';
  return `Recebimento de ${valor} — ${dataApresentacao(origem.recebido_em)} — ${origem.meio_pagamento ?? 'Meio não informado'}`;
}
export type ContextoContrato = { id: string; nome: string | null; data_evento?: string | null; pacote?: string | null; convidados?: string | number | null; status?: string | null };
export function contratoApresentacao(c: ContextoContrato) {
  return `${c.nome || 'Contratante não informado'} — ${dataApresentacao(c.data_evento)} — ${c.pacote || 'Pacote não informado'} — ${c.convidados ?? '?'} convidados — ${(c.status || 'Status não informado').replaceAll('_', ' ')} — ref. ${c.id.slice(0, 8)}`;
}
// Correção apenas de apresentação de palavras reconhecíveis; nunca regrava o histórico.
export function textoHistorico(texto?: string | null) {
  return (texto ?? '').replace(/condi(?:�+|Ã§Ã£)o/gi, 'condição').replace(/condi(?:�+|Ã§Ãµ)es/gi, 'condições')
    .replace(/altera(?:�+|Ã§Ã£)o/gi, 'alteração').replace(/obriga(?:�+|Ã§Ã£)o/gi, 'obrigação')
    .replace(/devolu(?:�+|Ã§Ã£)o/gi, 'devolução').replace(/solicita(?:�+|Ã§Ã£)o/gi, 'solicitação');
}
