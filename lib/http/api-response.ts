import { NextResponse } from "next/server";
import { isClienteServiceError } from "../clientes/services";
import { isContratoServiceError } from "../contratos/services/errors";
import { ZodError } from "zod";
import { FechamentoServiceError } from '../fechamentos/services/errors';
import { PricingServiceError } from '../comercial/services/errors';
import { AvailabilityServiceError } from '../disponibilidade/services/errors';
import { CondicaoPagamentoError } from '../comercial/condicao-pagamento';

export function jsonNoStore(data: unknown, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function apiErrorResponse(error: unknown) {
  if(error instanceof CondicaoPagamentoError) return jsonNoStore({ok:false,erro:error.message,codigo:'DADOS_INVALIDOS'},{status:400});
  if (error instanceof SyntaxError || error instanceof ZodError) {
    return NextResponse.json({ok:false,erro:'Dados inválidos.',codigo:'DADOS_INVALIDOS'}, {status:400,headers:{'Cache-Control':'no-store'}});
  }
  if (isClienteServiceError(error) || isContratoServiceError(error) || error instanceof FechamentoServiceError || error instanceof PricingServiceError || error instanceof AvailabilityServiceError) {
    return NextResponse.json(
      {
        ok: false,
        erro: error.message,
        codigo: error.code,
        detalhes: error.details ?? null,
      },
      { status: error.httpStatus, headers: { "Cache-Control": "no-store" } },
    );
  }

  console.error("[Kidmais CRM API] erro não tratado", error);
  return NextResponse.json(
    {
      ok: false,
      erro: "Erro interno ao processar a solicitação.",
      codigo: "ERRO_INTERNO",
    },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
