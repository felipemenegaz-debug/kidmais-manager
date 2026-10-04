import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { lerJson } from '@/lib/acessos/http';
import { alterarPapelVinculo, alterarSituacaoVinculo, solicitarRecuperacaoPeloPainel } from '@/lib/desenvolvedor/vinculos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string; usuarioId: string }> };

const corpoSchema = z.object({ acao: z.enum(['papel', 'desativar', 'reativar', 'recuperar']), dados: z.unknown().optional() }).strict();

/** Ações sobre o VÍNCULO desta pessoa com esta empresa (nunca sobre outra empresa nem sobre a identidade global). */
export async function POST(request: NextRequest, context: RouteContext) {
    const { id, usuarioId } = await context.params;
    return rotaDesenvolvedor(request, async (sessao, ctx) => {
        const corpo = corpoSchema.parse(await lerJson(request));
        if (corpo.acao === 'papel')
            return alterarPapelVinculo(sessao, id, usuarioId, corpo.dados ?? {}, ctx);
        if (corpo.acao === 'recuperar')
            return solicitarRecuperacaoPeloPainel(sessao, id, usuarioId, ctx);
        return alterarSituacaoVinculo(sessao, id, usuarioId, corpo.acao, corpo.dados ?? {}, ctx);
    });
}
