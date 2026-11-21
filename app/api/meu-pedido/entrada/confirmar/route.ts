import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { responderArea } from '@/lib/area-familia/http';
import { db } from '@/lib/db/postgres';
import { confirmarEntradaMeuPedido, cookieMeuPedido } from '@/lib/pre-reserva/acesso-pedido';
import { corpoMeuPedido, rotaMeuPedido } from '@/lib/pre-reserva/http-familia';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const entrada = z.object({
  desafio: z.string().min(1).max(320),
  codigo: z.string().trim().regex(/^\d{6}$/),
}).strict();

export async function POST(request: NextRequest) {
  return rotaMeuPedido(request, async ({ empresaId, pepper }) => {
    const { desafio, codigo } = await corpoMeuPedido(request, entrada);
    const token = await confirmarEntradaMeuPedido(db(), empresaId, desafio, codigo, pepper);
    if (!token) return responderArea({ ok: false, codigo: 'CODIGO_NAO_CONFIRMADO', erro: 'Código inválido ou expirado. Confira o código ou inicie uma nova entrada.' }, 401);
    const resposta = responderArea({ ok: true });
    resposta.cookies.set(cookieMeuPedido(empresaId, token));
    return resposta;
  }, 'CONFIRMAR_IDENTIDADE');
}
