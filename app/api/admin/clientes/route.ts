import { NextRequest } from "next/server";
import {
  buscarClientesCrm,
  cadastrarClienteInterno,
  listarClientesCrm,
} from "@/lib/clientes/services";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { contextoCrmDaRequest, exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { clienteCadastroSchema } from "./schemas";

// `?empresaId=` só escolhe entre memberships ATIVA do próprio usuário (provarTenant).
// Nenhum campo do corpo define ou autoriza empresa.
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim() ?? "";
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0);
    const incluirInativos = searchParams.get("incluirInativos") === "true";

    const data = await withTenantTransaction(sessao, searchParams.get("empresaId"), (tx, tenant) =>
      q
        ? buscarClientesCrm(q, tenant.empresaComprovada, limit, incluirInativos, tx)
        : listarClientesCrm(tenant.empresaComprovada, { limit, offset, status: incluirInativos ? "CANONICOS" : "ATIVO" }, tx),
    );

    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const body = await request.json();
    const parsed = clienteCadastroSchema.safeParse(body);
    if (!parsed.success) {
      return jsonNoStore(
        { ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS", detalhes: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) =>
      cadastrarClienteInterno(
        { ...parsed.data, empresaId: tenant.empresaComprovada },
        contextoCrmDaRequest(request),
        tx,
      ),
    );
    return jsonNoStore({ ok: true, data: result }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
