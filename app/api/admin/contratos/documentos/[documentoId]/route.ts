import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { lerDocumento } from '@/lib/contratos/storage/postgres';
import { apiErrorResponse } from '@/lib/http/api-response';
export async function GET(request: NextRequest, context: {
    params: Promise<{
        documentoId: string;
    }>;
}) {
    try {
        await exigirApiAdminCrmDisponivel(request);
        const id = z.string().uuid().parse((await context.params).documentoId);
        const d = await lerDocumento(id);
        return new NextResponse(new Uint8Array(d.conteudo_pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="contrato-${d.contrato_versao_id}-${d.id}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    catch (e) {
        return apiErrorResponse(e);
    }
}
