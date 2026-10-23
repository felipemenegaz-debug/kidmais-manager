export type ItemNavegacao = {
    href: string;
    rotulo: string;
    grupo: 'Principal' | 'Operação' | 'Marketing' | 'Financeiro' | 'Configurações';
};

const PRINCIPAL: ItemNavegacao[] = [
    { href: '/admin/dashboard', rotulo: 'Dashboard', grupo: 'Principal' },
];

const OPERACAO: ItemNavegacao[] = [
    { href: '/clientes', rotulo: 'Clientes', grupo: 'Operação' },
    { href: '/admin/contratos', rotulo: 'Contratos', grupo: 'Operação' },
    { href: '/admin/festas', rotulo: 'Festas', grupo: 'Operação' },
    { href: '/admin/disponibilidade', rotulo: 'Agenda', grupo: 'Operação' },
    { href: '/admin/atendimento', rotulo: 'Atendimento WhatsApp', grupo: 'Operação' },
];

/**
 * Marketing (goal local 14/10/2026): aparece com o recurso MARKETING no plano e alguma capacidade de Marketing na
 * empresa (Gestão tem todas). A barreira está nas APIs (lib/marketing/http.ts); o menu só acompanha.
 */
const MARKETING: ItemNavegacao[] = [
    { href: '/admin/marketing', rotulo: 'Visão geral', grupo: 'Marketing' },
    { href: '/admin/marketing/campanhas', rotulo: 'Campanhas', grupo: 'Marketing' },
    { href: '/admin/marketing/origens', rotulo: 'Origens dos contatos', grupo: 'Marketing' },
    { href: '/admin/marketing/site', rotulo: 'Site e SEO', grupo: 'Marketing' },
    { href: '/admin/marketing/automacoes', rotulo: 'Automações', grupo: 'Marketing' },
];

const FINANCEIRO: ItemNavegacao[] = [
    { href: '/admin/financeiro', rotulo: 'Visão geral', grupo: 'Financeiro' },
    { href: '/admin/financeiro/contas-receber', rotulo: 'Contas a receber', grupo: 'Financeiro' },
    { href: '/admin/financeiro/contas-pagar', rotulo: 'Contas a pagar', grupo: 'Financeiro' },
    { href: '/admin/financeiro/fluxo-caixa', rotulo: 'Fluxo de caixa', grupo: 'Financeiro' },
    { href: '/admin/financeiro/relatorios', rotulo: 'Relatórios', grupo: 'Financeiro' },
];

/**
 * O grupo já se chama Configurações; a rota /admin/configuracoes continua existindo, sem item redundante.
 * Cada item segue a MESMA autoridade que o servidor exige na API correspondente (D7):
 *   - `empresa`: Gestão NA EMPRESA selecionada (memberships.papel; exigirGestaoNoTenant / perfil por membership);
 *   - `plataforma`: recurso da instalação inteira (temAutoridadeDePlataforma, F1) — nunca o papel de empresa.
 */
