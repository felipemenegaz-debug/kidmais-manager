import type { NextRequest } from "next/server";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { hojeBrasilia } from "./calculos.ts";
import { exigirApiAdminCrmDisponivel } from "../http/admin-crm-api.ts";
import { apiErrorResponse, jsonNoStore } from "../http/api-response.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { exigirRecursoPlano, type RecursoPlano } from "../assinatura/recursos-plano.ts";
import { withTenantTransaction, type TenantComprovado } from "../saas/provar-tenant.ts";

export function hojeIso() {
  return hojeBrasilia();
}

export function periodoDaUrl(request: NextRequest, hoje = hojeIso()) {
  const inicio = request.nextUrl.searchParams.get("inicio");
  const fim = request.nextUrl.searchParams.get("fim");
  const valido = (valor: string | null) => (valor && /^\d{4}-\d{2}-\d{2}$/.test(valor) ? valor : null);
  const de = valido(inicio) ?? `${hoje.slice(0, 7)}-01`;
  const ate = valido(fim) ?? hoje;
  if (de > ate) recusarPeriodo();
  return { inicio: de, fim: ate };
}

function recusarPeriodo(): never {
  throw new PacoteAdminError("DADOS_INVALIDOS", "O período informado não fecha.", 400);
}

export async function consultarFinanceiro<T>(
  request: NextRequest,
  work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>,
  recurso?: RecursoPlano,
) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      if (recurso) await exigirRecursoPlano(tx, tenant.empresaComprovada, recurso);
      return work(tx, tenant);
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
