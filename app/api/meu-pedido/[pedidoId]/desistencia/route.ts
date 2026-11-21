import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { responderArea } from '@/lib/area-familia/http';
import { withTransaction } from '@/lib/db/postgres';
import { abrirSessaoDaRequisicao, corpoMeuPedido, idDoPedido, rotaMeuPedido } from '@/lib/pre-reserva/http-familia';
import { desistirMeuPedido } from '@/lib/pre-reserva/meu-pedido';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const entrada = z.object({ confirmarLiberacao: z.boolean() }).strict();

export async function POST(request: NextRequest, rota: { params: Promise<{ pedidoId: string }> }) {
  return rotaMeuPedido(request, async (contexto) => {
    const pedido = idDoPedido((await rota.params).pedidoId);
    const { confirmarLiberacao } = await corpoMeuPedido(request, entrada);
    if (!confirmarLiberacao)
      return responderArea({ ok: false, codigo: 'CONFIRMACAO_NECESSARIA', erro: 'Confirme que entendeu que o horário será liberado.' }, 400);
    const data = await withTransaction(tx =>
      desistirMeuPedido(tx, contexto.empresaId, abrirSessaoDaRequisicao(request, contexto), pedido, contexto.pepper));
    return responderArea({ ok: true, data });
  });
}
