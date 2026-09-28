import { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { jsonNoStore, apiErrorResponse } from '@/lib/http/api-response';
import { listarContratacoes } from '@/lib/fechamentos/contratacoes';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const raw = request.nextUrl.searchParams.get('clienteId');
        const clienteId = raw === null ? undefined : z.string().uuid().parse(raw).toLowerCase();
        const itens = await withTenantTransaction(sessao, request.nextUrl.searchParams.get('empresaId'),
            (tx, tenant) => listarContratacoes(tx, tenant.empresaComprovada, clienteId));
        return jsonNoStore({ ok: true, data: { itens, total: itens.length } });
    } catch (error) { return apiErrorResponse(error); }
}
