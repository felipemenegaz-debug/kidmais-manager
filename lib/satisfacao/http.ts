import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { verificarOrigem } from "../http/admin-crm-api.ts";
import { isClienteServiceError } from "../clientes/services/errors.ts";
import { ipDaRequisicao, lerJson } from "../acessos/http.ts";
import { isSatisfacaoError, SatisfacaoError } from "./erros.ts";
import type { ContextoPublico } from "./publico.ts";

/**
 * HTTP das rotas públicas da pesquisa (plano R8). Toda resposta: no-store, noindex, no-referrer. Nada do corpo é
 * registrado (token, notas, comentário); erro inesperado registra só o nome do erro. Desligada
 * (SATISFACAO_PESQUISA_ENABLED diferente de "true"): 503 genérico, antes de ler o corpo.
 */
export const CABECALHOS_PUBLICOS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
};

export function pesquisaLigada(env: Record<string, string | undefined> = process.env) {
  return env.SATISFACAO_PESQUISA_ENABLED === "true";
}

export function responderPublico(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CABECALHOS_PUBLICOS });
}

export function falharPublico(error: unknown) {
  if (isSatisfacaoError(error)) {
    const res = responderPublico({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus);
    const segundos = error.details?.retryAfterSegundos;
    if (error.httpStatus === 429 && typeof segundos === "number" && Number.isFinite(segundos) && segundos > 0) res.headers.set("Retry-After", String(Math.max(1, Math.ceil(segundos))));
    return res;
  }
  if (error instanceof ZodError) {
    const primeiro = error.issues[0];
    const mensagem = primeiro?.message && !/^Invalid|^Expected|^Too|^Unrecognized/.test(primeiro.message) ? primeiro.message : "Confira as respostas.";
    return responderPublico({ ok: false, erro: mensagem, codigo: "DADOS_INVALIDOS" }, 400);
  }
  if (error instanceof SyntaxError) return responderPublico({ ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS" }, 400);
  if (isClienteServiceError(error) && error.httpStatus === 403) return responderPublico({ ok: false, erro: "Origem da requisição recusada.", codigo: "ORIGEM_RECUSADA" }, 403);
  console.error("[satisfacao] erro não tratado", error instanceof Error ? error.name : typeof error);
  return responderPublico({ ok: false, erro: "Não foi possível concluir agora. Tente de novo em instantes.", codigo: "ERRO_INTERNO" }, 500);
}

/** Rota pública: ligada → mesma origem (verificarOrigem) → corpo → serviço. */
export async function rotaPublica(request: NextRequest, servico: (corpo: unknown, ctx: ContextoPublico) => Promise<unknown>) {
  try {
    if (!pesquisaLigada()) throw new SatisfacaoError("PESQUISA_INDISPONIVEL", "A pesquisa está indisponível no momento.", 503);
    verificarOrigem(request);
    const data = await servico(await lerJson(request), { ip: ipDaRequisicao(request) });
    return responderPublico({ ok: true, data });
  } catch (error) {
    return falharPublico(error);
  }
}
