import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withTransaction } from "@/lib/db/postgres";
import { aplicarRetorno } from "@/lib/marketing/automacoes/motor";
import { assinaturaConfere } from "@/lib/marketing/automacoes/transporte";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corpo = z.object({ provedorMensagemId: z.string().regex(/^sim_[0-9a-f-]{36}$/), status: z.enum(["ENTREGUE", "FALHOU"]), detalhe: z.string().max(200).nullable().optional() }).strict();
const responder = (dados: unknown, status = 200) => NextResponse.json(dados, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

/**
 * Retorno de status do provedor SIMULADO (entregue/falhou). Só aceita corpo assinado com HMAC-SHA256
 * (x-kidmais-assinatura) usando MARKETING_SIMULADO_CALLBACK_SECRET. Sem segredo configurado: indisponível.
 * Repetido ou fora de ordem: ignorado (estado final não volta).
 */
export async function POST(request: NextRequest) {
  const segredo = process.env.MARKETING_SIMULADO_CALLBACK_SECRET;
  if (!segredo) return responder({ ok: false, codigo: "INDISPONIVEL" }, 503);
  const texto = await request.text();
  if (texto.length > 4000 || !assinaturaConfere(segredo, texto, request.headers.get("x-kidmais-assinatura"))) return responder({ ok: false, codigo: "ASSINATURA_INVALIDA" }, 401);
  const parsed = corpo.safeParse((() => { try { return JSON.parse(texto); } catch { return null; } })());
  if (!parsed.success) return responder({ ok: false, codigo: "DADOS_INVALIDOS" }, 400);
  const resultado = await withTransaction((tx) => aplicarRetorno(tx, parsed.data.provedorMensagemId, parsed.data.status, parsed.data.detalhe ?? null));
  return responder({ ok: true, data: { resultado } });
}
