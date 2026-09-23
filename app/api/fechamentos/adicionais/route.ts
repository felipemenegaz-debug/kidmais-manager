import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/postgres';
import { ADICIONAL_CODIGO_BANCO, PACOTE_CODIGO_BANCO } from '@/lib/fechamentos/comercial-input';
import { erroConvidadosPizzaParty } from '@/lib/comercial/pacotes-v1';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };
const ids = Object.entries(ADICIONAL_CODIGO_BANCO).reduce<Record<string,string>>((acc,[id,codigo])=>{
  acc[codigo] ??= id;
  return acc;
},{});

export async function GET(request: NextRequest) {
  const pacote = request.nextUrl.searchParams.get('pacote') ?? '';
  const codigo = PACOTE_CODIGO_BANCO[pacote as keyof typeof PACOTE_CODIGO_BANCO];
  const data = request.nextUrl.searchParams.get('data') ?? '';
  const convidados = Number(request.nextUrl.searchParams.get('convidados'));
  if (!codigo || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isInteger(convidados) || convidados < 1 || convidados > 150)
    return NextResponse.json({ erro: 'Informe pacote, data e convidados válidos.' }, { status: 400, headers: noStore });
  const erroPizza = erroConvidadosPizzaParty(codigo, convidados);
  if (erroPizza) return NextResponse.json({ erro: erroPizza }, { status: 400, headers: noStore });
  try {
    const resultado = await db().query<{codigo:string;nome:string;categoria:string;unidade_cobranca:string;valor:string}>(`
      SELECT a.codigo,a.nome,a.categoria,a.unidade_cobranca,preco.valor::text AS valor
      FROM pacotes p JOIN pacote_adicionais pa ON pa.pacote_id=p.id AND pa.ativo AND pa.modalidade='EXTRA'
      JOIN adicionais a ON a.id=pa.adicional_id AND a.ativo
      JOIN tabelas_preco t ON t.id=(SELECT id FROM tabelas_preco
        WHERE ativa AND vigencia_inicio<=$2::date
          AND (vigencia_fim IS NULL OR vigencia_fim >= $2::date)
        ORDER BY vigencia_inicio DESC,criado_em DESC LIMIT 1)
      JOIN LATERAL (SELECT valor FROM precos_adicional x
        WHERE x.tabela_preco_id=t.id AND x.adicional_id=a.id AND x.ativo
          AND x.convidados_min<=$3::smallint AND (x.convidados_max IS NULL OR x.convidados_max >= $3::smallint)
        ORDER BY x.convidados_min DESC LIMIT 1) preco ON true
      WHERE p.codigo=$1 AND p.ativo ORDER BY a.categoria,a.ordem_exibicao`,[codigo,data,convidados]);
    return NextResponse.json({ adicionais: resultado.rows.filter(row=>ids[row.codigo]).map(row=>({
      id:ids[row.codigo],nome:row.nome,categoria:row.categoria,preco:Number(row.valor),codigo:row.codigo,unidadeCobranca:row.unidade_cobranca,
    })) }, { headers:noStore });
  } catch { return NextResponse.json({ erro: 'Adicionais indisponíveis no momento.' }, { status:503, headers:noStore }); }
}
