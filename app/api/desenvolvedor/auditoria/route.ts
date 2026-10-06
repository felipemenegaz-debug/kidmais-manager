import type { NextRequest } from 'next/server';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { consultarAuditoria } from '@/lib/desenvolvedor/auditoria-consulta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Auditoria administrativa por empresa, ação e período, paginada. Só metadados sanitizados; nada operacional. */
export async function GET(request: NextRequest) {
    const p = request.nextUrl.searchParams;
    return rotaDesenvolvedor(request, (sessao) => consultarAuditoria(sessao, {
        empresaId: p.get('empresaId') || undefined, acao: p.get('acao') || undefined, de: p.get('de') || undefined, ate: p.get('ate') || undefined, pagina: p.get('pagina') ?? undefined,
    }));
}
