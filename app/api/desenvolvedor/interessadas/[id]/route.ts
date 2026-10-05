import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { lerJson } from '@/lib/acessos/http';
import { alterarStatusInteressada, atualizarInteressada, obterInteressada } from '@/lib/desenvolvedor/interessadas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, (sessao) => obterInteressada(sessao, id));
}

export async function PATCH(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, async (sessao, ctx) => atualizarInteressada(sessao, id, await lerJson(request), ctx));
}

const corpoSchema = z.object({ acao: z.literal('status'), dados: z.unknown() }).strict();

export async function POST(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, async (sessao, ctx) => {
        const corpo = corpoSchema.parse(await lerJson(request));
        return alterarStatusInteressada(sessao, id, corpo.dados, ctx);
    });
}
