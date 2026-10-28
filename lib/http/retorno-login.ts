/**
 * Retorno depois do login do Admin. Caminhos internos sem query, como antes, e uma única exceção com query: o
 * consentimento do canal MCP com o pedido opaco no formato exato (UX-1: no teste real de 28/10/2026, quem não estava
 * logado perdia o pedido e precisava reiniciar a conexão no assistente). Nada de URL externa ou query livre.
 */
const CONSENTIMENTO = '/admin/conexoes-ia/autorizar';
/** O assistente da agenda (093) não abre por cima do consentimento: no teste real ele cobriu e capturou cliques. */
export const CONSENTIMENTO_MCP = CONSENTIMENTO;
const PEDIDO_CONSENTIMENTO = /^\/admin\/conexoes-ia\/autorizar\?pedido=kmp_[A-Za-z0-9_-]{43}$/;

export function destinoAposLogin(voltar: string): string {
    if (PEDIDO_CONSENTIMENTO.test(voltar)) return voltar;
    return /^\/(admin|desenvolvedor)(\/[A-Za-z0-9_\-/]*)?$/.test(voltar) && !voltar.includes('//') && !voltar.startsWith('/admin/login') ? voltar : '/admin/dashboard';
}

export function loginComRetorno(pathname: string, search: string): string {
    if (pathname === CONSENTIMENTO) {
        const voltar = `${CONSENTIMENTO}?pedido=${new URLSearchParams(search).get('pedido') ?? ''}`;
        if (PEDIDO_CONSENTIMENTO.test(voltar)) return `/admin/login?voltar=${encodeURIComponent(voltar)}`;
    }
    return '/admin/login';
}

/**
 * Login a partir da página atual. Todo caminho que manda ao login por sessão encerrada usa este (revisão do Astra de
 * 28/10/2026, P2-2: a falha de leitura do shell e o adminFetch ainda perdiam o pedido). Sair por vontade própria não.
 */
export function loginDestaPagina(): string {
    return loginComRetorno(window.location.pathname, window.location.search ?? '');
}
