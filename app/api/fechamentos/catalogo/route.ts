import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/postgres';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const codigo = request.nextUrl.searchParams.get('pacote');
  if (!codigo || !/^[A-Z_]{2,50}$/.test(codigo))
    return NextResponse.json({ erro: 'Pacote inválido.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  try {
    const resultado = await db().query<{ categoria_id:string; categoria_codigo:string; categoria_nome:string; escolhas_max:number; item_id:string; item_nome:string }>(`
      SELECT c.id AS categoria_id,c.codigo AS categoria_codigo,c.nome AS categoria_nome,
        r.escolhas_max,i.id AS item_id,i.nome AS item_nome
      FROM pacotes p JOIN pacote_buffet_categorias r ON r.pacote_id=p.id AND r.ativo
      JOIN buffet_categorias c ON c.id=r.categoria_id AND c.ativo
      JOIN buffet_itens i ON i.categoria_id=c.id AND i.ativo
      WHERE p.codigo=$1 AND p.ativo AND
        (r.modo_itens='TODOS_ATIVOS' OR EXISTS
          (SELECT 1 FROM pacote_buffet_itens x WHERE x.pacote_id=p.id AND x.categoria_id=c.id AND x.item_id=i.id))
      ORDER BY c.ordem_exibicao,i.ordem_exibicao,i.nome`,[codigo]);
    return NextResponse.json({ categorias: Object.values(resultado.rows.reduce<Record<string,{codigo:string;nome:string;max:number;itens:{id:string;nome:string}[]}>>((acc,row)=>{
      const categoria=acc[row.categoria_id]??={codigo:row.categoria_codigo,nome:row.categoria_nome,max:row.escolhas_max,itens:[]};
      categoria.itens.push({id:row.item_id,nome:row.item_nome});acc[row.categoria_id]=categoria;return acc;
    },{})) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ categorias: [] }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
