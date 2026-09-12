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

export type CodigoRecusaOrigemAdmin =
    | 'ADMIN_ORIGIN_INVALID'
    | 'FORWARDED_PROTO_MISSING'
    | 'FORWARDED_PROTO_INVALID'
    | 'MULTIPLE_FORWARDED_PROTOS'
    | 'HOST_MISSING'
    | 'HOST_MISMATCH'
    | 'MULTIPLE_HOSTS'
    | 'FORWARDED_HOST_MISMATCH'
    | 'MULTIPLE_FORWARDED_HOSTS'
    | 'DIRECT_ORIGIN_MISMATCH';

export type DiagnosticoOrigemAdmin = {
    valido: boolean;
    codigo: CodigoRecusaOrigemAdmin | null;
    renderReconhecido: boolean;
    stagingReconhecido: boolean;
    adminOriginValida: boolean;
    hostPresente: boolean;
    forwardedHostPresente: boolean;
    forwardedProtoPresente: boolean;
    host: string | null;
    forwardedHost: string | null;
    forwardedProto: string | null;
};

function valorHeaderSanitizado(value: string | null) {
    if (value === null)
        return null;
    return value.slice(0, 256).replace(/[^\x20-\x7e]/g, '?');
}

function diagnosticoRenderStaging(request: RequestOrigem, origin: URL, env: AmbientePoliticaAdmin): DiagnosticoOrigemAdmin {
    const host = request.headers.get('host');
    const forwardedHost = request.headers.get('x-forwarded-host');
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const base = {
        renderReconhecido: env.RENDER === 'true',
        stagingReconhecido: env.KIDMAIS_DEPLOY_ENV === 'staging',
        adminOriginValida: origin.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname),
        hostPresente: host !== null,
        forwardedHostPresente: forwardedHost !== null,
        forwardedProtoPresente: forwardedProto !== null,
        host: valorHeaderSanitizado(host),
        forwardedHost: valorHeaderSanitizado(forwardedHost),
        forwardedProto: valorHeaderSanitizado(forwardedProto),
    };
    const recusa = (codigo: CodigoRecusaOrigemAdmin): DiagnosticoOrigemAdmin => ({ ...base, valido: false, codigo });

    if (!base.adminOriginValida)
        return recusa('ADMIN_ORIGIN_INVALID');
    if (forwardedProto === null)
        return recusa('FORWARDED_PROTO_MISSING');
    if (forwardedProto.includes(','))
        return recusa('MULTIPLE_FORWARDED_PROTOS');
    if (forwardedProto !== 'https')
        return recusa('FORWARDED_PROTO_INVALID');
    if (host === null && forwardedHost === null)
        return recusa('HOST_MISSING');
    if (host !== null && host.includes(','))
        return recusa('MULTIPLE_HOSTS');
    if (host !== null && (host.length === 0 || host !== host.trim() || host !== origin.host))
        return recusa('HOST_MISMATCH');
    if (forwardedHost !== null && forwardedHost.includes(','))
        return recusa('MULTIPLE_FORWARDED_HOSTS');
    if (forwardedHost !== null && (forwardedHost.length === 0 || forwardedHost !== forwardedHost.trim() || forwardedHost !== origin.host))
        return recusa('FORWARDED_HOST_MISMATCH');
    return { ...base, valido: true, codigo: null };
}

export function ambientePoliticaAdminAtual(): AmbientePoliticaAdmin {
    return {
        ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN,
        KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV,
        NODE_ENV: process.env.NODE_ENV,
        RENDER: process.env.RENDER,
    };
}

export function diagnosticarOrigemRequest(
    request: RequestOrigem,
    origin: URL,
    env: AmbientePoliticaAdmin,
): DiagnosticoOrigemAdmin {
    const renderReconhecido = env.RENDER === 'true';
    const stagingReconhecido = env.KIDMAIS_DEPLOY_ENV === 'staging';
    if (renderReconhecido && stagingReconhecido)
        return diagnosticoRenderStaging(request, origin, env);

    const valido = request.nextUrl.origin === origin.origin;
    return {
        valido,
        codigo: valido ? null : 'DIRECT_ORIGIN_MISMATCH',
        renderReconhecido,
        stagingReconhecido,
        adminOriginValida: true,
        hostPresente: request.headers.get('host') !== null,
        forwardedHostPresente: request.headers.get('x-forwarded-host') !== null,
        forwardedProtoPresente: request.headers.get('x-forwarded-proto') !== null,
        host: null,
        forwardedHost: null,
        forwardedProto: null,
    };
}

export function origemRequestValida(request: RequestOrigem, origin: URL, env: AmbientePoliticaAdmin) {
    return diagnosticarOrigemRequest(request, origin, env).valido;
}

export function linhaDiagnosticoRecusaOrigemAdmin(diagnostico: DiagnosticoOrigemAdmin) {
    if (!diagnostico.renderReconhecido || !diagnostico.stagingReconhecido || diagnostico.valido)
        return null;
    return `[Kidmais Admin Origin] ${JSON.stringify(diagnostico)}`;
}

export function origemMutacaoValida(request: RequestOrigem, esperada: string) {
    return request.headers.get('origin') === esperada;
}
