import { NextResponse, type NextRequest } from "next/server";
import { rotear } from "./lib/marketing/dominios/hosts";

/**
 * Proxy (Next 16, antigo middleware). Única função: domínio personalizado do site público (Marketing).
 *   - Pedido direto a /sd/... (destino interno da reescrita) vira 404 em qualquer Host.
 *   - Com MARKETING_DOMINIOS_PERSONALIZADOS diferente de "true" (padrão), nada mais acontece: o app segue como antes.
 *   - Ligado: Host da plataforma segue igual; outro Host é reescrito para /sd/<host>/..., que só responde se o domínio
 *     estiver ATIVO no banco e o Host recebido for o mesmo do caminho (painel e APIs internas nunca abrem por domínio
 *     de cliente).
 * Sem banco aqui: a decisão é só pelo Host e pelo caminho (lib/marketing/dominios/hosts.ts, testada sem rede).
 */
export function proxy(request: NextRequest) {
  const rota = rotear(request.headers.get("host"), request.nextUrl.pathname, process.env);
  if (rota.tipo !== "DOMINIO") return NextResponse.next();
  // Reescrita interna (mesma origem do servidor). Atenção local: com `next dev --hostname 127.0.0.1` o Next troca
  // 127.0.0.1 por localhost na URL e passa a tratar toda reescrita do proxy como externa; use --hostname localhost.
  const destino = new URL(`${rota.destino}${request.nextUrl.search}`, request.url);
  return NextResponse.rewrite(destino);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
