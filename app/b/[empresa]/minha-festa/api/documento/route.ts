import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { lerSessao } from "@/lib/area-familia/acesso";
import {
  areaFamiliaLigada, HEADERS_AREA, leituraPermitida, limitarLeituraDaSessao, naoEncontrada, pepperIdentidade, responderArea,
} from "@/lib/area-familia/http";
import { adquirirDocumentoFamilia, materializarDocumentoFamilia, type PedidoDocumento } from "@/lib/area-familia/leitura";
import { CODIGO_EMPRESA_AREA, nomeCookieArea } from "@/lib/area-familia/tokens";
import { db, withTransaction } from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pedido = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("contrato") }).strict(),
  z.object({ tipo: z.literal("resumo") }).strict(),
  z.object({ tipo: z.literal("comprovante"), id: z.string().uuid() }).strict(),
]);

const indisponivel = () =>
  responderArea({ ok: false, erro: "Documento indisponível agora. Fale com o buffet.", codigo: "DOCUMENTO_INDISPONIVEL" }, 409);

/**
 * PDF da festa pela SESSÃO da área (F2): sem o token HMAC de 30 min do link público. A festa, o contrato e a versão
 * vêm da sessão; o pedido só escolhe o tipo (e o comprovante, conferido contra a versão vigente do mesmo contrato).
 */
export async function GET(request: NextRequest, contexto: { params: Promise<{ empresa: string }> }) {
  const { empresa } = await contexto.params;
  if (!areaFamiliaLigada() || !CODIGO_EMPRESA_AREA.test(empresa)) return naoEncontrada();
  if (!leituraPermitida(request)) return responderArea({ ok: false, erro: "Origem recusada.", codigo: "ORIGEM_RECUSADA" }, 403);
  const pepper = pepperIdentidade();
  if (!pepper) return responderArea({ ok: false, erro: "Indisponível agora. Tente mais tarde.", codigo: "INDISPONIVEL" }, 503);
  const dados = pedido.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!dados.success) return naoEncontrada();
  const token = request.cookies.get(nomeCookieArea(empresa))?.value;
  try {
    const sessao = await lerSessao(db(), empresa, token);
    if (!sessao) return responderArea({ ok: false, erro: "Sua sessão terminou. Entre de novo.", codigo: "SESSAO_ENCERRADA" }, 401);
    const limite = await limitarLeituraDaSessao(sessao.sessaoId, pepper);
    if (limite) return limite;
    const adquirido = await withTransaction(async (tx) => {
      // Revalida na transação: a sessão pode ter caído entre a contagem e a leitura.
      const atual = await lerSessao(tx, empresa, token);
      if (!atual || atual.sessaoId !== sessao.sessaoId) return null;
      return adquirirDocumentoFamilia(tx, atual, dados.data as PedidoDocumento);
    });
    if (!adquirido) return responderArea({ ok: false, erro: "Sua sessão terminou. Entre de novo.", codigo: "SESSAO_ENCERRADA" }, 401);
    if (!adquirido.ok) return adquirido.motivo === "INDISPONIVEL" ? indisponivel() : naoEncontrada();
    // Depois do commit, só memória.
    const { pdf, arquivo } = materializarDocumentoFamilia(adquirido);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        ...HEADERS_AREA,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${arquivo}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[Kidmais Área da família] falha ao abrir documento", error instanceof Error ? error.name : "erro");
    return indisponivel();
  }
}
