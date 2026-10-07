import { NextRequest } from "next/server";
import { z } from "zod";
import { UNIDADES_ADICIONAL, lerAdicionaisAdmin, salvarAdicionalEmEtapas, type EmTransacao } from "@/lib/comercial/adicionais-admin";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Adicionais da empresa comprovada (Tenant Context): itens/categorias do buffet vendidos como adicional e os
 * "outros adicionais". Ler: qualquer membership. Gravar: só quem gere a empresa. O buffet global não é alterado.
 */
const uuid = z.string().uuid();
const modalidade = z.enum(["INCLUSO", "EXTRA", "INDISPONIVEL"]);
const entrada = z.object({
  empresaId: uuid.nullable().optional(),
  id: uuid.optional(),
  origem: z.object({ tipo: z.enum(["ITEM", "CATEGORIA"]), id: uuid }).strict().optional(),
  nome: z.string().trim().min(1).max(160),
  categoria: z.string().trim().min(1).max(40),
  unidadeCobranca: z.enum(UNIDADES_ADICIONAL),
  ativo: z.boolean(),
  escolhasMax: z.number().int().min(1).max(30).nullable().optional(),
  preco: z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/).nullable().optional(),
  pacotes: z.record(uuid, modalidade).optional(),
}).strict().refine((e) => !(e.id && e.origem), { message: "Informe o adicional ou a origem, não os dois." });

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) =>
      lerAdicionaisAdmin(tx, tenant.empresaComprovada));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const { empresaId, ...dados } = entrada.parse(await request.json());
    // A empresa é comprovada (e a gestão exigida) em cada transação; a primeira fixa qual é.
    let empresaComprovada: string | null = null;
    const emTransacao: EmTransacao = (trabalho) => withTenantTransaction(sessao, empresaId ?? null, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode editar os adicionais.");
      if (empresaComprovada !== null && tenant.empresaComprovada !== empresaComprovada) throw new Error("Empresa mudou entre etapas.");
      empresaComprovada = tenant.empresaComprovada;
      return trabalho(tx);
    });
    const empresa = await emTransacao(async () => empresaComprovada!);
    const salvo = await salvarAdicionalEmEtapas(emTransacao, {
      empresaId: empresa,
      usuarioId: sessao.usuario_id,
      requestId: crypto.randomUUID(),
    }, dados);
    return jsonNoStore({ ok: true, data: salvo });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
