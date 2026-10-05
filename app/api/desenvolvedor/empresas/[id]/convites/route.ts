import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { lerJson } from '@/lib/acessos/http';
import { cancelarConvite, convidarUsuario, reenviarConvite } from '@/lib/desenvolvedor/vinculos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const corpoSchema = z.discriminatedUnion('acao', [
    z.object({ acao: z.literal('convidar'), dados: z.unknown() }).strict(),
    z.object({ acao: z.literal('reenviar'), conviteId: z.string() }).strict(),
    z.object({ acao: z.literal('cancelar'), conviteId: z.string() }).strict(),
]);

export async function POST(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, async (sessao, ctx) => {
        const corpo = corpoSchema.parse(await lerJson(request));
        if (corpo.acao === 'convidar')
            return convidarUsuario(sessao, id, corpo.dados, ctx);
        if (corpo.acao === 'reenviar')
            return reenviarConvite(sessao, id, corpo.conviteId, ctx);
        return cancelarConvite(sessao, id, corpo.conviteId, ctx);
    });
}
