import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authError, loginAdmin, logoutAdmin, reautenticarAdmin } from '@/lib/autenticacao/service';
import { hashToken } from '@/lib/autenticacao/senha';
import { exigirApiAdminCrmDisponivel, politicaAdmin, tokenAdmin, verificarOrigem } from '@/lib/http/admin-crm-api';
import { isClienteServiceError } from '@/lib/clientes/services/errors';
import { db } from '@/lib/db/postgres';
import { contextoDaSessao } from '@/lib/autenticacao/contexto';
import { selecionarEmpresaAtiva } from '@/lib/autenticacao/empresa-ativa';
import { resumoComercialDaEmpresa } from '@/lib/assinatura/paywall';
import { PacoteAdminError } from '@/lib/comercial/pacotes-admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const schema = z.discriminatedUnion('acao', [
    z.object({ acao: z.literal('login'), email: z.string().trim().email().max(254), senha: z.string().max(512) }).strict(),
    z.object({ acao: z.literal('logout') }).strict(),
    z.object({ acao: z.literal('reautenticar'), senha: z.string().max(512) }).strict(),
    z.object({ acao: z.literal('selecionar-empresa'), empresaId: z.string().uuid() }).strict(),
]);
function response(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }
function fail(error: unknown) {
    if (!(isClienteServiceError(error) || error instanceof PacoteAdminError))
        return response({ ok: false, erro: 'Falha na autenticação.' }, 500);
    const res = response({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus);
    // Limite de tentativas com prazo calculável (janela do banco): Retry-After em segundos; sem prazo, nenhum cabeçalho.
    const detalhes = error.details as { retryAfterSegundos?: unknown } | null | undefined;
    const segundos = detalhes && typeof detalhes === 'object' ? detalhes.retryAfterSegundos : undefined;
    if (error.httpStatus === 429 && typeof segundos === 'number' && Number.isFinite(segundos) && segundos > 0)
        res.headers.set('Retry-After', String(Math.max(1, Math.ceil(segundos))));
    return res;
}
export async function GET(request: NextRequest) {
    try {
        const policy = politicaAdmin(request);
        try {
            const session = await exigirApiAdminCrmDisponivel(request);
            const csrf = request.cookies.get(policy.csrfCookie)?.value ?? '';
            if (hashToken(csrf) !== session.csrf_hash)
                throw authError();
            // D7: o menu segue o papel NA EMPRESA selecionada (mesma regra de provarTenant), não o papel global.
            const contexto = await contextoDaSessao(db(), session);
            // E4: situação comercial da empresa selecionada, só para a tela (a barreira está na guarda das APIs).
            const comercial = contexto.empresaAtual ? await resumoComercialDaEmpresa(db(), contexto.empresaAtual.id) : null;
            return response({ ok: true, data: { sessaoId: session.id, usuarioId: session.usuario_id, nome: session.nome, papel: session.papel, csrf, contexto, comercial } });
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
            : body.data.acao === 'selecionar-empresa'
                ? await selecionarEmpresaAtiva(tokenAdmin(request), body.data.empresaId)
            : await reautenticarAdmin(tokenAdmin(request), body.data.senha);
        // Só a reautenticação devolve a renovação (sessão anterior → nova); login e seleção de empresa não.
        const renovacao = body.data.acao === 'reautenticar' && 'renovacao' in result ? result.renovacao : null;
        const res = response({ ok: true, data: { csrf: result.csrf, renovacao } });
        for (const [name, value] of [[policy.cookie, result.token], [policy.csrfCookie, result.csrf]])
            res.cookies.set(name, value, { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: '/', expires: result.expires });
        return res;
    }
    catch (error) {
        return fail(error);
    }
}
