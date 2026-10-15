import type { NextRequest } from "next/server";
import { z } from "zod";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { lerCorpo, rotaMarketing } from "@/lib/marketing/http";
import { lerOrigens, salvarOrigem } from "@/lib/marketing/origens";
import { exigirGestaoNoTenant } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esquema = z.object({
  codigo: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/).nullable().optional(),
  rotulo: z.string().trim().min(2).max(60),
  ativa: z.boolean(),
  ordem: z.number().int().min(0).max(10000).nullable().optional(),
}).strict();

/** Opções de origem (básico do CRM): qualquer membership lê; só a Gestão ajusta a lista. */
export async function GET(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: null, plano: false }, async ({ tx, tenant }) => ({
    origens: await lerOrigens(tx, tenant.empresaComprovada),
  }));
}

export async function POST(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: null, plano: false }, async ({ tx, tenant }) => {
    exigirGestaoNoTenant(tenant, "Apenas a Gestão ajusta a lista de origens.");
    const input = esquema.parse(await lerCorpo(request));
    const salva = await salvarOrigem(tx, tenant.empresaComprovada, input);
    return { ...salva, origens: await lerOrigens(tx, tenant.empresaComprovada) };
  });
}
