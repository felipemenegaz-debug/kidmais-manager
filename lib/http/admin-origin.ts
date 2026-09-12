export type AmbientePoliticaAdmin = {
    ADMIN_AUTH_ORIGIN?: string;
    KIDMAIS_DEPLOY_ENV?: string;
    NODE_ENV?: string;
    RENDER?: string;
};

type RequestOrigem = {
    headers: { get(name: string): string | null };
    nextUrl: { origin: string };
};

function hostEncaminhadoValido(value: string | null, esperado: string) {
    return value !== null && value.length > 0 && value === value.trim() && !value.includes(',') && value === esperado;
}

function origemRenderStagingValida(request: RequestOrigem, origin: URL) {
    if (origin.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
        return false;
    if (request.headers.get('x-forwarded-proto') !== 'https')
        return false;
    const host = request.headers.get('host');
    const forwardedHost = request.headers.get('x-forwarded-host');
    if (host === null && forwardedHost === null)
        return false;
    if (host !== null && !hostEncaminhadoValido(host, origin.host))
        return false;
    if (forwardedHost !== null && !hostEncaminhadoValido(forwardedHost, origin.host))
        return false;
    return true;
}

export function ambientePoliticaAdminAtual(): AmbientePoliticaAdmin {
    return {
        ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN,
        KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV,
        NODE_ENV: process.env.NODE_ENV,
        RENDER: process.env.RENDER,
    };
}

export function origemRequestValida(
    request: RequestOrigem,
    origin: URL,
    env: AmbientePoliticaAdmin,
) {
    const renderStaging = env.RENDER === 'true' && env.KIDMAIS_DEPLOY_ENV === 'staging';
    return renderStaging
        ? origemRenderStagingValida(request, origin)
        : request.nextUrl.origin === origin.origin;
}

export function origemMutacaoValida(request: RequestOrigem, esperada: string) {
    return request.headers.get('origin') === esperada;
}
