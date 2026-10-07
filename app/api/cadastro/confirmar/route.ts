import type { NextRequest } from 'next/server';
import { politicaAdmin, verificarOrigem } from '@/lib/http/admin-crm-api';
import { contextoDaRequisicao, falhar, lerJson, responder } from '@/lib/acessos/http';
import { confirmarCadastro } from '@/lib/cadastro/publico';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Confirmação do e-mail: cria a conta (papel neutro), registra os aceites e abre a sessão neste navegador. */
export async function POST(request: NextRequest) {
    try {
        verificarOrigem(request);
        const policy = politicaAdmin(request);
        const r = await confirmarCadastro(await lerJson(request), contextoDaRequisicao(request));
        const res = responder({ ok: true, data: { csrf: r.sessao.csrf } });
        for (const [nome, valor] of [[policy.cookie, r.sessao.token], [policy.csrfCookie, r.sessao.csrf]] as const)
            res.cookies.set(nome, valor, { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: '/', expires: r.sessao.expires });
        return res;
    }
    catch (error) {
        return falhar(error);
    }
}
