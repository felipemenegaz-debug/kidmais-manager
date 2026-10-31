import type { NextRequest } from "next/server";
import { z } from "zod";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { lerCorpo } from "@/lib/marketing/http";
import { rotaSatisfacaoAdmin } from "@/lib/satisfacao/admin-http";
import { SatisfacaoError } from "@/lib/satisfacao/erros";
import { concluirTarefa } from "@/lib/satisfacao/tarefas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
const esquema = z.object({ observacao: z.string().max(4000).nullable().optional() }).strict();

/** Conclusão da tarefa de retorno (A'): a rota nunca passa instante; o serviço decide depois das travas. */
export async function POST(request: NextRequest, context: RouteContext) {
  return rotaSatisfacaoAdmin(request, exigirApiAdminCrmDisponivel, async ({ tx, tenant }) => {
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) throw new SatisfacaoError("NAO_ENCONTRADO", "Tarefa não encontrada.", 404);
    const corpo = esquema.parse(await lerCorpo(request, 8_000));
    return concluirTarefa(tx, tenant, { tarefaId: id.data, observacao: corpo.observacao ?? null });
  });
}
