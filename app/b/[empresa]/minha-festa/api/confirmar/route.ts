import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmarEntrada } from "@/lib/area-familia/acesso";
import {
  areaFamiliaLigada, HEADERS_AREA, lerCorpoJson, limitarArea, muitasTentativas, naoEncontrada, origemPublicaValida, pepperIdentidade,
  recusaGenerica, responderArea,
} from "@/lib/area-familia/http";
import { LIMITES } from "@/lib/area-familia/limites";
import { CODIGO_EMPRESA_AREA, cookieDaSessao, rotuloAparelho } from "@/lib/area-familia/tokens";
import { withTransaction } from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corpo = z.object({
  validacaoId: z.string().uuid(),
  codigo: z.string().trim().regex(/^\d{6}$/),
  lembrar: z.boolean().default(false),
}).strict();

/** Passo 2 da entrada: código → sessão (cookie HttpOnly só da área desta empresa). */
export async function POST(request: NextRequest, contexto: { params: Promise<{ empresa: string }> }) {
  const { empresa } = await contexto.params;
  if (!areaFamiliaLigada() || !CODIGO_EMPRESA_AREA.test(empresa)) return naoEncontrada();
  if (!origemPublicaValida(request)) return responderArea({ ok: false, erro: "Origem recusada.", codigo: "ORIGEM_RECUSADA" }, 403);
  const pepper = pepperIdentidade();
  if (!pepper) return responderArea({ ok: false, erro: "Indisponível agora. Tente mais tarde.", codigo: "INDISPONIVEL" }, 503);
  const dados = corpo.safeParse(await lerCorpoJson(request));
  if (!dados.success) return responderArea({ ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS" }, 400);
  try {
    const limite = await limitarArea(request, LIMITES.AREA_CONFIRMAR_ORIGEM, `empresa:${empresa}`, pepper);
    if (limite) return limite;
    const r = await withTransaction((tx) => confirmarEntrada(tx, { pepper }, {
      empresaCodigo: empresa, validacaoId: dados.data.validacaoId, codigo: dados.data.codigo, lembrar: dados.data.lembrar,
      aparelho: rotuloAparelho(request.headers.get("user-agent")),
    }));
    if (!r.ok) {
      if (r.motivo === "LIMITE") return muitasTentativas();
      if (r.motivo === "CODIGO_INCORRETO") return responderArea({ ok: false, erro: "Código incorreto ou vencido.", codigo: "CODIGO_INCORRETO" }, 400);
      return recusaGenerica();
    }
    const resposta = NextResponse.json({ ok: true }, { headers: HEADERS_AREA });
    resposta.cookies.set(cookieDaSessao(empresa, r.token, r.lembrar, r.expiraEm));
    return resposta;
  } catch (error) {
    console.error("[Kidmais Área da família] falha ao confirmar entrada", error instanceof Error ? error.name : "erro");
    return responderArea({ ok: false, erro: "Não foi possível entrar agora. Tente novamente.", codigo: "ERRO_CONFIRMAR" }, 503);
  }
}
