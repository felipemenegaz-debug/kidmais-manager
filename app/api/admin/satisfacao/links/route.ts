import type { NextRequest } from "next/server";
import { z } from "zod";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { lerCorpo } from "@/lib/marketing/http";
import { rotaSatisfacaoAdmin } from "@/lib/satisfacao/admin-http";
import { listarLinks, removerLink, salvarLink } from "@/lib/satisfacao/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unidade = z.string().uuid().nullable();
const esquema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("salvar"), estabelecimentoId: unidade, url: z.string().max(2000) }).strict(),
  z.object({ acao: z.literal("remover"), estabelecimentoId: unidade }).strict(),
]);

/** Link de avaliação do Google por empresa/unidade (só Gestão; empresa e autor do tenant, unidade conferida na empresa). */
export async function GET(request: NextRequest) {
  return rotaSatisfacaoAdmin(request, exigirApiAdminCrmDisponivel, ({ tx, tenant }) => listarLinks(tx, tenant));
}

export async function POST(request: NextRequest) {
  return rotaSatisfacaoAdmin(request, exigirApiAdminCrmDisponivel, async ({ tx, tenant }) => {
    const acao = esquema.parse(await lerCorpo(request, 8_000));
    return acao.acao === "salvar"
      ? salvarLink(tx, tenant, { estabelecimentoId: acao.estabelecimentoId, url: acao.url })
      : removerLink(tx, tenant, { estabelecimentoId: acao.estabelecimentoId });
  });
}
