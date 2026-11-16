import type { NextRequest } from "next/server";
import { z } from "zod";
import { conferirPendencias } from "@/lib/financeiro/escritor-p2";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirRecursoPlano } from "@/lib/assinatura/recursos-plano";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIPOS = ["RECEBIMENTO", "ENTRADA_MANUAL", "LIQUIDACAO_MANUAL", "SAIDA", "REVERSAO_SAIDA", "ESTORNO", "DEVOLUCAO"] as const;

/** "Conferido" de uma pendência ou de um lote explícito (até 200 itens). Só a Gestão. */
const corpo = z.object({
  versaoAbertura: z.number().int().min(1),
  itens: z.array(z.object({
    tipo: z.enum(TIPOS),
    origemId: z.string().uuid(),
    atributosHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()).min(1).max(200),
  chave: z.string().min(8).max(160),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const input = corpo.parse(await request.json());
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Só a gestão da empresa confere a abertura de saldo.");
      await exigirRecursoPlano(tx, tenant.empresaComprovada, "FINANCEIRO_COMPLETO");
      return conferirPendencias(tx, tenant.empresaComprovada, tenant.usuarioId, input);
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
