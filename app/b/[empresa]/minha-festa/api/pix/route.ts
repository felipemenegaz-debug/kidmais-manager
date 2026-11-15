import type { NextRequest } from "next/server";
import { z } from "zod";
import { lerSessao } from "@/lib/area-familia/acesso";
import {
  areaFamiliaLigada, leituraPermitida, limitarLeituraDaSessao, naoEncontrada, pepperIdentidade, responderArea,
} from "@/lib/area-familia/http";
import { contratoDaSessao } from "@/lib/area-familia/leitura";
import { CODIGO_EMPRESA_AREA, nomeCookieArea } from "@/lib/area-familia/tokens";
import { db, withTransaction } from "@/lib/db/postgres";
import { hojeBrasilia } from "@/lib/financeiro/calculos";
import { pixDaParcelaDoContrato } from "@/lib/pagamentos/pix/recebimento";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pedido = z.object({ parcela: z.string().uuid() }).strict();

const MENSAGENS = {
  PIX_INDISPONIVEL: ["O Pix ainda não está disponível. Fale com o buffet.", 409],
  PIX_NAO_CONFIGURADO: ["O buffet ainda não cadastrou o Pix. Fale com o buffet.", 409],
  PARCELA_NAO_ENCONTRADA: ["Parcela não encontrada.", 404],
  PARCELA_SEM_SALDO: ["Esta parcela já está paga.", 409],
} as const;

/**
 * Pix copia e cola + QR de uma parcela do contrato da SESSÃO (F2). A parcela só é achada entre as do próprio contrato
 * (consulta filtrada pelo contrato); de outro contrato, mesmo da mesma empresa, é "não encontrada". Nada é gravado.
 */
export async function GET(request: NextRequest, contexto: { params: Promise<{ empresa: string }> }) {
  const { empresa } = await contexto.params;
  if (!areaFamiliaLigada() || !CODIGO_EMPRESA_AREA.test(empresa)) return naoEncontrada();
  if (!leituraPermitida(request)) return responderArea({ ok: false, erro: "Origem recusada.", codigo: "ORIGEM_RECUSADA" }, 403);
  const pepper = pepperIdentidade();
  if (!pepper) return responderArea({ ok: false, erro: "Indisponível agora. Tente mais tarde.", codigo: "INDISPONIVEL" }, 503);
  const dados = pedido.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!dados.success) return responderArea({ ok: false, erro: MENSAGENS.PARCELA_NAO_ENCONTRADA[0], codigo: "PARCELA_NAO_ENCONTRADA" }, 404);
  const token = request.cookies.get(nomeCookieArea(empresa))?.value;
  try {
    const sessao = await lerSessao(db(), empresa, token);
    if (!sessao) return responderArea({ ok: false, erro: "Sua sessão terminou. Entre de novo.", codigo: "SESSAO_ENCERRADA" }, 401);
    const limite = await limitarLeituraDaSessao(sessao.sessaoId, pepper);
    if (limite) return limite;
    const r = await withTransaction(async (tx) => {
      const atual = await lerSessao(tx, empresa, token);
      if (!atual || atual.sessaoId !== sessao.sessaoId) return null;
      const alvo = await contratoDaSessao(tx, atual);
      if (!alvo) return { ok: false as const, motivo: "PARCELA_NAO_ENCONTRADA" as const };
      return pixDaParcelaDoContrato(tx, atual.empresaId, alvo.contratoId, dados.data.parcela, hojeBrasilia());
    });
    if (!r) return responderArea({ ok: false, erro: "Sua sessão terminou. Entre de novo.", codigo: "SESSAO_ENCERRADA" }, 401);
    if (!r.ok) {
      const [erro, status] = MENSAGENS[r.motivo];
      return responderArea({ ok: false, erro, codigo: r.motivo }, status);
    }
    return responderArea({
      ok: true, copiaECola: r.copiaECola, qrSvg: r.qrSvg, valorCentavos: r.valorCentavos, parcela: r.parcela,
      recebedor: { nome: r.recebedor.nome, chaveMascarada: r.recebedor.chaveMascarada },
    });
  } catch (error) {
    console.error("[Kidmais Área da família] falha ao montar Pix", error instanceof Error ? error.name : "erro");
    return responderArea({ ok: false, erro: "Não foi possível montar o Pix agora. Tente novamente.", codigo: "ERRO_PIX" }, 503);
  }
}
