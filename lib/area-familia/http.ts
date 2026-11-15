import { NextResponse } from "next/server";
import { ipDaRequisicao } from "../acessos/http.ts";
import { db } from "../db/postgres.ts";
import { otpDesabilitadoNoStaging } from "../identidade/configuracao-otp.ts";
import { consumirLimite, consumirLimiteDaSessao, LIMITES, type RegraLimite } from "./limites.ts";
import { pepperIdentidade } from "./regras-http.ts";

export { areaFamiliaLigada, leituraPermitida, lerCorpoJson, origemPublicaValida, pepperIdentidade } from "./regras-http.ts";

/**
 * Borda HTTP da área "Minha festa". Desligada por padrão: só abre com AREA_FAMILIA_ENABLED=true (senão 404, como
 * endereço inexistente). Toda mutação exige JSON e Origin igual à origem pública configurada (o cookie é SameSite=Lax,
 * mas a conferência de origem fecha a porta de formulários de outro site).
 */
export const HEADERS_AREA = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

export function responderArea(corpo: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(corpo, { status, headers: { ...HEADERS_AREA, ...extra } });
}

export const naoEncontrada = () => responderArea({ ok: false, erro: "Página não encontrada.", codigo: "NAO_ENCONTRADA" }, 404);

/** Mesma recusa para tudo que envolve a prova: não diz se o link, o documento ou a festa existem. */
export const recusaGenerica = () =>
  responderArea({ ok: false, erro: "Não foi possível confirmar seus dados. Confira o link e o documento ou peça um link novo ao buffet.", codigo: "ACESSO_RECUSADO" }, 403);

export const muitasTentativas = (espera = 3600) =>
  responderArea({ ok: false, erro: "Muitas tentativas. Aguarde um pouco e tente novamente.", codigo: "LIMITE_REQUISICOES" }, 429, { "Retry-After": String(espera) });

/** Envio de código indisponível (staging com OTP desligado ou configuração inválida). */
export function codigoIndisponivel() {
  try { return otpDesabilitadoNoStaging(); } catch { return true; }
}

/** null = segue; senão a resposta 429. Conta fora da transação do pedido (autocommit). */
export async function limitarArea(request: Request, regra: RegraLimite, escopo: string, pepper: string) {
  const espera = await consumirLimite(db(), regra, ipDaRequisicao(request), escopo, pepper);
  return espera === null ? null : muitasTentativas(espera);
}

/**
 * Limite por origem no banco para rotas públicas fora da área (contrato, confirmar-codigo). Sem pepper o serviço
 * de identidade já recusa adiante; aqui só não conta. Erro de banco (que não seja a 123 ausente) recusa com 503.
 */
export async function limitarRotaPublicaNoBanco(request: Request, regra: RegraLimite, escopo: string) {
  const pepper = pepperIdentidade();
  if (!pepper) return null;
  try {
    return await limitarArea(request, regra, escopo, pepper);
  } catch (error) {
    console.error("[limite no banco] falha ao contar", error instanceof Error ? error.name : "erro");
    return responderArea({ ok: false, erro: "Não foi possível continuar agora.", codigo: "LIMITE_INDISPONIVEL" }, 503);
  }
}

/** Leitura pesada (PDF, Pix) da sessão: null = segue; senão 429. Conta fora da transação do pedido (autocommit). */
export async function limitarLeituraDaSessao(sessaoId: string, pepper: string) {
  const espera = await consumirLimiteDaSessao(db(), LIMITES.AREA_LEITURA_SESSAO, sessaoId, pepper);
  return espera === null ? null : muitasTentativas(espera);
}
