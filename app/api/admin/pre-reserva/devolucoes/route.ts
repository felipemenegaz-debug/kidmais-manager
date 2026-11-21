import type { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { filaDevolucao } from '@/lib/pre-reserva/devolucao';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const historico = request.nextUrl.searchParams.get('historico') === '1';
    const data = await withTenantTransaction(sessao, null, (tx, tenant) => filaDevolucao(tx, tenant, historico));
    return jsonNoStore({ ok: true, data });
  } catch (erro) {
    return apiErrorResponse(erro);
  }
}
