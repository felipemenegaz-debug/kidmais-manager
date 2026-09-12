'use client';
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
    headers.set('x-csrf-token', info.data.csrf);
    return fetch(input, { ...init, headers, cache: 'no-store' });
}
