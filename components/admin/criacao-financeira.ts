import { validarPlanoPagamento } from '../../lib/pagamentos/services/financeiro-core.ts';
import type { PlanoPagamentoInput } from '../../lib/pagamentos/services/models';
import type { ContratoSnapshotV1 } from '../../lib/contratos/repositories/models';
import type { SugestaoPix } from '../../lib/pagamentos/services/sugestao-pix';

export type ContextoCriacao = {
  fechamentoId: string; versaoId: string; numeroVersao: number;
  valor: number; dataFesta: string; forma: string;
};
export const erroCondicaoComercial = 'A forma de pagamento do plano deve respeitar a condição comercial da versão contratual vigente. Para alterá-la, crie uma revisão contratual.';
export function condicaoDoPlano(forma: string) {
  switch (forma) {
    case 'PIX_AVISTA': return { meio: 'PIX' as const, modalidades: ['AVISTA'] as const };
    case 'PIX_PARCELADO': return { meio: 'PIX' as const, modalidades: ['PARCELADO'] as const };
    case 'CARTAO_CIELO': return { meio: 'CARTAO' as const, modalidades: ['AVISTA', 'PARCELADO'] as const };
    default: return null;
  }
}
export function validarCondicaoComercial(contexto: ContextoCriacao, meio: string, modalidade: string) {
  const condicao = condicaoDoPlano(contexto.forma);
  if (!condicao || meio !== condicao.meio || !condicao.modalidades.some(item => item === modalidade)) throw Error(erroCondicaoComercial);
}
export function contextoCriacao(painel: {
  contrato: { status: string; fechamento_id: string; versao_atual: number };
  fluxo: { versao_vigente_id: string | null } | null;
  versoes: Array<{ id: string; numero_versao: number; status: string; snapshot: ContratoSnapshotV1 }>;
}): ContextoCriacao | null {
  const v = painel.versoes.find(item => painel.fluxo
    ? item.id === painel.fluxo.versao_vigente_id
    : item.numero_versao === painel.contrato.versao_atual);
  if (painel.contrato.status !== 'ASSINADO' || !v || v.status !== 'ASSINADA'
    || v.numero_versao !== painel.contrato.versao_atual || !painel.contrato.fechamento_id) return null;
  return { fechamentoId: painel.contrato.fechamento_id, versaoId: v.id, numeroVersao: v.numero_versao,
    valor: Number(v.snapshot.comercial.valorFinalContrato), dataFesta: v.snapshot.evento.data,
    forma: v.snapshot.comercial.condicaoPagamento?.forma ?? v.snapshot.comercial.formaPagamentoPretendida ?? '' };
}
export function valorDigitado(texto: string) {
  if (!/^\d+(?:[,.]\d{1,2})?$/.test(texto.trim())) throw Error('Informe reais com até duas casas decimais, sem separador de milhar.');
  return Number(texto.trim().replace(',', '.'));
}
export function planoExplicito(contexto: ContextoCriacao, meioPagamento: 'PIX' | 'CARTAO', modalidade: 'AVISTA' | 'PARCELADO', linhas: Array<{ valor: string; vencimento: string }>): PlanoPagamentoInput {
  validarCondicaoComercial(contexto, meioPagamento, modalidade);
  const parcelas = linhas.map((linha, i) => ({ valor: modalidade === 'AVISTA' ? contexto.valor : valorDigitado(linha.valor), vencimento: linha.vencimento, confirmaReserva: i === 0 }));
  const plano = { meioPagamento, modalidade, parcelas };
  validarPlanoPagamento(contexto.valor, plano, contexto.dataFesta);
  return plano;
}
export function pretensaoInicial(entrada: string, quantidade: string, valor: string) {
  if (quantidade && (!/^\d+$/.test(quantidade) || !Number.isSafeInteger(Number(quantidade)) || Number(quantidade) < 1)) throw Error('Informe uma quantidade inteira positiva.');
  return { meioPagamento: 'PIX' as const, modalidade: 'PARCELADO' as const,
    ...(entrada ? { entrada: valorDigitado(entrada) } : {}),
    ...(quantidade ? { quantidadeParcelas: Number(quantidade) } : {}),
    ...(valor ? { valorParcela: valorDigitado(valor) } : {}) };
}
export type SugestaoInicial = SugestaoPix & { hash: string };
export type PedidoInicial = PlanoPagamentoInput | ReturnType<typeof pretensaoInicial> & {
  confirmacao?: { dataReferencia: string; hash: string };
};
export async function enviarPlanoInicial(fetcher: typeof fetch, contexto: ContextoCriacao, plano: PedidoInicial, chave: string) {
  validarCondicaoComercial(contexto, plano.meioPagamento, plano.modalidade);
  const response = await fetcher('/api/admin/pagamentos', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': chave },
    body: JSON.stringify({ fechamentoId: contexto.fechamentoId, plano }) });
  const body = await response.json();
  // A contraproposta 422 também é uma prévia, nunca uma criação bem-sucedida.
  if (body.data?.exigeConfirmacao && body.data?.sugestao && (response.ok || body.codigo === 'CONDICAO_PIX_INVIAVEL')) {
    return { sugestao: body.data.sugestao as SugestaoInicial };
  }
  if (!response.ok || !body.ok) throw Error(body.erro || 'Não foi possível criar o plano financeiro.');
  if (!body.data?.detalhe?.pagamento?.id) throw Error('Resposta financeira inesperada. Reabra o painel antes de tentar novamente.');
  return { criado: true as const };
}
