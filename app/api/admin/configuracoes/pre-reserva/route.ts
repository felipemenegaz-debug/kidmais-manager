import type { NextRequest } from 'next/server';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
import { configuracaoPreReserva, salvarConfiguracaoPreReserva } from '@/lib/pre-reserva/configuracao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, null, configuracaoPreReserva);
    return jsonNoStore({ ok: true, data });
  } catch (erro) { return apiErrorResponse(erro); }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const entrada: unknown = await request.json();
    const data = await withTenantTransaction(sessao, null, (tx, tenant) => salvarConfiguracaoPreReserva(tx, tenant, sessao, entrada));
    return jsonNoStore({ ok: true, data });
  } catch (erro) { return apiErrorResponse(erro); }
}
