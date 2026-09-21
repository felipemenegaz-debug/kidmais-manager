import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel, tokenAdmin } from '@/lib/http/admin-crm-api';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { criarFechamentoAdministrativo, exigirPapelFechamento, obterContextoFechamentoAdministrativo } from '@/lib/fechamentos/services/fechamento-administrativo.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
async function autorizar(request: NextRequest, context: Context) {
    // Autorizar antes de ler cliente ou body. O helper verifica origem e CSRF nas escritas.
    exigirPapelFechamento(await exigirApiAdminCrmDisponivel(request));
    return { id: z.string().uuid().parse((await context.params).id).toLowerCase(),
        credencial: { token: tokenAdmin(request), requestId: randomUUID(), userAgent: request.headers.get('user-agent')?.slice(0, 1000) ?? null } };
}
export async function GET(request: NextRequest, context: Context) {
    try {
        const { id, credencial } = await autorizar(request, context);
        return jsonNoStore({ ok: true, data: await obterContextoFechamentoAdministrativo(id, credencial) });
    } catch (error) { return apiErrorResponse(error); }
}
export async function POST(request: NextRequest, context: Context) {
    try {
        const { id, credencial } = await autorizar(request, context);
        const data = await criarFechamentoAdministrativo(id, await request.json(), credencial);
        return jsonNoStore({ ok: true, data }, { status: 201 });
    } catch (error) { return apiErrorResponse(error); }
}
