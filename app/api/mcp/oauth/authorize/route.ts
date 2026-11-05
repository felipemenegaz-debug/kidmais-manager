import { atenderAutorizacao, atenderMetodoNaoPermitido } from "@/lib/integracoes/oauth/rotas";
import { dependenciasRotasOAuth } from "../../dependencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Início da autorização OAuth (público, sem sessão). Canal desligado ⇒ 503 antes de tudo; limites próprios por origem
 * confiável, cliente e global; teto persistente de pedidos pendentes. Erro antes de conferir o redirect nunca redireciona.
 */
export async function GET(request: Request) {
  return atenderAutorizacao(request, dependenciasRotasOAuth());
}

/** Todos os outros métodos entram no agregado A10 (nunca o 405 automático do framework). HEAD é atendido pelo GET. */
const naoPermitido = async () => atenderMetodoNaoPermitido("AUTHORIZE", "GET", dependenciasRotasOAuth());
export const POST = naoPermitido;
export const PUT = naoPermitido;
export const PATCH = naoPermitido;
export const DELETE = naoPermitido;
export const OPTIONS = naoPermitido;
