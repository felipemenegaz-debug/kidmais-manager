import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/postgres";
import { codigoEmpresaDoPedido, escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import { buscarPacoteVigenteDaEmpresaPorCodigo } from "@/lib/comercial/repositories";
import { codigoDoPacoteDaTela, pacoteCodigoContratavelV1 } from "@/lib/comercial/pacotes-v1";
import { PacoteAdminError } from "@/lib/comercial/pacotes-admin";
import { apiErrorResponse } from "@/lib/http/api-response";
import { limitarPublico } from "@/lib/http/limite-publico";
import { catalogoBuffetPorEmpresa } from "@/lib/comercial/catalogo-buffet-estrutura";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limite = limitarPublico(request, "LEITURA");
  if (limite) return limite;
  try {
    const escopo = await escopoCotacaoPublica(db, codigoEmpresaDoPedido(request.nextUrl));
    const pedido = request.nextUrl.searchParams.get("pacote") ?? "";
    // Endereço atual: os sete códigos, como antes; /b/<código>: id V1 ou código de pacote (a busca abaixo prova a empresa).
    const codigo = escopo.porCodigo ? codigoDoPacoteDaTela(pedido, true) : (pacoteCodigoContratavelV1(pedido) ? pedido : null);
    if (!codigo) throw new PacoteAdminError("DADOS_INVALIDOS", "Pacote inválido.", 400);
    const pacote = await buscarPacoteVigenteDaEmpresaPorCodigo(escopo.empresaId, codigo, db());
    if (!pacote) throw new PacoteAdminError("NAO_ENCONTRADO", "Pacote indisponível.", 404);
    // Escopo pelo pacote da empresa do endereço; com a 078, também pelo catálogo dela (segunda barreira, além do gatilho).
    const porEmpresa = await catalogoBuffetPorEmpresa(db());
    const resultado = await db().query<{ categoria_id: string; codigo: string; nome: string; escolhas_max: number; item_id: string; item_nome: string }>(`
      SELECT c.id AS categoria_id, c.codigo, c.nome, r.escolhas_max, i.id AS item_id, i.nome AS item_nome
      FROM pacote_buffet_categorias r
      JOIN buffet_categorias c ON c.id=r.categoria_id AND c.ativo
      JOIN buffet_itens i ON i.categoria_id=c.id AND i.ativo
      WHERE r.pacote_id=$1::uuid AND r.ativo AND
        (r.modo_itens='TODOS_ATIVOS' OR EXISTS
          (SELECT 1 FROM pacote_buffet_itens x WHERE x.pacote_id=r.pacote_id AND x.categoria_id=c.id AND x.item_id=i.id))
        ${porEmpresa ? "AND c.empresa_id=$2::uuid AND i.empresa_id=$2::uuid" : ""}
      ORDER BY c.ordem_exibicao, i.ordem_exibicao, i.nome`, porEmpresa ? [pacote.id, escopo.empresaId] : [pacote.id]);
    const categorias = new Map<string, { codigo: string; nome: string; max: number; itens: { id: string; nome: string }[] }>();
    for (const row of resultado.rows) {
      const categoria = categorias.get(row.categoria_id) ?? { codigo: row.codigo, nome: row.nome, max: row.escolhas_max, itens: [] };
      categoria.itens.push({ id: row.item_id, nome: row.item_nome });
      categorias.set(row.categoria_id, categoria);
    }
    return NextResponse.json({ categorias: [...categorias.values()] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
