import { NextRequest } from "next/server";
import { lerDescontoDiaAdmin, salvarDescontoDiaAdmin } from "@/lib/comercial/descontos-dia-admin";
import { PacoteAdminError } from "@/lib/comercial/pacotes-admin";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** D3 (18/11/2026): desconto por dia da semana da PRÓPRIA empresa. Só a Gestão lê e grava (revalidado no serviço). */
// GET e POST: empresa ativa da sessão; nenhum parâmetro do pedido escolhe empresa.
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, null, (tx, tenant) => lerDescontoDiaAdmin(tx, tenant));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const bruto: unknown = await request.json();
    // A empresa da gravação é SEMPRE a empresa ativa da sessão (provarTenant com null). O corpo não escolhe empresa:
    // empresaId no JSON é recusado antes de abrir a transação (validarDescontoDia também recusa campo extra).
    if (bruto && typeof bruto === "object" && !Array.isArray(bruto) && Object.hasOwn(bruto, "empresaId"))
      throw new PacoteAdminError("DADOS_INVALIDOS", "Dados inválidos.", 400);
    const data = await withTenantTransaction(sessao, null, (tx, tenant) =>
      salvarDescontoDiaAdmin(tx, tenant, bruto, { requestId: crypto.randomUUID() }));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
