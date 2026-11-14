import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { lerSessao, sair, sairDeTodos } from "@/lib/area-familia/acesso";
import { areaFamiliaLigada, HEADERS_AREA, lerCorpoJson, naoEncontrada, origemPublicaValida, responderArea } from "@/lib/area-familia/http";
import { CODIGO_EMPRESA_AREA, cookieApagado, nomeCookieArea } from "@/lib/area-familia/tokens";
import { withTransaction } from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corpo = z.object({ todos: z.boolean().default(false) }).strict();

/** Sair deste aparelho, ou de todos os aparelhos desta pessoa. Sempre apaga o cookie. */
export async function POST(request: NextRequest, contexto: { params: Promise<{ empresa: string }> }) {
  const { empresa } = await contexto.params;
  if (!areaFamiliaLigada() || !CODIGO_EMPRESA_AREA.test(empresa)) return naoEncontrada();
  if (!origemPublicaValida(request)) return responderArea({ ok: false, erro: "Origem recusada.", codigo: "ORIGEM_RECUSADA" }, 403);
  const dados = corpo.safeParse(await lerCorpoJson(request));
  if (!dados.success) return responderArea({ ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS" }, 400);
  try {
    const token = request.cookies.get(nomeCookieArea(empresa))?.value;
    await withTransaction(async (tx) => {
      const sessao = await lerSessao(tx, empresa, token);
      if (!sessao) return;
      if (dados.data.todos) await sairDeTodos(tx, sessao);
      else await sair(tx, sessao);
    });
    const resposta = NextResponse.json({ ok: true }, { headers: HEADERS_AREA });
    resposta.cookies.set(cookieApagado(empresa));
    return resposta;
  } catch (error) {
    console.error("[Kidmais Área da família] falha ao sair", error instanceof Error ? error.name : "erro");
    return responderArea({ ok: false, erro: "Não foi possível sair agora. Tente novamente.", codigo: "ERRO_SAIR" }, 503);
  }
}
