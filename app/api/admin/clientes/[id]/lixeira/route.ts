import { NextRequest } from 'next/server';
import { z } from 'zod';
import { consultarLixeira,moverClienteLixeira } from '@/lib/clientes/services/lixeira';
import { contextoCrmDaRequest,exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse,jsonNoStore } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
type Context={params:Promise<{id:string}>};
export async function GET(request:NextRequest,context:Context) {
    try {
        const sessao=await exigirApiAdminCrmDisponivel(request);
        const id=z.string().uuid().parse((await context.params).id);
        const data=await withTenantTransaction(sessao,request.nextUrl.searchParams.get('empresaId'),
            async(tx,tenant)=>(await consultarLixeira(tx,tenant.empresaComprovada,id))[0]);
        return data?jsonNoStore({ok:true,data}):jsonNoStore({ok:false,erro:'Cliente não encontrado.'},{status:404});
    } catch(error) { return apiErrorResponse(error); }
}
export async function POST(request:NextRequest,context:Context) {
    try {
        const sessao=await exigirApiAdminCrmDisponivel(request);
        const id=z.string().uuid().parse((await context.params).id),body=await request.json();
        // `?empresaId=` só escolhe entre memberships ativas do próprio usuário; o corpo é da ação.
        const data=await withTenantTransaction(sessao,request.nextUrl.searchParams.get('empresaId'),
            (tx,tenant)=>moverClienteLixeira(tx,tenant.empresaComprovada,id,body,contextoCrmDaRequest(request)));
        return jsonNoStore({ok:true,data});
    } catch(error) { return apiErrorResponse(error); }
}
