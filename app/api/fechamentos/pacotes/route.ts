import { NextResponse } from "next/server";
import { db } from "@/lib/db/postgres";
import { escopoCatalogoPublico } from "@/lib/comercial/catalogo-publico";
import { buscarPacoteVigenteDaEmpresaPorCodigo } from "@/lib/comercial/repositories";
import { PACOTES_CONTRATAVEIS_V1 } from "@/lib/comercial/pacotes-v1";
import { apiErrorResponse } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const escopo = await escopoCatalogoPublico(db);
    const pacotes = [];
    for (const { codigo } of PACOTES_CONTRATAVEIS_V1) {
      const pacote = await buscarPacoteVigenteDaEmpresaPorCodigo(escopo.empresaId, codigo, db());
      if (pacote) pacotes.push({
        codigo: pacote.codigo, nome: pacote.nome, descricao: pacote.descricao,
        duracaoMinutos: pacote.duracaoMinutos, convidadosMinimos: pacote.convidadosMinimos,
        convidadosMaximos: pacote.convidadosMaximos,
        // A cotação depende da data e dos convidados; não publicar preço de outra vigência.
        precoMinimo: null,
      });
    }
    return NextResponse.json({ pacotes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
