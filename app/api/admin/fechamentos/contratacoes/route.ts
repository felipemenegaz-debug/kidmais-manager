import { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { jsonNoStore, apiErrorResponse } from '@/lib/http/api-response';
import { db } from '@/lib/db/postgres';
import { listarContratacoes } from '@/lib/fechamentos/contratacoes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        await exigirApiAdminCrmDisponivel(request);
        const raw = request.nextUrl.searchParams.get('clienteId');
        const clienteId = raw === null ? undefined : z.string().uuid().parse(raw).toLowerCase();
        const itens = await listarContratacoes(db(), clienteId);
        return jsonNoStore({ ok: true, data: { itens, total: itens.length } });
    } catch (error) { return apiErrorResponse(error); }
}
