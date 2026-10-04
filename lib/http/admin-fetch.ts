'use client';
import { registrarContextoEmpresa, reiniciarContextoEmpresa } from './contexto-empresa-cliente';
export async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const session = await fetch('/api/admin/autenticacao', { cache: 'no-store' });
    const info = await session.json();
    if (!info.ok || !info.data.usuarioId) {
        // Limpa a página administrativa em memória quando a sessão expira; helper fora de React.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign('/admin/login');
        throw Error('Faça login para continuar.');
    }
    const headers = new Headers(init.headers);
    if (!registrarContextoEmpresa(info.data.sessaoId, info.data.contexto?.empresaAtual?.id ?? null))
        throw Error('A empresa mudou. Atualizando a página.');
    headers.set('x-kidmais-sessao', info.data.sessaoId);
    headers.set('x-csrf-token', info.data.csrf);
    const resposta = await fetch(input, { ...init, headers, cache: 'no-store' });
    // Revalida o contexto antes de entregar resultados de requisições que estavam em voo.
    if (!String(input).includes('/api/admin/autenticacao') && !String(input).includes('/api/admin/perfil/senha')) {
        const atual = await fetch('/api/admin/autenticacao', { cache: 'no-store' }).then(r => r.json());
        if (!atual.data?.usuarioId || !registrarContextoEmpresa(atual.data.sessaoId, atual.data.contexto?.empresaAtual?.id ?? null)) {
            reiniciarContextoEmpresa();
            throw Error('O contexto de acesso mudou. Atualizando a página.');
        }
    }
    return resposta;
}
