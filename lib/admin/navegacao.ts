// Principal (Dashboard, Solicitações) ainda não tem rota; grupo sem itens não é renderizado.
export const GRUPOS_NAVEGACAO = ['Principal', 'Operação', 'Configuração'] as const;

export type GrupoNavegacao = typeof GRUPOS_NAVEGACAO[number];

export type ItemNavegacao = {
    href: string;
    rotulo: string;
    grupo: GrupoNavegacao;
};

const OPERACAO: ItemNavegacao[] = [
    { href: '/clientes', rotulo: 'Clientes', grupo: 'Operação' },
    { href: '/admin/contratos', rotulo: 'Contratos', grupo: 'Operação' },
    { href: '/admin/festas', rotulo: 'Festas', grupo: 'Operação' },
    { href: '/admin/disponibilidade', rotulo: 'Agenda', grupo: 'Operação' },
];

const CONFIGURACAO: ItemNavegacao[] = [
    { href: '/admin/configuracoes', rotulo: 'Configurações', grupo: 'Configuração' },
    { href: '/admin/configuracoes/perfil-empresa', rotulo: 'Perfil da empresa', grupo: 'Configuração' },
    { href: '/admin/configuracoes/acessos', rotulo: 'Usuários e acessos', grupo: 'Configuração' },
    { href: '/admin/configuracoes/whatsapp', rotulo: 'WhatsApp', grupo: 'Configuração' },
    { href: '/admin/configuracoes/tabela-pacotes', rotulo: 'Tabela de pacotes', grupo: 'Configuração' },
    { href: '/admin/configuracoes/catalogo', rotulo: 'Buffet e adicionais', grupo: 'Configuração' },
];

export function itensNavegacao(gestao: boolean) {
    return gestao ? [...OPERACAO, ...CONFIGURACAO] : [...OPERACAO];
}

export function gruposNavegacao(itens: ItemNavegacao[]) {
    return GRUPOS_NAVEGACAO
        .map((grupo) => ({ grupo, itens: itens.filter((item) => item.grupo === grupo) }))
        .filter((secao) => secao.itens.length > 0);
}

export function itemAtivo(caminho: string, href: string, itens: Array<{ href: string }>) {
    const candidatos = itens.filter((item) => caminho === item.href || caminho.startsWith(`${item.href}/`));
    if (candidatos.length === 0)
        return false;
    const melhor = candidatos.reduce((atual, item) => item.href.length > atual.href.length ? item : atual);
    return melhor.href === href;
}