const CONFIGURACAO: Array<ItemNavegacao & { autoridade: 'empresa' | 'plataforma' }> = [
    { href: '/admin/configuracoes/perfil-empresa', rotulo: 'Perfil da empresa', grupo: 'Configurações', autoridade: 'empresa' },
    // 093: a agenda da unidade. O assistente da primeira entrada é de qualquer usuário; a tela, de Gestão.
    { href: '/admin/configuracoes/agenda', rotulo: 'Agenda', grupo: 'Configurações', autoridade: 'empresa' },
    { href: '/admin/configuracoes/pacotes', rotulo: 'Pacotes', grupo: 'Configurações', autoridade: 'empresa' },
    { href: '/admin/configuracoes/catalogo', rotulo: 'Itens do Buffet', grupo: 'Configurações', autoridade: 'empresa' },
    // Importar documentos (tabela de preços, modelo de contrato, contrato de festa; pedido de Felipe, 23/10/2026): no menu
    // de Configurações, como os demais itens da empresa, só para Gestão. É só visibilidade do atalho: quem decide são as
    // APIs de cada documento — enviar e ler o PDF pede sessão admin no Tenant Context; revisar e publicar a tabela ou
    // aprovar o modelo de contrato já exige Gestão; o contrato de festa segue a regra da importação de contratos.
    { href: '/admin/configuracoes/importar-documentos', rotulo: 'Importar documentos', grupo: 'Configurações', autoridade: 'empresa' },
    { href: '/admin/configuracoes/acessos', rotulo: 'Usuários e acessos', grupo: 'Configurações', autoridade: 'empresa' },
    // 083: o WhatsApp é da EMPRESA (cada uma conecta o próprio número): Gestão na empresa selecionada.
    { href: '/admin/configuracoes/whatsapp', rotulo: 'WhatsApp', grupo: 'Configurações', autoridade: 'empresa' },
    // 095: compra e devolução de créditos são da Gestão da empresa (lib/creditos/compra.ts exigirGestao).
    { href: '/admin/configuracoes/creditos', rotulo: 'Créditos de IA', grupo: 'Configurações', autoridade: 'empresa' },
];

/** `financeiroCompleto: false` = plano sem contas a pagar (Essencial). Ausente = incluído (teste, legado, isenta). */
/** `marketing: false` = plano sem Marketing ou pessoa sem capacidade nesta empresa. Ausente = mostrado (compatibilidade). */
export type PermissoesNavegacao = { gestaoEmpresa: boolean; plataforma: boolean; financeiroCompleto?: boolean; marketing?: boolean };

/** Telas do financeiro completo; a mesma matriz de lib/assinatura/recursos-plano.ts recusa as APIs no servidor. */
export const ROTAS_FINANCEIRO_COMPLETO = ['/admin/financeiro/contas-pagar', '/admin/financeiro/fluxo-caixa', '/admin/financeiro/relatorios'] as const;

/** `true`/`false` mantém o comportamento antigo (as duas autoridades juntas); o shell passa as duas separadas. */
export function itensNavegacao(permissoes: boolean | PermissoesNavegacao): ItemNavegacao[] {
    const p: PermissoesNavegacao = typeof permissoes === 'boolean' ? { gestaoEmpresa: permissoes, plataforma: permissoes } : permissoes;
    const financeiro = p.financeiroCompleto === false
        ? FINANCEIRO.filter((item) => !(ROTAS_FINANCEIRO_COMPLETO as readonly string[]).includes(item.href))
        : FINANCEIRO;
    const base = [...PRINCIPAL, ...OPERACAO, ...(p.marketing === false ? [] : MARKETING), ...financeiro];
    const config = CONFIGURACAO
        .filter((item) => (item.autoridade === 'empresa' ? p.gestaoEmpresa : p.plataforma))
        .map(({ autoridade: _autoridade, ...item }) => { void _autoridade; return item; });
    return [...base, ...config];
}

/**
 * Cartões do hub de Configurações (/admin/configuracoes): a MESMA autoridade do menu e da API. Rota sem autoridade
 * registrada continua visível; sem as permissões do shell (fora dele), o hub mostra tudo como antes.
 */
export function configuracaoVisivel(href: string, permissoes: PermissoesNavegacao | null) {
    const autoridade = autoridadeDaConfiguracao(href);
    if (!autoridade || !permissoes) return true;
    return autoridade === 'empresa' ? permissoes.gestaoEmpresa : permissoes.plataforma;
}

/** Rotas de configuração e a autoridade que o servidor exige (usado no teste que amarra menu e API). */
export function autoridadeDaConfiguracao(href: string) {
    return CONFIGURACAO.find((item) => item.href === href)?.autoridade ?? null;
}

export function itemAtivo(caminho: string, href: string, itens: Array<{ href: string }>) {
    const candidatos = itens.filter((item) => caminho === item.href || caminho.startsWith(`${item.href}/`));
    if (candidatos.length === 0)
        return false;
    const melhor = candidatos.reduce((atual, item) => item.href.length > atual.href.length ? item : atual);
    return melhor.href === href;
}
