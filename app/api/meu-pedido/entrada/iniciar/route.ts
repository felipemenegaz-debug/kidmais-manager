import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { responderArea } from '@/lib/area-familia/http';
import { db } from '@/lib/db/postgres';
import { cpfEntradaPedido, iniciarEntradaMeuPedido } from '@/lib/pre-reserva/acesso-pedido';
import { corpoMeuPedido, rotaMeuPedido } from '@/lib/pre-reserva/http-familia';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const entrada = z.object({
  cpf: z.string().max(32).refine(cpfEntradaPedido),
  canal: z.enum(['WHATSAPP', 'EMAIL']).default('WHATSAPP'),
}).strict();

export async function POST(request: NextRequest) {
  return rotaMeuPedido(request, async ({ empresaId, pepper }) => {
    const { cpf, canal } = await corpoMeuPedido(request, entrada);
    const data = await iniciarEntradaMeuPedido(db(), empresaId, cpf, canal, pepper);
    return responderArea({ ok: true, data }, 202);
  }, 'IDENTIDADE');
}
