import type { NextRequest } from 'next/server';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { lerJson } from '@/lib/acessos/http';
import { liberarIntencaoCobranca, pendenciasCobrancaEmpresa } from '@/lib/desenvolvedor/cobranca';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** Desenvolvedor: pendências de cobrança abertas da empresa (sem ids do provedor). */
export async function GET(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, (sessao) => pendenciasCobrancaEmpresa(sessao, id));
}

/** Desenvolvedor: libera uma intenção de criação comprovadamente não executada (senha recente, auditado). */
export async function POST(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, async (sessao, ctx) => liberarIntencaoCobranca(sessao, id, await lerJson(request), ctx));
}
