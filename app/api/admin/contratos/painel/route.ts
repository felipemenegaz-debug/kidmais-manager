import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { detalheAdministrativo } from '@/lib/contratos/services/administrativo.service';
import { contratoNoTenant, executarComPosseNoTenant, listarContratosDoTenant } from '@/lib/contratos/services/contrato-tenant';
import { apiErrorResponse } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
export async function GET(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const q = request.nextUrl.searchParams, empresaSolicitada = q.get('empresaId');
        const id = q.get('contratoId');
        if (id && !z.string().uuid().safeParse(id).success)
            return NextResponse.json({ ok: false, erro: 'Contrato inválido.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
        // Tenant Context (B2/D1): detalhe lido na MESMA transação da posse provada; lista já filtrada pela empresa no SQL.
        let data: unknown;
        if (id) {
            data = await executarComPosseNoTenant(sessao, empresaSolicitada, id, contratoNoTenant, { withTenantTransaction }, (tx) => detalheAdministrativo(id, tx));
        }
        else {
            data = await withTenantTransaction(sessao, empresaSolicitada, (tx, tenant) => listarContratosDoTenant(tx, tenant.empresaComprovada, q.get('incluirCancelados') === '1'));
        }
        return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (e) {
        return apiErrorResponse(e);
    }
}
