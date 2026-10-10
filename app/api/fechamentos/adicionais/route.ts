import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/postgres";
import { codigoEmpresaDoPedido, escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import { adicionaisDoPacoteNoTenant } from "@/lib/comercial/adicionais-tenant";
import { PACOTE_CODIGO_BANCO, idDoAdicionalNaTela } from "@/lib/fechamentos/comercial-input";
import { apiErrorResponse } from "@/lib/http/api-response";
import { limitarPublico } from "@/lib/http/limite-publico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limite = limitarPublico(request, "LEITURA");
  if (limite) return limite;
  try {
    const escopo = await escopoCotacaoPublica(db, codigoEmpresaDoPedido(request.nextUrl));
    const parametros = request.nextUrl.searchParams;
    const pacoteCodigo = PACOTE_CODIGO_BANCO[(parametros.get("pacote") ?? "") as keyof typeof PACOTE_CODIGO_BANCO];
    if (!pacoteCodigo) return NextResponse.json({ erro: "Informe um pacote válido.", codigo: "DADOS_INVALIDOS" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const adicionais = await adicionaisDoPacoteNoTenant(db(), {
      empresaId: escopo.empresaId, pacoteCodigo,
      data: parametros.get("data") ?? "", convidados: Number(parametros.get("convidados")),
    });
    return NextResponse.json({ adicionais: adicionais.map(a => ({ id: idDoAdicionalNaTela(a.codigo), ...a })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
