import { ROTA_AJUDA } from './rota.ts';

/**
 * Artigo de cada tela do Admin (prefixo de rota → id). O mais longo vence. O link "Ajuda desta tela" só aparece se o
 * artigo estiver na lista recebida do servidor (aprovado e público); artigo pendente não gera link quebrado.
 */
export const ARTIGO_DA_ROTA: Readonly<Record<string, string>> = {
    '/admin/inicio': 'primeiros-passos',
    '/admin/dashboard': 'dashboard',
    '/admin/perfil': 'perfil-e-senha',
    '/admin/assinatura': 'assinatura-e-plano',
    '/admin/festas': 'festas',
    '/admin/contratos': 'contratos',
    '/admin/disponibilidade': 'agenda-e-horarios',
    '/admin/convites': 'convites',
    '/admin/atendimento': 'atendimento-whatsapp',
    '/admin/fechamentos': 'fechamento-de-festa',
    '/admin/clientes': 'clientes',
    '/clientes': 'clientes',
    '/admin/marketing': 'marketing',
    '/admin/financeiro': 'financeiro-recebimentos',
    '/admin/financeiro/contas-receber': 'financeiro-recebimentos',
    '/admin/financeiro/contas-pagar': 'contas-a-pagar-e-caixa',
    '/admin/financeiro/fluxo-caixa': 'contas-a-pagar-e-caixa',
    '/admin/financeiro/relatorios': 'contas-a-pagar-e-caixa',
    '/admin/conexoes-ia': 'assistentes-externos',
    '/admin/configuracoes/perfil-empresa': 'perfil-da-empresa',
    '/admin/configuracoes/agenda': 'agenda-e-horarios',
    '/admin/configuracoes/saloes': 'saloes-pacotes-e-itens',
    '/admin/configuracoes/pacotes': 'saloes-pacotes-e-itens',
    '/admin/configuracoes/catalogo': 'saloes-pacotes-e-itens',
    '/admin/configuracoes/modelo-contrato': 'contratos',
    '/admin/configuracoes/importar-documentos': 'importar-documentos',
    '/admin/configuracoes/acessos': 'usuarios-e-acessos',
    '/admin/configuracoes/whatsapp': 'conectar-whatsapp',
    '/admin/configuracoes/creditos': 'creditos-de-ia',
};

/** Artigo publicado quando o layout foi montado; `ate` é o último dia de vigência (null = sem fim). */
export type ArtigoPublicado = { id: string; ate: string | null };

export function artigoDaRota(path: string, publicados: readonly ArtigoPublicado[], hoje: string): string | null {
    let melhor: string | null = null;
    for (const prefixo of Object.keys(ARTIGO_DA_ROTA)) {
        if ((path === prefixo || path.startsWith(`${prefixo}/`)) && (!melhor || prefixo.length > melhor.length)) melhor = prefixo;
    }
    const id = melhor ? ARTIGO_DA_ROTA[melhor] : null;
    // O layout é reaproveitado entre telas: artigo que venceu depois de montado não vira link quebrado.
    return id && publicados.some((a) => a.id === id && (a.ate === null || a.ate >= hoje)) ? id : null;
}

/** A ajuda e os artigos dela ficam abertos sem empresa ativa e com o acesso bloqueado (AdminShell). */
export function rotaDaAjuda(path: string) {
    return path === ROTA_AJUDA || path.startsWith(`${ROTA_AJUDA}/`);
}
