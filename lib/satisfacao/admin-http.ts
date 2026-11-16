import type { NextRequest } from "next/server";
import type { DbExecutor } from "../db/contracts.ts";
import type { SessaoAdmin } from "../autenticacao/service.ts";
import { exigirRecursoPlano } from "../assinatura/recursos-plano.ts";
import { apiErrorResponse, jsonNoStore } from "../http/api-response.ts";
import { withTenantTransaction, type TenantComprovado } from "../saas/provar-tenant.ts";
import { isSatisfacaoError, SatisfacaoError } from "./erros.ts";
import { pesquisaLigada } from "./http.ts";

/**
 * Molde das APIs administrativas da pesquisa (PS-3). Ordem fixa:
 *   1. pesquisa ligada (SATISFACAO_PESQUISA_ENABLED) — desligada é o rollback operacional: nenhuma rota escreve;
 *   2. guarda administrativa recebida da rota (sessão, CSRF e origem nas mutações, situação comercial);
 *   3. transação de tenant (empresa, membership e usuário SEMPRE da sessão comprovada);
 *   4. plano com MARKETING (a pesquisa nasce da regra Pós-festa do Marketing).
 * NÃO exige capacidades de Marketing: o escopo da pesquisa é o da própria pesquisa (Gestão ou SATISFACAO_TRATAR).
 * 42P01 (tabela da 111 sumiu no meio da requisição) vira 503 com rollback — rede de segurança, não coordenação.
 */
export type ContextoSatisfacaoAdmin = { tx: DbExecutor; tenant: TenantComprovado };
export type GuardaAdmin = (request: NextRequest) => Promise<SessaoAdmin>;

export function respostaErroSatisfacaoAdmin(error: unknown) {
  if (isSatisfacaoError(error)) {
    const exemplos = Array.isArray(error.details?.exemplos) ? { exemplos: error.details.exemplos } : {};
    return jsonNoStore({ ok: false, erro: error.message, codigo: error.code, ...exemplos }, { status: error.httpStatus });
  }
  if ((error as { code?: unknown })?.code === "42P01") {
    return jsonNoStore({ ok: false, erro: "Este recurso da pesquisa ainda não está instalado.", codigo: "NAO_INSTALADO" }, { status: 503 });
  }
  return apiErrorResponse(error);
}

export async function rotaSatisfacaoAdmin<T>(request: NextRequest, guarda: GuardaAdmin, work: (ctx: ContextoSatisfacaoAdmin) => Promise<T>) {
  try {
    if (!pesquisaLigada()) throw new SatisfacaoError("PESQUISA_INDISPONIVEL", "A pesquisa está indisponível no momento.", 503);
    const sessao = await guarda(request);
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      await exigirRecursoPlano(tx, tenant.empresaComprovada, "MARKETING");
      return work({ tx, tenant });
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return respostaErroSatisfacaoAdmin(error);
  }
}
