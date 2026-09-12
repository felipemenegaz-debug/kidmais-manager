import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { contextoCrmDaRequest, exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { isClienteServiceError } from "@/lib/clientes/services";
import { isFechamentoServiceError } from "@/lib/fechamentos/services/errors";
import { obterRevisaoComercial, revisarComercial } from "@/lib/fechamentos/services/revisao-comercial.service";
import { CondicaoPagamentoError } from "@/lib/comercial/condicao-pagamento";
import { pretensaoPixSchema, valorComercialSchema } from "@/lib/http/condicao-pagamento-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ fechamentoId: string }> };
const schema = z.object({
  solicitacaoId: z.string().uuid(), decisao: z.enum(["APROVAR", "RECUSAR"]),
  valorBaseAprovado: valorComercialSchema.optional(),
  condicaoAprovada: pretensaoPixSchema.nullable().optional(),
  motivo: z.string().trim().min(1).max(1000),
}).strict();
function resposta(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
function erro(error: unknown) {
  if (isClienteServiceError(error) || isFechamentoServiceError(error)) {
    return resposta({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus);
  }
  if (error instanceof CondicaoPagamentoError || error instanceof z.ZodError || error instanceof SyntaxError) {
    return resposta({ ok: false, erro: "Dados da revisão inválidos. Confira os valores e a precisão de centavos.", codigo: "DADOS_INVALIDOS" }, 400);
  }
  console.error("[Revisão comercial]", error);
  return resposta({ ok: false, erro: "Não foi possível processar a revisão." }, 500);
}
export async function GET(request: NextRequest, context: Context) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await context.params).fechamentoId);
    return resposta({ ok: true, data: await obterRevisaoComercial(id) });
  } catch (error) { return erro(error); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await context.params).fechamentoId);
    const input = schema.parse(await request.json());
    const data = await revisarComercial(id, input, contextoCrmDaRequest(request));
    return resposta({ ok: true, data }, data.reutilizada ? 200 : 201);
  } catch (error) { return erro(error); }
}
