import { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/autenticacao/service";
import { simularPrecoPacote } from "@/lib/comercial/tabelas-preco-admin";
import { recusarTenantNaoComprovado } from "@/lib/comercial/autorizacao-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const simular = z.object({ acao: z.literal("simular"), valor: z.string().nullable(), sobConsulta: z.boolean() }).strict();
const corpo = z.object({ acao: z.string() }).passthrough();

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (sessao.papel !== "REPRESENTANTE_AUTORIZADO") throw authError("Apenas o proprietário pode editar tabelas de preços.", 403);
    const bruto = corpo.parse(await request.json());
    if (bruto.acao === "simular") {
      const input = simular.parse(bruto);
      return jsonNoStore({ ok: true, data: simularPrecoPacote(input) });
    }
    recusarTenantNaoComprovado(sessao, request.nextUrl.searchParams.get("empresaId"));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
