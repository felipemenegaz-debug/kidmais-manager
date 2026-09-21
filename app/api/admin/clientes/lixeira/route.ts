import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db/postgres';
import { consultarLixeira } from '@/lib/clientes/services/lixeira';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse,jsonNoStore } from '@/lib/http/api-response';
export async function GET(request:NextRequest) {
    try {
        await exigirApiAdminCrmDisponivel(request);
        const offset=z.coerce.number().int().min(0).parse(request.nextUrl.searchParams.get('offset')??0);
        return jsonNoStore({ok:true,data:await consultarLixeira(db(),undefined,offset)});
    } catch(error) { return apiErrorResponse(error); }
}
