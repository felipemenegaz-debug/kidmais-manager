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

/** O grupo já se chama Configurações; a rota /admin/configuracoes continua existindo, sem item redundante. */
const CONFIGURACAO: ItemNavegacao[] = [
    { href: '/admin/configuracoes/perfil-empresa', rotulo: 'Perfil da empresa', grupo: 'Configurações' },
    { href: '/admin/configuracoes/pacotes', rotulo: 'Pacotes', grupo: 'Configurações' },
    { href: '/admin/configuracoes/catalogo', rotulo: 'Itens do Buffet', grupo: 'Configurações' },
    { href: '/admin/configuracoes/acessos', rotulo: 'Usuários e acessos', grupo: 'Configurações' },
    { href: '/admin/configuracoes/whatsapp', rotulo: 'WhatsApp', grupo: 'Configurações' },
    { href: '/admin/configuracoes/tabela-pacotes', rotulo: 'PDF de Pacotes', grupo: 'Configurações' },
];

export function itensNavegacao(gestao: boolean) {
    const base = [...PRINCIPAL, ...OPERACAO, ...FINANCEIRO];
    return gestao ? [...base, ...CONFIGURACAO] : base;
}

export function itemAtivo(caminho: string, href: string, itens: Array<{ href: string }>) {
    const candidatos = itens.filter((item) => caminho === item.href || caminho.startsWith(`${item.href}/`));
    if (candidatos.length === 0)
        return false;
    const melhor = candidatos.reduce((atual, item) => item.href.length > atual.href.length ? item : atual);
    return melhor.href === href;
}
