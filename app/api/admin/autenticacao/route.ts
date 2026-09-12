import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authError, loginAdmin, logoutAdmin, reautenticarAdmin } from '@/lib/autenticacao/service';
import { hashToken } from '@/lib/autenticacao/senha';
import { exigirApiAdminCrmDisponivel, politicaAdmin, tokenAdmin, verificarOrigem } from '@/lib/http/admin-crm-api';
import { isClienteServiceError } from '@/lib/clientes/services/errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const schema = z.discriminatedUnion('acao', [
    z.object({ acao: z.literal('login'), email: z.string().trim().email().max(254), senha: z.string().max(512) }).strict(),
    z.object({ acao: z.literal('logout') }).strict(),
    z.object({ acao: z.literal('reautenticar'), senha: z.string().max(512) }).strict(),
]);
function response(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }
function fail(error: unknown) { return isClienteServiceError(error) ? response({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus) : response({ ok: false, erro: 'Falha na autenticação.' }, 500); }
export async function GET(request: NextRequest) {
    try {
        const policy = politicaAdmin(request);
        try {
            const session = await exigirApiAdminCrmDisponivel(request);
            const csrf = request.cookies.get(policy.csrfCookie)?.value ?? '';
            if (hashToken(csrf) !== session.csrf_hash)
                throw authError();
            return response({ ok: true, data: { usuarioId: session.usuario_id, nome: session.nome, papel: session.papel, csrf } });
        }
        catch (error) {
            if (!isClienteServiceError(error) || error.httpStatus !== 401)
                throw error;
        }
        const csrf = randomBytes(32).toString('base64url');
        const res = response({ ok: true, data: { usuarioId: null, csrf } });
        res.cookies.set(policy.csrfCookie, csrf, { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: '/', maxAge: 600 });
        return res;
    }
    catch (error) {
        return fail(error);
    }
}
export async function POST(request: NextRequest) {
    try {
        const policy = verificarOrigem(request), body = schema.safeParse(await request.json());
        if (!body.success)
            return response({ ok: false, erro: 'Dados inválidos.' }, 400);
        const csrf = request.cookies.get(policy.csrfCookie)?.value ?? '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(csrf) || hashToken(csrf) !== hashToken(request.headers.get('x-csrf-token') ?? ''))
            throw authError('Verificação CSRF recusada.', 403);
        if (body.data.acao !== 'login')
            await exigirApiAdminCrmDisponivel(request);
        if (body.data.acao === 'logout') {
            await logoutAdmin(tokenAdmin(request));
            const res = response({ ok: true });
            for (const name of [policy.cookie, policy.csrfCookie])
                res.cookies.set(name, '', { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: '/', maxAge: 0 });
            return res;
        }
        const result = body.data.acao === 'login'
            ? await loginAdmin(body.data.email, body.data.senha, randomUUID(), null, request.headers.get('user-agent')?.slice(0, 1000) ?? null)
            : await reautenticarAdmin(tokenAdmin(request), body.data.senha);
        const res = response({ ok: true, data: { csrf: result.csrf } });
        for (const [name, value] of [[policy.cookie, result.token], [policy.csrfCookie, result.csrf]])
            res.cookies.set(name, value, { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: '/', expires: result.expires });
        return res;
    }
    catch (error) {
        return fail(error);
    }
}
