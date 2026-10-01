import { NextRequest } from "next/server";
import { z } from "zod";
import { MOTIVOS_PACOTE, motivoOu } from "@/lib/comercial/motivos-pacote";
import { PacoteAdminError, alterarComposicaoPacoteAdmin } from "@/lib/comercial/pacotes-admin";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const motivo = z.string().trim().min(3).max(500).optional();
const vinculo = z.object({
  acao: z.literal("vinculo"),
  empresaId: uuid,
  adicionalId: uuid,
  modalidade: z.enum(["INCLUSO", "EXTRA", "INDISPONIVEL"]),
  motivo,
}).strict();
const buffet = z.object({
  acao: z.literal("buffet"),
  empresaId: uuid,
  categoriaId: uuid,
  ativo: z.boolean(),
  escolhasMin: z.number().int().min(0).max(30),
  escolhasMax: z.number().int().min(0).max(30),
  motivo,
}).strict();
const corpo = z.discriminatedUnion("acao", [vinculo, buffet]);
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = uuid.safeParse((await context.params).id);
    if (!id.success) return jsonNoStore({ ok: false, erro: "Pacote inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    const bruto = await request.json();
    const pedido = z.object({ empresaId: z.string().optional() }).passthrough().parse(bruto);
    await withTenantTransaction(sessao, pedido.empresaId, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode editar a composição.");
      const input = corpo.parse({ ...bruto, empresaId: tenant.empresaComprovada });
      if (input.acao === "buffet" && input.escolhasMin > input.escolhasMax) {
        throw new PacoteAdminError("LIMITE_BUFFET", "O mínimo de escolhas não pode passar do máximo.", 409);
      }
      await alterarComposicaoPacoteAdmin(
        tx,
        id.data,
        input.acao === "vinculo"
          ? { tipo: "vinculo", adicionalId: input.adicionalId, modalidade: input.modalidade }
          : { tipo: "buffet", categoriaId: input.categoriaId, ativo: input.ativo, escolhasMin: input.escolhasMin, escolhasMax: input.escolhasMax },
        {
          empresaId: tenant.empresaComprovada,
          usuarioId: sessao.usuario_id,
          requestId: crypto.randomUUID(),
          motivo: motivoOu(input.motivo, MOTIVOS_PACOTE.composicao),
        },
      );
    });
    return jsonNoStore({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
