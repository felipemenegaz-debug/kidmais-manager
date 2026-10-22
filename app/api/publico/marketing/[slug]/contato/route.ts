import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { db, withTransaction } from "@/lib/db/postgres";
import { ipDaRequisicao } from "@/lib/acessos/http";
import { criarLimitador } from "@/lib/http/limite-publico";
import { capturarContatoPublico, esquemaFormularioPublico } from "@/lib/marketing/contatos";
import { sitePublicoPorSlug } from "@/lib/marketing/site/publico";
import { capturarCampanha } from "@/lib/marketing/utm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MENSAGEM = "Recebemos seu pedido. O buffet vai responder pelo contato informado.";
const limitador = criarLimitador();

function responder(corpo: unknown, status: number, extra: Record<string, string> = {}) {
  return NextResponse.json(corpo, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...extra } });
}
const naoEncontrado = () => responder({ ok: false, erro: "Página não encontrada.", codigo: "NAO_ENCONTRADO" }, 404);

/** Mesmo site: Origin (quando o navegador manda) precisa ter o mesmo host da requisição. */
function origemAceita(request: NextRequest) {
  const origem = request.headers.get("origin");
  if (!origem) return true;
  try { return new URL(origem).host.toLowerCase() === (request.headers.get("host") ?? "").toLowerCase(); } catch { return false; }
}

/**
 * Pedido de orçamento do site público. Resposta igual para cliente novo, cliente existente, repetição e robô
 * (honeypot): nada revela se o contato já existia. Empresa e unidade vêm do site publicado, nunca do corpo.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!origemAceita(request)) return responder({ ok: false, erro: "Origem recusada.", codigo: "ORIGEM_RECUSADA" }, 403);
  const espera = limitador.verificar(ipDaRequisicao(request), "PEDIDO", `site:${slug.slice(0, 64)}`);
  if (espera !== null) return responder({ ok: false, erro: "Muitas tentativas em pouco tempo. Aguarde um pouco e tente novamente.", codigo: "LIMITE_REQUISICOES" }, 429, { "Retry-After": String(espera) });
  try {
    const texto = await request.text();
    if (texto.length > 16_000) return responder({ ok: false, erro: "Pedido grande demais.", codigo: "DADOS_INVALIDOS" }, 413);
    const corpo = esquemaFormularioPublico.parse(texto ? JSON.parse(texto) : {});
    const site = await sitePublicoPorSlug(db(), slug);
    if (!site || site.conteudo.formulario?.ativo !== true) return naoEncontrado();
    if (corpo.website) return responder({ ok: true, data: { mensagem: MENSAGEM } }, 202);
    const captura = capturarCampanha({ utm_source: corpo.utm_source, utm_medium: corpo.utm_medium, utm_campaign: corpo.utm_campaign,
      utm_content: corpo.utm_content, utm_term: corpo.utm_term, kc: corpo.kc });
    await withTransaction((tx) => capturarContatoPublico(tx, { siteId: site.siteId, empresaId: site.empresaId, estabelecimentoId: site.estabelecimentoId }, {
      nome: corpo.nome, telefone: corpo.telefone || null, email: corpo.email || null, dataDesejada: corpo.dataDesejada || null,
      convidados: typeof corpo.convidados === "number" ? corpo.convidados : null, mensagem: corpo.mensagem || null, chave: corpo.chave, autorizaWhatsapp: corpo.autorizaWhatsapp === true,
    }, captura));
    return responder({ ok: true, data: { mensagem: MENSAGEM } }, 202);
  } catch (error) {
    if (error instanceof ZodError) {
      const primeiro = error.issues[0];
      const mensagem = primeiro?.message && !/^Invalid|^Expected|^Unrecognized|^Too/.test(primeiro.message) ? primeiro.message : "Revise os dados do formulário.";
      return responder({ ok: false, erro: mensagem, codigo: "DADOS_INVALIDOS", detalhes: { campo: primeiro?.path.join(".") ?? null } }, 400);
    }
    if (error instanceof SyntaxError) return responder({ ok: false, erro: "Revise os dados do formulário.", codigo: "DADOS_INVALIDOS" }, 400);
    console.error("[marketing] falha ao registrar pedido do site", error instanceof Error ? error.name : typeof error);
    return responder({ ok: false, erro: "Não foi possível enviar agora. Tente novamente em instantes ou use o contato do buffet.", codigo: "INDISPONIVEL" }, 503);
  }
}
