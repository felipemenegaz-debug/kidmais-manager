import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { responderArea } from '@/lib/area-familia/http';
import { withTransaction } from '@/lib/db/postgres';
import { corpoMeuPedido, idDoPedido, lerSessaoDaRequisicao, rotaMeuPedido } from '@/lib/pre-reserva/http-familia';
import { aceitarOfertaMeuPedido } from '@/lib/pre-reserva/meu-pedido';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const entrada = z.object({
  termosVersao: z.string().min(1).max(80),
  versaoOferta: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export async function POST(request: NextRequest, rota: { params: Promise<{ pedidoId: string }> }) {
  return rotaMeuPedido(request, async (contexto) => {
    const sessao = lerSessaoDaRequisicao(request, contexto);
    const pedido = idDoPedido((await rota.params).pedidoId);
    const dados = await corpoMeuPedido(request, entrada);
    const data = await withTransaction(tx => aceitarOfertaMeuPedido(tx, contexto.empresaId, sessao, pedido, dados, contexto.pepper));
    return responderArea({ ok: true, data });
  });
}
