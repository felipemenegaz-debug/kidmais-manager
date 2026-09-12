import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { exigirApiAdminCrmDisponivel, tokenAdmin } from '@/lib/http/admin-crm-api';
import { acaoContratoSchema, operarContrato } from '@/lib/contratos/services/administrativo.service';
import { apiErrorResponse } from '@/lib/http/api-response';
export async function POST(request: NextRequest, context: {
    params: Promise<{
        versaoId: string;
    }>;
}) {
    try {
        await exigirApiAdminCrmDisponivel(request);
        const id = z.string().uuid().parse((await context.params).versaoId), parsed = acaoContratoSchema.safeParse(await request.json());
        if (!parsed.success)
            return NextResponse.json({ ok: false, erro: 'Dados inválidos ou campos não permitidos para esta ação.', detalhes: parsed.error.flatten() }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
        const data = await operarContrato(id, parsed.data, tokenAdmin(request), { requestId: randomUUID(), ip: null, userAgent: request.headers.get('user-agent')?.slice(0, 1000) ?? null });
        return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (e) {
        return apiErrorResponse(e);
    }
}
