import { condicoesComerciais, planosComerciais, valorComercial, type PlanoComercialId } from '../assinatura/planos-comerciais.ts';
/** Vitrine usa a oferta compartilhada; cobrança do legado continua independente. D5/D6 pendentes. */
export type StatusRecurso = 'disponivel' | 'em_breve';
type Recurso = { nome: string; status: StatusRecurso; evidencia: string };
const implementado = 'Implementação presente na base staging fb30f70; confirmação comercial final pendente de Felipe. Não é evidência de ativação em production.';
const semFlags = '08/10/2026: Render get_service confirmou serviço production; não expõe flags. Sem confirmação de ativação; mantém Em breve.';
export const recursos = {
    agenda: { nome: 'Agenda e disponibilidade', status: 'disponivel', evidencia: implementado },
    clientes: { nome: 'Clientes e aniversariantes', status: 'disponivel', evidencia: implementado },
    festas: { nome: 'Festas e pacotes', status: 'disponivel', evidencia: implementado },
    contratos: { nome: 'Contratos pelo celular', status: 'disponivel', evidencia: implementado },
    orcamento: { nome: 'Orçamento online', status: 'em_breve', evidencia: '10/10/2026: endereço público por empresa (/b/<código>) implementado atrás de COTACAO_PUBLICA_POR_EMPRESA, desligado até a homologação em staging. O endereço atual atende só a empresa configurada no servidor.' },
    horarios: { nome: 'Horário nobre e adicionais', status: 'disponivel', evidencia: implementado },
    financeiro: { nome: 'Financeiro', status: 'disponivel', evidencia: implementado },
    pix: { nome: 'Pix copia e cola', status: 'disponivel', evidencia: implementado },
    exportacao: { nome: 'Exportação dos dados', status: 'disponivel', evidencia: implementado },
    permissoes: { nome: 'Papéis e permissões', status: 'disponivel', evidencia: implementado },
    walle_whatsapp: { nome: 'Wall-e no WhatsApp', status: 'em_breve', evidencia: 'Planejamento; entrega de mensagens não comprovada em production.' },
    cartao: { nome: 'Cartão de crédito nas parcelas', status: 'em_breve', evidencia: 'Depende da conexão Asaas da conta do buffet; não comprovada.' },
    convite: { nome: 'Convite da festa', status: 'em_breve', evidencia: 'Módulo desenvolvido, sem homologação e ativação comprovadas.' },
    assinatura_whatsapp: { nome: 'Assinatura com código pelo WhatsApp', status: 'em_breve', evidencia: 'Depende da entrega Gupshup; não comprovada.' },
    copiloto: { nome: 'Copiloto', status: 'em_breve', evidencia: semFlags + ' Flags exigidas e pendências detalhadas em docs/SITE_VENDA_20261008.md.' },
    importacao_contratos: { nome: 'Importação de contratos em PDF', status: 'em_breve', evidencia: semFlags + ' Flags exigidas e pendências detalhadas em docs/SITE_VENDA_20261008.md.' },
    importacao_precos: { nome: 'Importação da tabela de preços por IA', status: 'em_breve', evidencia: 'Sem comprovação de ativação em production.' },
    multiunidade: { nome: 'Unidade extra', status: 'em_breve', evidencia: '11/10/2026: troca entre empresas existe, mas não há fluxo para contratar, cobrar ou provisionar unidade extra (docs/MATRIZ_RECURSOS_PLANOS_20261010.md).' },
    suporte: { nome: 'Suporte', status: 'disponivel', evidencia: 'Oferta proposta na referência; canais dependem da configuração D4.' },
    implantacao: { nome: 'Implantação assistida', status: 'disponivel', evidencia: 'Oferta proposta na referência; execução humana, sem afirmar IA ativa.' },
} satisfies Record<string, Recurso>;
export type RecursoId = keyof typeof recursos;
export function statusDosRecursos(ids: readonly RecursoId[]): StatusRecurso {
    return ids.some(id => recursos[id].status === 'em_breve') ? 'em_breve' : 'disponivel';
}
/** A comparação de valor só aparece quando todos os itens dela estão disponíveis (não vende com o que é Em breve). */
export function ancoraExibivel(itens: readonly { recursos: RecursoId[] }[]): boolean {
    return itens.every(item => statusDosRecursos(item.recursos) === 'disponivel');
}
export type ItemPlano = { texto: string; recursos: RecursoId[]; excluido?: boolean; introducao?: boolean };
export type Plano = { id: PlanoComercialId; nome: string; descricao: string; mensalCentavos: number; destaque?: boolean; itens: ItemPlano[] };
export const comercial = condicoesComerciais;
export const planos: Plano[] = [
    { id: 'essencial', ...planosComerciais.essencial, descricao: 'Organize. Para sair do caderno e da planilha.', itens: [
        { texto: 'Até 3 usuários', recursos: ['permissoes'] },
        { texto: 'Agenda, clientes, festas e pacotes', recursos: ['agenda', 'clientes', 'festas'] },
        { texto: 'Contrato com o seu modelo', recursos: ['contratos'] },
        { texto: 'Assinatura do contrato com código pelo WhatsApp', recursos: ['assinatura_whatsapp'] },
        { texto: 'Pix copia e cola e contas a receber', recursos: ['pix', 'financeiro'] },
        // Horário nobre e adicionais não têm barreira por plano (lib/assinatura/recursos-plano.ts): valem em todos.
        { texto: 'Horário nobre e adicionais na cotação', recursos: ['horarios'] },
        { texto: 'Importação por IA na implantação: até 5 documentos (tabela de preços e contratos antigos)', recursos: ['importacao_precos', 'importacao_contratos'] },
        // 01/11/2026 (D-PL-3): IA que ajuda o dono entra em todos os planos; os tamanhos das franquias só vão ao site depois do piloto.
        { texto: 'Copiloto de IA, franquia básica', recursos: ['copiloto'] },
        { texto: 'Convite da festa com IA, franquia básica', recursos: ['convite'] },
        { texto: 'Suporte por e-mail', recursos: ['suporte'] },
        { texto: 'Financeiro completo', recursos: ['financeiro'], excluido: true },
        { texto: 'Orçamento online', recursos: ['orcamento'], excluido: true },
        // 01/11/2026 (D-PL-1): o atendimento por IA no WhatsApp não entra no Essencial, nem como adicional.
        { texto: 'Wall-e no WhatsApp', recursos: ['walle_whatsapp'], excluido: true },
    ] },
    { id: 'profissional', ...planosComerciais.profissional, descricao: 'Venda mais. Caixa completo e uma equipe maior no sistema.', destaque: true, itens: [
        { texto: 'Tudo do Essencial, mais:', recursos: [], introducao: true },
        { texto: 'Até 10 usuários', recursos: ['permissoes'] },
        { texto: 'Orçamento online pela página do buffet', recursos: ['orcamento'] },
        { texto: 'Financeiro completo: contas a pagar, fluxo de caixa e relatórios', recursos: ['financeiro'] },
        { texto: 'Importação por IA sempre que precisar: até 10 documentos por mês', recursos: ['importacao_precos', 'importacao_contratos'] },
        { texto: 'Copiloto de IA, franquia maior', recursos: ['copiloto'] },
        { texto: 'Convite da festa com IA, franquia maior', recursos: ['convite'] },
        { texto: 'Wall-e no WhatsApp como adicional', recursos: ['walle_whatsapp'] },
    ] },
    { id: 'premium', ...planosComerciais.premium, descricao: 'Atenda 24 h. Para buffets com equipe grande e implantação acompanhada de perto.', itens: [
        { texto: 'Tudo do Profissional, mais:', recursos: [], introducao: true },
        { texto: 'Usuários ilimitados', recursos: ['permissoes'] },
        { texto: 'Importação por IA: até 30 documentos por mês', recursos: ['importacao_precos', 'importacao_contratos'] },
        { texto: 'Copiloto de IA, franquia ampla', recursos: ['copiloto'] },
        { texto: 'Convite da festa com IA, franquia ampla', recursos: ['convite'] },
        { texto: 'Wall-e no WhatsApp com franquia incluída', recursos: ['walle_whatsapp'] },
        // 19/10: suporte só por e-mail por enquanto (decisão de Felipe); a prioridade é na fila de resposta.
        { texto: 'Suporte prioritário por e-mail', recursos: ['suporte'] },
        { texto: 'Implantação dedicada, com a conexão do seu WhatsApp', recursos: ['implantacao', 'walle_whatsapp'] },
    ] },
];
export const adicionais: { nome: string; recursos: RecursoId[]; centavos: number | null; periodo: string; descricao: string }[] = [
    { nome: 'Unidade extra', recursos: ['multiunidade'], centavos: 14700, periodo: '/mês', descricao: 'Outra unidade da operação, com condições próprias. Salões na mesma unidade são organizados na agenda.' },
    { nome: 'Wall-e no WhatsApp', recursos: ['walle_whatsapp'], centavos: 19700, periodo: '/mês', descricao: 'Para o Profissional, com franquia de conversas. Quando a franquia acaba, a conversa passa para a sua equipe; nada é cobrado por uso sem você comprar um pacote.' },
    { nome: 'Créditos extras de IA', recursos: ['copiloto', 'importacao_contratos'], centavos: null, periodo: '', descricao: 'Para quem usa o copiloto e a importação além da franquia do plano. Condições a definir.' },
    { nome: 'Implantação assistida', recursos: ['implantacao', 'importacao_precos', 'importacao_contratos'], centavos: 99000, periodo: 'avulsa · grátis no plano anual', descricao: 'Nossa equipe importa sua tabela de preços e seus contratos, configura os pacotes e treina a sua equipe.' },
];
export const ancora: { nome: string; centavos: number; recursos: RecursoId[] }[] = [
    { nome: 'Agenda e clientes', centavos: 9700, recursos: ['agenda', 'clientes'] },
    { nome: 'Contratos digitais', centavos: 9700, recursos: ['contratos'] },
    { nome: 'Financeiro', centavos: 9700, recursos: ['financeiro'] },
    { nome: 'Orçamento online', centavos: 6700, recursos: ['orcamento'] },
    { nome: 'Inteligência artificial', centavos: 14700, recursos: ['copiloto', 'importacao_precos', 'importacao_contratos'] },
    { nome: 'Wall-e no WhatsApp', centavos: 19700, recursos: ['walle_whatsapp'] },
];
export type Ciclo = 'mensal' | 'anual';
export function valorPlano(plano: Plano, ciclo: Ciclo, fundador = false): number {
    return valorComercial(plano.id, ciclo, fundador);
}
export function precoExibido(centavos: number | null, publicado: boolean): string {
    return !publicado ? 'Preço a definir' : centavos === null ? 'A definir' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: centavos % 100 ? 2 : 0 }).format(centavos / 100);
}
