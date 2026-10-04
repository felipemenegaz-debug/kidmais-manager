import { PagamentoServiceError } from "./errors.ts";

/**
 * Criação da obrigação financeira pelo fluxo OFICIAL (`criarPagamentoDoFechamento`) também para o contrato histórico
 * integrado (061). Contrato nativo: regra de sempre (fechamento com contrato assinado → aguardando pagamento).
 *
 * Contrato histórico: o fechamento já nasce CONFIRMADO (reserva vigente desde a conferência), então nunca passa por
 * CONTRATO_ASSINADO. Enquanto a versão conferida (v1) é a vigente, o caminho é "Conferir pagamentos" da integração
 * (registra o histórico com as datas reais). Depois de uma revisão do contrato (outra versão vigente), a conferência
 * da v1 é recusada e o operador cria o plano aqui, sobre a versão VIGENTE, com as regras nativas do plano; os
 * recebimentos já feitos entram por "Registrar recebimento" com a data real. A reserva continua confirmada.
 */
export type FluxoInicialPagamento = "NATIVO" | "HISTORICO_REVISADO";

export function fluxoInicialDoPagamento(e: {
  fechamentoStatus: string;
  origemFechamento: string | null | undefined;
  versaoId: string;
  versaoConferidaId: string | null;
}): FluxoInicialPagamento {
  if (e.origemFechamento !== "IMPORTACAO_HISTORICA") {
    if (e.fechamentoStatus !== "CONTRATO_ASSINADO") {
      throw new PagamentoServiceError("STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO", "O Pagamento só pode ser iniciado quando o Fechamento está com contrato assinado.", 409, { statusAtual: e.fechamentoStatus });
    }
    return "NATIVO";
  }
  if (!e.versaoConferidaId || e.versaoConferidaId === e.versaoId) {
    throw new PagamentoServiceError("CONFERENCIA_HISTORICA_PENDENTE", 'Contrato histórico: registre os pagamentos em "Conferir pagamentos" (eles valem para a versão conferida).', 409);
  }
  if (e.fechamentoStatus !== "CONFIRMADO") {
    throw new PagamentoServiceError("STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO", "A reserva do contrato histórico não está confirmada.", 409, { statusAtual: e.fechamentoStatus });
  }
  return "HISTORICO_REVISADO";
}
