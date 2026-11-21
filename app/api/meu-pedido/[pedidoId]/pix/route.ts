import type { NextRequest } from 'next/server';
import { responderArea } from '@/lib/area-familia/http';
import { withTransaction } from '@/lib/db/postgres';
import { idDoPedido, lerSessaoDaRequisicao, rotaMeuPedido } from '@/lib/pre-reserva/http-familia';
import { pixMeuPedido } from '@/lib/pre-reserva/meu-pedido';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, rota: { params: Promise<{ pedidoId: string }> }) {
  return rotaMeuPedido(request, async (contexto) => {
    const sessao = lerSessaoDaRequisicao(request, contexto);
    const pedido = idDoPedido((await rota.params).pedidoId);
    const data = await withTransaction(tx => pixMeuPedido(tx, contexto.empresaId, sessao, pedido));
    return responderArea({ ok: true, data });
  });
}
