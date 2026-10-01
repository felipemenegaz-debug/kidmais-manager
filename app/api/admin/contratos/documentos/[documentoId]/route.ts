import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { lerDocumento } from '@/lib/contratos/storage/postgres';
import { lerDocumentoDoTenant } from '@/lib/contratos/services/exportacao-tenant';
import { ResumoTenantError } from '@/lib/contratos/services/resumo-tenant';
import { apiErrorResponse } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
export async function GET(request: NextRequest, context: {
    params: Promise<{
        documentoId: string;
    }>;
}) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const id = z.string().uuid().parse((await context.params).documentoId);
        // Tenant Context: posse (documento → versão → contrato → fechamento → pacote da empresa) e leitura na mesma transação.
        const d = await lerDocumentoDoTenant(sessao, request.nextUrl.searchParams.get('empresaId'), id, { withTenantTransaction, ler: lerDocumento });
        const disposicao = request.nextUrl.searchParams.get('baixar') === '1' ? 'attachment' : 'inline';
        return new NextResponse(new Uint8Array(d.conteudo_pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `${disposicao}; filename="contrato-${d.contrato_versao_id}-${d.id}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    catch (e) {
        if (e instanceof ResumoTenantError)
            return NextResponse.json({ ok: false, erro: 'Documento não encontrado.', codigo: e.code }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
        return apiErrorResponse(e);
    }
}
