import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/postgres";
import { escopoCatalogoPublico } from "@/lib/comercial/catalogo-publico";
import { adicionaisDoPacoteNoTenant } from "@/lib/comercial/adicionais-tenant";
import { ADICIONAL_CODIGO_BANCO, PACOTE_CODIGO_BANCO } from "@/lib/fechamentos/comercial-input";
import { apiErrorResponse } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idPorCodigo = Object.entries(ADICIONAL_CODIGO_BANCO).reduce<Record<string, string>>((acc, [id, codigo]) => {
  acc[codigo] ??= id;
  return acc;
}, {});

export async function GET(request: NextRequest) {
  try {
    const escopo = await escopoCatalogoPublico(db);
    const parametros = request.nextUrl.searchParams;
    const pacoteCodigo = PACOTE_CODIGO_BANCO[(parametros.get("pacote") ?? "") as keyof typeof PACOTE_CODIGO_BANCO];
    if (!pacoteCodigo) return NextResponse.json({ erro: "Informe um pacote válido.", codigo: "DADOS_INVALIDOS" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const adicionais = await adicionaisDoPacoteNoTenant(db(), {
      empresaId: escopo.empresaId, pacoteCodigo,
      data: parametros.get("data") ?? "", convidados: Number(parametros.get("convidados")),
    });
    return NextResponse.json({ adicionais: adicionais.filter(a => idPorCodigo[a.codigo]).map(a => ({ id: idPorCodigo[a.codigo], ...a })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
