import { atenderMetodoNaoPermitido, atenderToken } from "@/lib/integracoes/oauth/rotas";
import { dependenciasRotasOAuth } from "../../dependencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Token endpoint (RFC 6749): canal e limites antes do corpo; corpo form-urlencoded lido com teto de 8 KiB e prazo. */
export async function POST(request: Request) {
  return atenderToken(request, dependenciasRotasOAuth());
}

/** Todos os outros métodos entram no agregado A10 (nunca o 405 automático do framework). HEAD é atendido pelo GET. */
const naoPermitido = async () => atenderMetodoNaoPermitido("TOKEN", "POST", dependenciasRotasOAuth());
export const GET = naoPermitido;
export const PUT = naoPermitido;
export const PATCH = naoPermitido;
export const DELETE = naoPermitido;
export const OPTIONS = naoPermitido;
