import type { NextRequest } from "next/server";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { db } from "@/lib/db/postgres";
import { empresasSuspensasExportaveis } from "@/lib/exportacao/guarda";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Empresas SUSPENSAS em que a pessoa da sessão é Gestão com vínculo ativo (id e nome), para a tela "Sem empresa ativa"
 * oferecer a exportação. Só leitura; não concede nada: o download passa pela guarda da exportação.
 */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const empresas = sessao.empresa_ativa_id ? [] : await empresasSuspensasExportaveis(db(), sessao.usuario_id);
    return jsonNoStore({ ok: true, data: { empresas } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
