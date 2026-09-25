export type ItemNavegacao = {
    href: string;
    rotulo: string;
    grupo: 'Operação' | 'Configurações';
};

const OPERACAO: ItemNavegacao[] = [
    { href: '/clientes', rotulo: 'Clientes', grupo: 'Operação' },
    { href: '/admin/contratos', rotulo: 'Contratos', grupo: 'Operação' },
    { href: '/admin/festas', rotulo: 'Festas', grupo: 'Operação' },
    { href: '/admin/disponibilidade', rotulo: 'Agenda', grupo: 'Operação' },
];

const CONFIGURACAO: ItemNavegacao[] = [
    { href: '/admin/configuracoes', rotulo: 'Configurações', grupo: 'Configurações' },
    { href: '/admin/configuracoes/perfil-empresa', rotulo: 'Perfil da empresa', grupo: 'Configurações' },
    { href: '/admin/configuracoes/acessos', rotulo: 'Usuários e acessos', grupo: 'Configurações' },
    { href: '/admin/configuracoes/whatsapp', rotulo: 'WhatsApp', grupo: 'Configurações' },
    { href: '/admin/configuracoes/tabela-pacotes', rotulo: 'Tabela de pacotes', grupo: 'Configurações' },
    { href: '/admin/configuracoes/catalogo', rotulo: 'Buffet e adicionais', grupo: 'Configurações' },
];

export function itensNavegacao(gestao: boolean) {
    return gestao ? [...OPERACAO, ...CONFIGURACAO] : [...OPERACAO];
}

export function itemAtivo(caminho: string, href: string, itens: Array<{ href: string }>) {
    const candidatos = itens.filter((item) => caminho === item.href || caminho.startsWith(`${item.href}/`));
    if (candidatos.length === 0)
        return false;
    const melhor = candidatos.reduce((atual, item) => item.href.length > atual.href.length ? item : atual);
    return melhor.href === href;
}
