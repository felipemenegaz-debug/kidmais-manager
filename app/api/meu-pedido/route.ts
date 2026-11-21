import type { NextRequest } from 'next/server';
import { responderArea } from '@/lib/area-familia/http';
import { withTransaction } from '@/lib/db/postgres';
import { lerSessaoDaRequisicao, rotaMeuPedido } from '@/lib/pre-reserva/http-familia';
import { listarMeuPedido } from '@/lib/pre-reserva/meu-pedido';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return rotaMeuPedido(request, async (contexto) => {
    const sessao = lerSessaoDaRequisicao(request, contexto);
    const pedidos = await withTransaction(tx => listarMeuPedido(tx, contexto.empresaId, sessao, contexto.pepper));
    return responderArea({ ok: true, data: { expiraEm: new Date(sessao.expiraEm), pedidos } });
  });
}
