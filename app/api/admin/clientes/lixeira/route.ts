import { NextRequest } from 'next/server';
import { z } from 'zod';
import { consultarLixeira } from '@/lib/clientes/services/lixeira';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse,jsonNoStore } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
export async function GET(request:NextRequest) {
    try {
        const sessao=await exigirApiAdminCrmDisponivel(request);
        const offset=z.coerce.number().int().min(0).parse(request.nextUrl.searchParams.get('offset')??0);
        const data=await withTenantTransaction(sessao,request.nextUrl.searchParams.get('empresaId'),
            (tx,tenant)=>consultarLixeira(tx,tenant.empresaComprovada,undefined,offset));
        return jsonNoStore({ok:true,data});
    } catch(error) { return apiErrorResponse(error); }
}
