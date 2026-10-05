import type { NextRequest } from 'next/server';
import { verificarOrigem } from '@/lib/http/admin-crm-api';
import { contextoDaRequisicao, falhar, lerJson, responder } from '@/lib/acessos/http';
import { redefinirSenhaComToken } from '@/lib/acessos/recuperacao';
import { exigirRecuperacaoPublicaAtiva } from '@/lib/acessos/disponibilidade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Define a nova senha com o token de recuperação (uso único). Encerra todas as sessões da conta. */
export async function POST(request: NextRequest) {
    try {
        verificarOrigem(request);
        exigirRecuperacaoPublicaAtiva();
        const data = await redefinirSenhaComToken(await lerJson(request), contextoDaRequisicao(request));
        return responder({ ok: true, data });
    }
    catch (error) {
        return falhar(error);
    }
}
