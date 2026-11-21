import type { NextRequest } from 'next/server';
import { responderArea } from '@/lib/area-familia/http';
import { withTransaction } from '@/lib/db/postgres';
import { abrirSessaoDaRequisicao, rotaMeuPedido } from '@/lib/pre-reserva/http-familia';
import { listarMeuPedido } from '@/lib/pre-reserva/meu-pedido';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return rotaMeuPedido(request, async (contexto) => {
    const data = await withTransaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const sessao = abrirSessaoDaRequisicao(request, contexto);
      const pedidos = await listarMeuPedido(tx, contexto.empresaId, sessao, contexto.pepper);
      return { expiraEm: new Date(sessao.expiraEm), pedidos };
    });
    return responderArea({ ok: true, data });
  });
}
