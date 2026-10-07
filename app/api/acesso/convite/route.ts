import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { verificarOrigem } from '@/lib/http/admin-crm-api';
import { contextoDaRequisicao, falhar, lerJson, responder } from '@/lib/acessos/http';
import { aceitarConvite, consultarConvite } from '@/lib/acessos/convites';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const corpoSchema = z.object({ acao: z.enum(['consultar', 'aceitar']), dados: z.unknown() }).strict();

/** Público (quem recebeu o link). Só POST da origem administrativa; o token nunca vai na URL. */
export async function POST(request: NextRequest) {
    try {
        verificarOrigem(request);
        const corpo = corpoSchema.parse(await lerJson(request));
        const ctx = contextoDaRequisicao(request);
        const data = corpo.acao === 'consultar' ? await consultarConvite(corpo.dados, ctx) : await aceitarConvite(corpo.dados, ctx);
        return responder({ ok: true, data });
    }
    catch (error) {
        return falhar(error);
    }
}
