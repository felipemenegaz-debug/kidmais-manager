import { NextResponse, type NextRequest } from "next/server";
import { decidirEndereco } from "./lib/enderecos/roteamento";
import { rotear } from "./lib/marketing/dominios/hosts";
import { pareceListaDeContratos, urlSemBuscaAntiga } from "./components/admin/contrato-url";

const PAGINA_NEUTRA = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Endereço em ajuste</title></head><body style="font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#090D1B;color:#F4F4F8;padding:24px;text-align:center"><p>Estamos ajustando o endereço. Tente de novo em alguns minutos.</p></body></html>';

/** Staging não deve aparecer em buscas. Isso trata indexação, não é controle de acesso. */
function comIndexacao<T extends NextResponse>(resposta: T): T {
  if (process.env.KIDMAIS_DEPLOY_ENV === "staging") resposta.headers.set("X-Robots-Tag", "noindex, nofollow");
  return resposta;
}

/**
 * Proxy (Next 16, antigo middleware). Três funções:
 *   - Em /admin/contratos, tirar o termo `busca=` de links antigos. Vem primeiro: o termo nunca entra num Location
 *     para outro host. Vale também para o caminho codificado ou com barras a mais, que o Next resolve para a mesma página.
 *   - Troca de host do iA.Fest (lib/enderecos/roteamento.ts): páginas em GET/HEAD recebem 307 sem cache, conforme
 *     ENDERECOS_MODO. APIs nunca são redirecionadas. Sem o modo, só o invariante de demerzellabs.com.br age.
 *   - Domínio personalizado do site público (Marketing):
 *     - Pedido direto a /sd/... (destino interno da reescrita) vira 404 em qualquer Host.
 *     - Com MARKETING_DOMINIOS_PERSONALIZADOS diferente de "true" (padrão), nada mais acontece: o app segue como antes.
 *     - Ligado: Host da plataforma segue igual; outro Host é reescrito para /sd/<host>/..., que só responde se o domínio
 *       estiver ATIVO no banco e o Host recebido for o mesmo do caminho (painel e APIs internas nunca abrem por domínio
 *       de cliente).
 * Sem banco aqui: a decisão é só pelo Host e pelo caminho (testada sem rede).
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  // Link antigo da lista de contratos: o termo pode ser o nome de uma pessoa. Sai antes de a aplicação ser entregue, porque
  // a página não consegue responder 307: o AdminShell só monta a tela depois da sessão, e a resposta já saiu como 200.
  // O destino é sempre o caminho canônico: uma variante como `//admin/contratos` nunca vira Location para outro host.
  const limpa = pareceListaDeContratos(request.nextUrl.pathname) ? urlSemBuscaAntiga("/admin/contratos", request.nextUrl.searchParams) : null;
  if (limpa) return NextResponse.redirect(new URL(limpa, request.url), { status: 307, headers: { "Cache-Control": "no-store" } });
  const endereco = decidirEndereco({ metodo: request.method, host, pathname: request.nextUrl.pathname, search: request.nextUrl.search }, process.env);
  if (endereco.tipo === "REDIRECIONAR") {
    return comIndexacao(new NextResponse(null, { status: 307, headers: { Location: endereco.destino, "Cache-Control": "no-store" } }));
  }
  if (endereco.tipo === "NEUTRA") {
    return new NextResponse(PAGINA_NEUTRA, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "300", "X-Robots-Tag": "noindex" },
    });
  }
  const rota = rotear(host, request.nextUrl.pathname, process.env);
  if (rota.tipo !== "DOMINIO") return comIndexacao(NextResponse.next());
  // Reescrita interna (mesma origem do servidor). Atenção local: com `next dev --hostname 127.0.0.1` o Next troca
  // 127.0.0.1 por localhost na URL e passa a tratar toda reescrita do proxy como externa; use --hostname localhost.
  const destino = new URL(`${rota.destino}${request.nextUrl.search}`, request.url);
  return comIndexacao(NextResponse.rewrite(destino));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
