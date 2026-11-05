import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { conexoesDaPessoa } from "@/lib/integracoes/oauth/conexoes";
import { lerJsonLimitado } from "@/lib/integracoes/mcp/corpo";
import { CanalOcupado } from "@/lib/integracoes/mcp/admissao";
import { PrazoDaTransacaoVencido } from "@/lib/db/transacao-com-prazo";
import { SchemaMcpAusente } from "@/lib/integracoes/oauth/postgres";
import { repositorioDaPessoa } from "../../../mcp/dependencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const revogarSchema = z.object({ concessaoId: z.string().uuid() }).strict();

/** Corpo com teto e prazo (rodada 4, achado 5): nunca o leitor JSON do framework sem limite. */
const corpoRecusado = (status: number) => jsonNoStore({ ok: false, erro: "Pedido inválido.", codigo: "CORPO_INVALIDO" }, { status });

function falha(error: unknown) {
  if (error instanceof CanalOcupado || error instanceof PrazoDaTransacaoVencido) return jsonNoStore({ ok: false, erro: "Não foi possível concluir agora. Tente de novo em instantes.", codigo: "INDISPONIVEL" }, { status: 503 });
  if (error instanceof SchemaMcpAusente) return jsonNoStore({ ok: false, erro: "Conexões com assistentes ainda não estão disponíveis neste ambiente.", codigo: "INDISPONIVEL" }, { status: 503 });
  return apiErrorResponse(error);
}

/** Conexões da PRÓPRIA pessoa, SEMPRE listadas (mesmo com o canal desligado): estado persistido + estado do canal. */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    return jsonNoStore({ ok: true, data: await conexoesDaPessoa(process.env, repositorioDaPessoa(), sessao.usuario_id) });
  } catch (error) {
    return falha(error);
  }
}

/** Revogação pela própria pessoa. Sempre permitida (segurança), inclusive com a assinatura em somente leitura. */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const lido = await lerJsonLimitado(request, 4096, 5000);
    if (!lido.ok) return corpoRecusado(lido.status);
    const { concessaoId } = revogarSchema.parse(lido.valor);
    const ok = await repositorioDaPessoa().revogarConcessao(concessaoId, "USUARIO", sessao.usuario_id);
    if (!ok) return jsonNoStore({ ok: false, erro: "Conexão não encontrada ou já desconectada.", codigo: "NAO_ENCONTRADA" }, { status: 404 });
    return jsonNoStore({ ok: true, data: { revogada: true } });
  } catch (error) {
    return falha(error);
  }
}
