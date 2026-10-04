import type { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel, politicaAdmin, tokenAdmin } from '@/lib/http/admin-crm-api';
import { contextoDaRequisicao, falhar, lerJson, responder } from '@/lib/acessos/http';
import { trocarPropriaSenha } from '@/lib/acessos/senha-propria';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Troca da própria senha. Exige sessão, origem e CSRF. Sucesso: todas as sessões da conta são encerradas e este
 * navegador recebe uma sessão nova (cookies substituídos). Nenhuma senha volta na resposta.
 */
export async function POST(request: NextRequest) {
    try {
        await exigirApiAdminCrmDisponivel(request);
        const policy = politicaAdmin(request);
        const resultado = await trocarPropriaSenha(tokenAdmin(request), await lerJson(request), contextoDaRequisicao(request));
        const res = responder({ ok: true, data: { csrf: resultado.csrf, sessoesEncerradas: resultado.sessoesEncerradas } });
        for (const [nome, valor] of [[policy.cookie, resultado.token], [policy.csrfCookie, resultado.csrf]] as const)
            res.cookies.set(nome, valor, { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: '/', expires: resultado.expires });
        return res;
    }
    catch (error) {
        return falhar(error);
    }
}
