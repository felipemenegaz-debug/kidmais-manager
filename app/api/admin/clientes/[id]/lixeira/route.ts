import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db,withTransaction } from '@/lib/db/postgres';
import { consultarLixeira,moverClienteLixeira } from '@/lib/clientes/services/lixeira';
import { contextoCrmDaRequest,exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse,jsonNoStore } from '@/lib/http/api-response';
type Context={params:Promise<{id:string}>};
export async function GET(request:NextRequest,context:Context) {
    try {
        await exigirApiAdminCrmDisponivel(request);
        const id=z.string().uuid().parse((await context.params).id);
        const data=(await consultarLixeira(db(),id))[0];
        return data?jsonNoStore({ok:true,data}):jsonNoStore({ok:false,erro:'Cliente não encontrado.'},{status:404});
    } catch(error) { return apiErrorResponse(error); }
}
export async function POST(request:NextRequest,context:Context) {
    try {
        await exigirApiAdminCrmDisponivel(request);
        const id=z.string().uuid().parse((await context.params).id),body=await request.json();
        const data=await withTransaction(tx=>moverClienteLixeira(tx,id,body,contextoCrmDaRequest(request)));
        return jsonNoStore({ok:true,data});
    } catch(error) { return apiErrorResponse(error); }
}
