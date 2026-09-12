import { NextResponse } from "next/server";
import { isClienteServiceError } from "../clientes/services";
import { isPagamentoServiceError } from "../pagamentos/services";
import { AlteracaoFinanceiraError } from '../pagamentos/services/alteracao-financeira-core';

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function erroPagamentoApi(error: unknown) {
  if (error instanceof AlteracaoFinanceiraError) return noStore(NextResponse.json({ok:false,erro:error.message,codigo:error.code},{status:error.status}));
  if (isPagamentoServiceError(error) || isClienteServiceError(error)) {
    return noStore(NextResponse.json({
      ok: false,
      erro: error.message,
      codigo: error.code,
      detalhes: error.details ?? null,
    }, { status: error.httpStatus }));
  }

  // As restrições únicas também protegem requisições concorrentes que passaram
  // pela consulta de idempotência antes de a outra transação confirmar.
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505" &&
    "constraint" in error && typeof error.constraint === "string" && [
      "pagamento_recebimentos_idempotencia_uk",
      "pagamento_recebimentos_referencia_provedor_uk",
      "pagamento_estornos_idempotencia_uk",
      "pagamento_estornos_referencia_provedor_uk",
    ].includes(error.constraint)) {
    return noStore(NextResponse.json({
      ok: false,
      erro: "A chave de idempotência ou referência do provedor já foi utilizada. Consulte a operação existente antes de tentar novamente.",
      codigo: "OPERACAO_FINANCEIRA_DUPLICADA",
    }, { status: 409 }));
  }

  console.error("[Kidmais Pagamentos API] erro não tratado", error);
  return noStore(NextResponse.json({
    ok: false,
    erro: "Não foi possível processar Pagamentos agora.",
    codigo: "ERRO_PAGAMENTO",
  }, { status: 500 }));
}
