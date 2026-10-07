import type { NextRequest } from 'next/server';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { sincronizarCobrancaEmpresa } from '@/lib/desenvolvedor/cobranca';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** Desenvolvedor: reconsulta a assinatura da empresa no provedor e aplica o estado atual (auditado). */
export async function POST(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, (sessao, ctx) => sincronizarCobrancaEmpresa(sessao, id, ctx));
}
