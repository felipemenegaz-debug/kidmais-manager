import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
import { confirmarSinal } from '@/lib/pre-reserva/confirmacao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ fechamentoId:string }> }) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await context.params).fechamentoId);
    const dados: unknown = await request.json();
    const data = await withTenantTransaction(sessao,null,(tx,tenant)=>confirmarSinal(tx,tenant,id,dados));
    return jsonNoStore({ok:true,data});
  } catch (erro) { return apiErrorResponse(erro); }
}
