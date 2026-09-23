import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db/postgres';
import { authError } from '@/lib/autenticacao/service';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse } from '@/lib/http/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const uuid = z.uuid();
const nome = z.string().trim().min(1).max(160);
const operacao = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('categoria'), id: uuid, nome, ativo: z.boolean() }),
  z.object({ acao: z.literal('item'), id: uuid, nome, ativo: z.boolean() }),
  z.object({ acao: z.literal('novo_item'), categoriaId: uuid, nome }),
  z.object({ acao: z.literal('adicional'), id: uuid, nome, ativo: z.boolean() }),
]);

export async function GET(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const [categorias, itens, adicionais, pacotes] = await Promise.all([
      db().query('SELECT id,codigo,nome,ativo FROM buffet_categorias ORDER BY ordem_exibicao,nome'),
      db().query('SELECT id,categoria_id,nome,ativo FROM buffet_itens ORDER BY ordem_exibicao,nome'),
      db().query('SELECT id,codigo,nome,categoria,ativo FROM adicionais ORDER BY categoria,ordem_exibicao,nome'),
      db().query('SELECT id,codigo,nome FROM pacotes WHERE ativo ORDER BY ordem_exibicao'),
    ]);
    return NextResponse.json({ ok: true, data: { categorias: categorias.rows, itens: itens.rows, adicionais: adicionais.rows, pacotes: pacotes.rows } }, { headers });
  } catch (error) { return apiErrorResponse(error); }
}

export async function PATCH(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (sessao.papel !== 'REPRESENTANTE_AUTORIZADO') throw authError('Apenas o proprietário pode editar o catálogo.', 403);
    const data = operacao.parse(await request.json());
    let resultado;
    if (data.acao === 'categoria') resultado = await db().query('UPDATE buffet_categorias SET nome=$2,ativo=$3,arquivado_em=CASE WHEN $3 THEN NULL ELSE clock_timestamp() END WHERE id=$1 RETURNING id', [data.id, data.nome, data.ativo]);
    else if (data.acao === 'item') resultado = await db().query('UPDATE buffet_itens SET nome=$2,ativo=$3,arquivado_em=CASE WHEN $3 THEN NULL ELSE clock_timestamp() END WHERE id=$1 RETURNING id', [data.id, data.nome, data.ativo]);
    else if (data.acao === 'adicional') resultado = await db().query('UPDATE adicionais SET nome=$2,ativo=$3 WHERE id=$1 RETURNING id', [data.id, data.nome, data.ativo]);
    else {
      const codigo = `CUSTOM_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
      resultado = await db().query(`INSERT INTO buffet_itens (categoria_id,codigo,nome,ordem_exibicao)
        SELECT id,$2,$3,COALESCE((SELECT MAX(ordem_exibicao)+1 FROM buffet_itens WHERE categoria_id=$1),1)
        FROM buffet_categorias WHERE id=$1 AND ativo RETURNING id`, [data.categoriaId, codigo, data.nome]);
    }
    if (!resultado.rowCount) return NextResponse.json({ ok: false, erro: 'Registro indisponível.' }, { status: 404, headers });
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) { return apiErrorResponse(error); }
}
