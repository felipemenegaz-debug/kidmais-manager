import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { authError, consultarSessao, type SessaoAdmin } from '../autenticacao/service';
import { hashToken } from '../autenticacao/senha';
import { db } from '../db/postgres';
import type { ClienteServiceContext } from '../clientes/services/context';
const sessions = new WeakMap<NextRequest, SessaoAdmin>();
export function politicaAdmin(request: NextRequest) {
    const configured = process.env.ADMIN_AUTH_ORIGIN || (process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : '');
    if (!configured)
        throw authError('Configure a origem HTTPS administrativa.', 503);
    const origin = new URL(configured);
    const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.protocol === 'http:';
    if ((!local && origin.protocol !== 'https:') || request.nextUrl.origin !== origin.origin)
        throw authError('Use a origem administrativa segura configurada.', 403);
    return { origin: origin.origin, secure: !local, cookie: local ? 'kidmais_admin_dev' : '__Host-kidmais_admin', csrfCookie: local ? 'kidmais_admin_csrf_dev' : '__Host-kidmais_admin_csrf' };
}
export function verificarOrigem(request: NextRequest) {
    const policy = politicaAdmin(request);
    if (request.headers.get('origin') !== policy.origin)
        throw authError('Origem da requisição recusada.', 403);
    return policy;
}
export function tokenAdmin(request: NextRequest) { return request.cookies.get(politicaAdmin(request).cookie)?.value ?? ''; }
export async function exigirApiAdminCrmDisponivel(request: NextRequest) {
    if (sessions.has(request))
        return sessions.get(request)!;
    const session = await consultarSessao(tokenAdmin(request));
    if (!['GET', 'HEAD'].includes(request.method)) {
        verificarOrigem(request);
        if (hashToken(request.headers.get('x-csrf-token') ?? '') !== session.csrf_hash)
            throw authError('Verificação CSRF recusada.', 403);
    }
    await db().query('UPDATE sessoes_administrativas SET ultima_atividade_em=clock_timestamp() WHERE id=$1 AND revogado_em IS NULL', [session.id]);
    sessions.set(request, session);
    return session;
}
export function contextoCrmDaRequest(request: NextRequest): ClienteServiceContext {
    const session = sessions.get(request);
    if (!session)
        throw authError();
    return { usuarioId: session.usuario_id, origem: 'CRM_INTERNO', requestId: randomUUID(), ip: null, userAgent: request.headers.get('user-agent')?.slice(0, 1000) ?? null };
}
