export type ItemNavegacao = {
    href: string;
    rotulo: string;
    grupo: 'Principal' | 'Operação' | 'Financeiro' | 'Configurações';
};

const PRINCIPAL: ItemNavegacao[] = [
    { href: '/admin/dashboard', rotulo: 'Dashboard', grupo: 'Principal' },
];

const OPERACAO: ItemNavegacao[] = [
    { href: '/clientes', rotulo: 'Clientes', grupo: 'Operação' },
    { href: '/admin/contratos', rotulo: 'Contratos', grupo: 'Operação' },
    { href: '/admin/festas', rotulo: 'Festas', grupo: 'Operação' },
    { href: '/admin/disponibilidade', rotulo: 'Agenda', grupo: 'Operação' },
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
    { href: '/admin/configuracoes/pacotes', rotulo: 'Pacotes', grupo: 'Configurações', autoridade: 'empresa' },
    { href: '/admin/configuracoes/catalogo', rotulo: 'Itens do Buffet', grupo: 'Configurações', autoridade: 'empresa' },
    { href: '/admin/configuracoes/acessos', rotulo: 'Usuários e acessos', grupo: 'Configurações', autoridade: 'empresa' },
    { href: '/admin/configuracoes/whatsapp', rotulo: 'WhatsApp', grupo: 'Configurações', autoridade: 'plataforma' },
    { href: '/admin/configuracoes/tabela-pacotes', rotulo: 'PDF de Pacotes', grupo: 'Configurações', autoridade: 'plataforma' },
];

/** `financeiroCompleto: false` = plano sem contas a pagar (Essencial). Ausente = incluído (teste, legado, isenta). */
export type PermissoesNavegacao = { gestaoEmpresa: boolean; plataforma: boolean; financeiroCompleto?: boolean };

/** Telas do financeiro completo; a mesma matriz de lib/assinatura/recursos-plano.ts recusa as APIs no servidor. */
export const ROTAS_FINANCEIRO_COMPLETO = ['/admin/financeiro/contas-pagar', '/admin/financeiro/fluxo-caixa', '/admin/financeiro/relatorios'] as const;

/** `true`/`false` mantém o comportamento antigo (as duas autoridades juntas); o shell passa as duas separadas. */
export function itensNavegacao(permissoes: boolean | PermissoesNavegacao): ItemNavegacao[] {
    const p: PermissoesNavegacao = typeof permissoes === 'boolean' ? { gestaoEmpresa: permissoes, plataforma: permissoes } : permissoes;
    const financeiro = p.financeiroCompleto === false
        ? FINANCEIRO.filter((item) => !(ROTAS_FINANCEIRO_COMPLETO as readonly string[]).includes(item.href))
        : FINANCEIRO;
    const base = [...PRINCIPAL, ...OPERACAO, ...financeiro];
    const config = CONFIGURACAO
        .filter((item) => (item.autoridade === 'empresa' ? p.gestaoEmpresa : p.plataforma))
        .map(({ autoridade: _autoridade, ...item }) => { void _autoridade; return item; });
    return [...base, ...config];
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
