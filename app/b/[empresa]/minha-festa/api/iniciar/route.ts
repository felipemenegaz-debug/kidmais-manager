import type { NextRequest } from "next/server";
import { z } from "zod";
import { iniciarEntrada } from "@/lib/area-familia/acesso";
import {
  areaFamiliaLigada, codigoIndisponivel, lerCorpoJson, limitarArea, muitasTentativas, naoEncontrada, origemPublicaValida,
  pepperIdentidade, recusaGenerica, responderArea,
} from "@/lib/area-familia/http";
import { LIMITES } from "@/lib/area-familia/limites";
import { CODIGO_EMPRESA_AREA } from "@/lib/area-familia/tokens";
import { withTransaction } from "@/lib/db/postgres";
import { enviarOtpComAmbiente } from "@/lib/identidade/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corpo = z.object({
  token: z.string().min(1).max(64),
  documento: z.string().max(32).optional().nullable(),
}).strict();

/** Passo 1 da entrada: link + documento → código no WhatsApp da própria pessoa. */
export async function POST(request: NextRequest, contexto: { params: Promise<{ empresa: string }> }) {
  const { empresa } = await contexto.params;
  if (!areaFamiliaLigada() || !CODIGO_EMPRESA_AREA.test(empresa)) return naoEncontrada();
  if (!origemPublicaValida(request)) return responderArea({ ok: false, erro: "Origem recusada.", codigo: "ORIGEM_RECUSADA" }, 403);
  const pepper = pepperIdentidade();
  if (!pepper || codigoIndisponivel()) {
    return responderArea({ ok: false, erro: "O envio de código está indisponível agora. Tente mais tarde.", codigo: "CODIGO_INDISPONIVEL" }, 503);
  }
  const dados = corpo.safeParse(await lerCorpoJson(request));
  if (!dados.success) return responderArea({ ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS" }, 400);
  try {
    const limite = await limitarArea(request, LIMITES.AREA_INICIAR_ORIGEM, `empresa:${empresa}`, pepper);
    if (limite) return limite;
    const r = await withTransaction((tx) => iniciarEntrada(tx, { pepper, enviarOtp: enviarOtpComAmbiente }, {
      empresaCodigo: empresa, token: dados.data.token, documento: dados.data.documento ?? null,
    }));
    if (!r.ok) return r.motivo === "LIMITE" ? muitasTentativas() : recusaGenerica();
    return responderArea({ ok: true, validacaoId: r.validacaoId, destinoMascarado: r.destinoMascarado, expiraEm: r.expiraEm });
  } catch (error) {
    // Sem dados da pessoa no log: só o nome do erro.
    console.error("[Kidmais Área da família] falha ao iniciar entrada", error instanceof Error ? error.name : "erro");
    return responderArea({ ok: false, erro: "Não foi possível enviar o código agora. Tente novamente.", codigo: "ERRO_INICIAR" }, 503);
  }
}
