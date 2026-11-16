import type { NextRequest } from "next/server";
import { lerSessao } from "@/lib/area-familia/acesso";
import { agirComSessao } from "@/lib/area-familia/acoes";
import { corpoAcaoFamilia, MENSAGENS_ACAO } from "@/lib/area-familia/acoes-http";
import {
  areaFamiliaLigada, lerCorpoJson, limitarAcaoDaSessao, naoEncontrada, origemPublicaValida, pepperIdentidade, responderArea,
} from "@/lib/area-familia/http";
import { CODIGO_EMPRESA_AREA, nomeCookieArea } from "@/lib/area-familia/tokens";
import { db, withTransaction } from "@/lib/db/postgres";
import { hojeBrasilia } from "@/lib/financeiro/calculos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSAO_ENCERRADA = () => responderArea({ ok: false, erro: "Sua sessão terminou. Entre de novo.", codigo: "SESSAO_ENCERRADA" }, 401);

/**
 * Ações da família (F3, 125): "Já paguei", "Feito" numa pendência, convidar / novo link / remover o segundo responsável.
 * Ordem: área ligada → origem → corpo (zod estrito) → pepper → sessão → limite por sessão (fora da transação) →
 * transação que trava a festa, relê e prende a MESMA sessão (agirComSessao) e executa. Sem a 125: 503, nada gravado. Nada de CPF, telefone ou token em log.
 */
export async function POST(request: NextRequest, contexto: { params: Promise<{ empresa: string }> }) {
  const { empresa } = await contexto.params;
  if (!areaFamiliaLigada() || !CODIGO_EMPRESA_AREA.test(empresa)) return naoEncontrada();
  if (!origemPublicaValida(request)) return responderArea({ ok: false, erro: "Origem recusada.", codigo: "ORIGEM_RECUSADA" }, 403);
  const dados = corpoAcaoFamilia.safeParse(await lerCorpoJson(request));
  if (!dados.success) return responderArea({ ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS" }, 400);
  const pepper = pepperIdentidade();
  if (!pepper) return responderArea({ ok: false, erro: "Indisponível agora. Tente mais tarde.", codigo: "INDISPONIVEL" }, 503);
  const token = request.cookies.get(nomeCookieArea(empresa))?.value;
  try {
    const sessao = await lerSessao(db(), empresa, token);
    if (!sessao || !token) return SESSAO_ENCERRADA();
    const limite = await limitarAcaoDaSessao(sessao.sessaoId, pepper);
    if (limite) return limite;
    const r = await withTransaction((tx) => agirComSessao(tx, empresa, token, sessao, dados.data, { pepper, hoje: hojeBrasilia() }));
    if (r === "SESSAO") return SESSAO_ENCERRADA();
    if (r === "INDISPONIVEL") return responderArea({ ok: false, erro: "Esta função ainda não está disponível.", codigo: "ACOES_INDISPONIVEIS" }, 503);
    if (!r.ok) {
      const [erro, status] = MENSAGENS_ACAO[r.motivo];
      return responderArea({ ok: false, erro, codigo: r.motivo }, status);
    }
    return responderArea(r);
  } catch (error) {
    console.error("[Kidmais Área da família] falha na ação", error instanceof Error ? error.name : "erro");
    return responderArea({ ok: false, erro: "Não foi possível concluir agora. Tente novamente.", codigo: "ERRO_ACAO" }, 503);
  }
}
