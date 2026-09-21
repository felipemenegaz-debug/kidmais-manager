import { NextRequest, NextResponse } from "next/server";
import { isContratoServiceError } from "@/lib/contratos/services";
import { isIdentityServiceError } from "@/lib/identidade/services";
import { FestaError } from "@/lib/festas/domain";

export type ContratoRouteContext = {
  params: Promise<{ contratoId: string }>;
};

export async function contratoIdDaRota(context: ContratoRouteContext) {
  const params = await Promise.resolve(context.params);
  return params.contratoId;
}

export function noStoreContrato(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function contextoContratoPublicoDaRequest(request: NextRequest) {
  return {
    requestId: crypto.randomUUID(),
    // Sem proxy confiável configurado: cabeçalhos fornecidos pelo cliente não são prova de IP.
    ip: null,
    userAgent: request.headers.get("user-agent"),
  };
}

export function erroContratoPublico(error: unknown) {
  if (error instanceof FestaError) {
    return noStoreContrato(NextResponse.json({ ok: false, erro: error.message, codigo: 'FORMALIZACAO_FESTA_RECUSADA' }, { status: error.status }));
  }
  if (error && typeof error === 'object' && 'code' in error && ['23514', '23505', '40001', '40P01', '55P03'].includes(String(error.code))) {
    return noStoreContrato(NextResponse.json({ ok: false, erro: 'A formalização não foi concluída: conflito de agenda ou alteração concorrente. Atualize o contrato e tente novamente.', codigo: 'FORMALIZACAO_CONFLITO' }, { status: 409 }));
  }
  if (isContratoServiceError(error) || isIdentityServiceError(error)) {
    return noStoreContrato(
      NextResponse.json(
        {
          ok: false,
          erro: error.message,
          codigo: error.code,
          detalhes: error.httpStatus < 500 ? (error.details ?? null) : undefined,
        },
        { status: error.httpStatus },
      ),
    );
  }

  console.error("[Kidmais Contrato Público] erro não tratado", error);
  return noStoreContrato(
    NextResponse.json(
      {
        ok: false,
        erro: "Não foi possível processar o Contrato agora.",
        codigo: "ERRO_CONTRATO_PUBLICO",
      },
      { status: 500 },
    ),
  );
}
