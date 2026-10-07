import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/postgres";
import { escopoCatalogoPublico } from "@/lib/comercial/catalogo-publico";
import { buscarPacoteVigenteDaEmpresaPorCodigo } from "@/lib/comercial/repositories";
import { pacoteCodigoContratavelV1 } from "@/lib/comercial/pacotes-v1";
import { PacoteAdminError } from "@/lib/comercial/pacotes-admin";
import { apiErrorResponse } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const escopo = await escopoCatalogoPublico(db);
    const codigo = request.nextUrl.searchParams.get("pacote") ?? "";
    if (!pacoteCodigoContratavelV1(codigo)) throw new PacoteAdminError("DADOS_INVALIDOS", "Pacote inválido.", 400);
    const pacote = await buscarPacoteVigenteDaEmpresaPorCodigo(escopo.empresaId, codigo, db());
    if (!pacote) throw new PacoteAdminError("NAO_ENCONTRADO", "Pacote indisponível.", 404);
    const resultado = await db().query<{ categoria_id: string; codigo: string; nome: string; escolhas_max: number; item_id: string; item_nome: string }>(`
      SELECT c.id AS categoria_id, c.codigo, c.nome, r.escolhas_max, i.id AS item_id, i.nome AS item_nome
      FROM pacote_buffet_categorias r
      JOIN buffet_categorias c ON c.id=r.categoria_id AND c.ativo
      JOIN buffet_itens i ON i.categoria_id=c.id AND i.ativo
      WHERE r.pacote_id=$1::uuid AND r.ativo AND
        (r.modo_itens='TODOS_ATIVOS' OR EXISTS
          (SELECT 1 FROM pacote_buffet_itens x WHERE x.pacote_id=r.pacote_id AND x.categoria_id=c.id AND x.item_id=i.id))
      ORDER BY c.ordem_exibicao, i.ordem_exibicao, i.nome`, [pacote.id]);
    const categorias = new Map<string, { codigo: string; nome: string; max: number; itens: { id: string; nome: string }[] }>();
    for (const row of resultado.rows) {
      const categoria = categorias.get(row.categoria_id) ?? { codigo: row.codigo, nome: row.nome, max: row.escolhas_max, itens: [] };
      categoria.itens.push({ id: row.item_id, nome: row.item_nome });
      categorias.set(row.categoria_id, categoria);
    }
    return NextResponse.json({ categorias: [...categorias.values()] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
