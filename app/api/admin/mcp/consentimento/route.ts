import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { lerJsonLimitado } from "@/lib/integracoes/mcp/corpo";
import { CanalOcupado } from "@/lib/integracoes/mcp/admissao";
import { PrazoDaTransacaoVencido } from "@/lib/db/transacao-com-prazo";
import { SchemaMcpAusente } from "@/lib/integracoes/oauth/postgres";
import { ErroOAuth, concluirConsentimento, lerPedidoParaConsentimento } from "@/lib/integracoes/oauth/servico";
import { dependenciasConsentimento } from "../../../mcp/dependencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  pedido: z.string().max(80),
  escopos: z.array(z.string().max(40)).max(3),
  decisao: z.enum(["PERMITIR", "NEGAR"]),
}).strict();

/** Corpo com teto e prazo (rodada 4, achado 5): nunca o leitor JSON do framework sem limite. */
const corpoRecusado = (status: number) => jsonNoStore({ ok: false, erro: "Pedido inválido.", codigo: "CORPO_INVALIDO" }, { status });

function falha(error: unknown) {
  if (error instanceof ErroOAuth) return jsonNoStore({ ok: false, erro: error.message, codigo: error.codigo }, { status: error.status });
  if (error instanceof CanalOcupado || error instanceof PrazoDaTransacaoVencido) return jsonNoStore({ ok: false, erro: "Não foi possível concluir agora. Tente de novo em instantes.", codigo: "INDISPONIVEL" }, { status: 503 });
  if (error instanceof SchemaMcpAusente) return jsonNoStore({ ok: false, erro: "Conexão com assistentes externos indisponível.", codigo: "INDISPONIVEL" }, { status: 503 });
  return apiErrorResponse(error);
}

/** Dados do pedido pendente para a tela (aplicativo, endereço de retorno, permissões pedidas, prazo). Exige sessão. */
export async function GET(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const dados = await lerPedidoParaConsentimento(request.nextUrl.searchParams.get("pedido") ?? "", dependenciasConsentimento());
    if (!dados) return jsonNoStore({ ok: false, erro: "Pedido de conexão inválido ou expirado. Volte ao aplicativo e conecte novamente.", codigo: "PEDIDO_INVALIDO" }, { status: 404 });
    return jsonNoStore({ ok: true, data: dados });
  } catch (error) {
    return falha(error);
  }
}

/**
 * Decisão humana na sessão autenticada (origem + CSRF + paywall do guard administrativo). A empresa é a do parâmetro
 * `empresaId` provada por provarTenant (a mesma regra das demais rotas); nunca vem do aplicativo externo.
 */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const empresaId = request.nextUrl.searchParams.get("empresaId") ?? sessao.empresa_ativa_id ?? "";
    const lido = await lerJsonLimitado(request, 4096, 5000);
    if (!lido.ok) return corpoRecusado(lido.status);
    const corpo = corpoSchema.parse(lido.valor);
    const r = await concluirConsentimento({ ...corpo, empresaId }, sessao, dependenciasConsentimento());
    return jsonNoStore({ ok: true, data: { destino: r.destino } });
  } catch (error) {
    return falha(error);
  }
}
