import { NextResponse } from 'next/server';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { isClienteServiceError } from '../clientes/services/errors.ts';
import { apiErrorResponse } from '../http/api-response.ts';
import { isWhatsappOnboardingError } from './errors.ts';

export function respostaWhatsapp(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Erro das rotas de WhatsApp com o status real: regra do WhatsApp (WhatsappOnboardingError), sessão/contexto da
 * página (ClienteServiceError, ex.: 409 que o adminFetch trata) e empresa não comprovada (PacoteAdminError do
 * provarTenant). Qualquer outro erro vira 500 com a mensagem genérica da rota, sem detalhes internos.
 */
export function erroWhatsapp(error: unknown, mensagemPadrao: string) {
  if (isWhatsappOnboardingError(error)) return respostaWhatsapp({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus);
  if (isClienteServiceError(error) || error instanceof PacoteAdminError) return apiErrorResponse(error);
  return respostaWhatsapp({ ok: false, erro: mensagemPadrao }, 500);
}
