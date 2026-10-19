import type { NextRequest } from "next/server";
import { z } from "zod";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { lerCorpo, rotaMarketing } from "@/lib/marketing/http";
import { CAPACIDADES_MARKETING, ROTULO_CAPACIDADE, concederCapacidade, listarConcessoes, revogarCapacidade } from "@/lib/marketing/capacidades";
import { exigirGestaoNoTenant } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esquema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("conceder"), membershipId: z.string().uuid(), capacidade: z.enum(CAPACIDADES_MARKETING), motivo: z.string().trim().min(3).max(300) }).strict(),
  z.object({ acao: z.literal("revogar"), concessaoId: z.string().uuid(), motivo: z.string().trim().min(3).max(300) }).strict(),
]);

/** Concessões de Marketing para a Equipe: só a Gestão da empresa vê e altera (como as capacidades de Festa e do Perfil). */
export async function GET(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: null }, async ({ tx, tenant }) => {
    exigirGestaoNoTenant(tenant, "Apenas a Gestão gerencia as permissões de Marketing.");
    return { equipe: await listarConcessoes(tx, tenant.empresaComprovada), capacidades: CAPACIDADES_MARKETING.map((c) => ({ codigo: c, rotulo: ROTULO_CAPACIDADE[c] })) };
  });
}

export async function POST(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: null }, async ({ tx, tenant }) => {
    exigirGestaoNoTenant(tenant, "Apenas a Gestão gerencia as permissões de Marketing.");
    const acao = esquema.parse(await lerCorpo(request));
    const resultado = acao.acao === "conceder" ? await concederCapacidade(tx, tenant, acao) : await revogarCapacidade(tx, tenant, acao);
    return { resultado, equipe: await listarConcessoes(tx, tenant.empresaComprovada) };
  });
}
