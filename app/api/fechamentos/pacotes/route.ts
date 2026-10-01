import { NextResponse } from "next/server";
import { catalogoPublicoIndeterminado } from "@/lib/comercial/autorizacao-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { erro: catalogoPublicoIndeterminado.erro, codigo: catalogoPublicoIndeterminado.codigo },
    { status: catalogoPublicoIndeterminado.httpStatus, headers: { "Cache-Control": "no-store" } },
  );
}
