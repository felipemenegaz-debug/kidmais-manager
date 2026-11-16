import { condicoesComerciais, planosComerciais, valorComercial, type PlanoComercialId } from '../assinatura/planos-comerciais.ts';
import { dias } from '../assinatura/texto.ts';
/**
 * Fonte única da vitrine (/conheca e /planos). Regra de 15/11/2026 (Felipe): não existe selo "Em breve".
 * Cada recurso aparece no site só com evidência de estar LIVE em production; o resto não aparece.
 * "Recurso disponível" (este catálogo) é separado de "incluído no plano" (itens de cada plano).
 * Topo, painéis, abas, fluxo, planos e dúvidas leem daqui. Na dúvida, o recurso fica oculto e vai para a lista de Felipe.
 * `termos`: palavras que denunciam a promessa no texto da página. Todo recurso tem termos: o teste de lançamento oculta cada um
 * por vez e falha se algum termo continuar na página (topo, demos, painéis, planos, dúvidas e metadata).
 */
export type StatusRecurso = 'disponivel' | 'oculto';
type Recurso = { nome: string; status: StatusRecurso; evidencia: string; termos: readonly string[] };

export const recursos = {
    agenda: { nome: 'Agenda e datas livres', status: 'disponivel', termos: ['agenda', 'data livre', 'datas livres'], evidencia: 'Núcleo do sistema em production desde a V1; production 8e18941e (PR #414, 15/11/2026).' },
    clientes: { nome: 'Clientes e aniversariantes', status: 'disponivel', termos: ['aniversariantes', 'histórico de cada cliente'], evidencia: 'Núcleo do sistema em production desde a V1; production 8e18941e (15/11/2026).' },
    festas: { nome: 'Festas e pacotes', status: 'disponivel', termos: ['pacote'], evidencia: 'Núcleo do sistema em production; pacotes P_ LIVE em production (nota "Disponibilidade pacotes 20261022").' },
    contratos: { nome: 'Contrato com o modelo do buffet', status: 'disponivel', termos: ['contrato'], evidencia: 'Contratos LIVE em production; tela simplificada fases 1+2 LIVE em production (23/10/2026).' },
    assinatura_codigo: { nome: 'Assinatura do contrato por código', status: 'disponivel', termos: ['por código', 'assinatura do contrato', 'assinado', 'aguardando assinatura', 'aceitar e assinar'], evidencia: 'Código por WhatsApp com reserva por e-mail: PR #414 LIVE em production 8e18941e, reserva ligada e provada em production em 15/11/2026 (PEDIDO_CLIENTE 14:38Z).' },
    horarios: { nome: 'Horário nobre e adicionais na cotação', status: 'disponivel', termos: ['horário nobre', 'horário promocional', 'adicionais'], evidencia: 'Fechamento com horários e adicionais: PR #358 LIVE em production a56fa0f2 (08/11/2026), conferido logado.' },
    pix: { nome: 'Parcelas com Pix copia e cola', status: 'disponivel', termos: ['pix'], evidencia: 'Pix copia e cola com a chave do buffet em production desde a V1; production 8e18941e.' },
    financeiro: { nome: 'Contas a receber', status: 'disponivel', termos: ['recebimento', 'dar baixa', 'dá baixa', 'a receber', 'recebida'], evidencia: 'Financeiro P1 (recebimento parcial e data real da baixa) LIVE em staging e production (nota "Evolucao financeiro basico e avancado 20261106").' },
    exportacao: { nome: 'Exportação dos dados', status: 'disponivel', termos: ['exporta'], evidencia: 'Rota app/api/admin/exportacao e lib/exportacao presentes em production 8e18941e, sem trava de ambiente (conferido em 15/11/2026).' },
    permissoes: { nome: 'Papéis e usuários', status: 'disponivel', termos: ['usuários', 'papéis', 'próprio acesso', 'próprio login', 'sua equipe', 'equipe maior', 'equipe grande', 'limite de equipe', 'sem limite'], evidencia: 'Gestão e equipe com acessos próprios em production; limites por plano em lib/assinatura/planos-comerciais.ts.' },
    convite: { nome: 'Convite da festa com IA', status: 'disponivel', termos: ['convite'], evidencia: 'Convites V1 LIVE em production (b736fb2, 17/10/2026); CONVITES_ENABLED e CONVITES_IA_ENABLED=true em production (nota "Variaveis production 20261112"); convite pronto E-CP1 LIVE em production.' },
    ajuda: { nome: 'Central de ajuda e vídeos', status: 'disponivel', termos: ['central de ajuda', 'vídeos'], evidencia: 'Central de ajuda LIVE em production por recorte auditado (03/11/2026); 3 vídeos piloto LIVE em production.' },
    suporte: { nome: 'Suporte por e-mail', status: 'disponivel', termos: ['suporte'], evidencia: 'Decisão de Felipe (19/10/2026): suporte só por e-mail; canal em SITE_ATENDIMENTO_EMAIL.' },
    implantacao: { nome: 'Implantação guiada', status: 'disponivel', termos: ['implantação'], evidencia: 'Serviço humano, incluído em todos os planos e sem cobrança (decisão de Felipe, 15/11/2026).' },

    orcamento: { nome: 'Orçamento online', status: 'oculto', termos: ['orçamento online', 'página do buffet', 'monta o orçamento sozinho'], evidencia: 'COTACAO_PUBLICA_POR_EMPRESA desligada em production. Ligar antes da venda (lista de Felipe).' },
    agenda_saloes: { nome: 'Agenda por salão', status: 'oculto', termos: ['por salão', 'mais de um salão', 'salões'], evidencia: 'AGENDA_MAIS_DE_UM_SALAO desligada em production (um salão; nota "Variaveis production 20261112").' },
    financeiro_completo: { nome: 'Financeiro completo', status: 'oculto', termos: ['financeiro completo', 'contas a pagar', 'fluxo de caixa', 'caixa completo'], evidencia: 'P2 fase A/B só em PRs para staging (#381/#388), sem merge; 120/121 não aplicadas.' },
    marketing: { nome: 'Marketing e site do buffet', status: 'oculto', termos: ['marketing', 'site do buffet', 'campanha'], evidencia: 'MARKETING_* desligadas em production; #417 só em staging (15/11/2026).' },
    importacao: { nome: 'Importação por IA', status: 'oculto', termos: ['importação', 'importa', 'a ia lê'], evidencia: 'Importação de contratos por IA desligada em production (nota "Variaveis production 20261112").' },
    copiloto: { nome: 'Copiloto', status: 'oculto', termos: ['copiloto'], evidencia: 'Modelo do copiloto desligado em production; só a leitura determinística está ligada.' },
    mcp: { nome: 'ChatGPT e Claude', status: 'oculto', termos: ['chatgpt', 'claude'], evidencia: 'MCP_ENABLED=true só para empresas da allowlist; experiência #389 aberta para staging, sem merge.' },
    familia: { nome: 'Área da família', status: 'oculto', termos: ['área da família', 'minha festa'], evidencia: 'F1+F2 só em staging com a trava desligada; F3 local (nota "Kidmais área da família 14/11").' },
    pesquisa: { nome: 'Pesquisa de satisfação', status: 'oculto', termos: ['pesquisa de satisfação', 'pós-festa'], evidencia: 'SATISFACAO_* desligadas em production (rotas /p respondem 503); #391 só em staging.' },
    mensagens: { nome: 'Mensagens programadas', status: 'oculto', termos: ['mensagens programadas', 'mensagem programada'], evidencia: 'Transporte só "simulado"; não há envio real implementado (nota "Variaveis production 20261112").' },
    logo_convite: { nome: 'Logo do buffet no convite', status: 'oculto', termos: ['logo do buffet no convite'], evidencia: '#421 LIVE só em staging; production pendente.' },
    marca: { nome: 'Marca do buffet nas telas e PDFs', status: 'oculto', termos: ['marca do seu buffet', 'sua logo', 'nos pdfs'], evidencia: '#361 LIVE só em staging; production só com o R-5.' },
    walle_whatsapp: { nome: 'Wall-e no WhatsApp', status: 'oculto', termos: ['wall-e'], evidencia: 'Envio real e WhatsApp multiempresa ainda não em production.' },
    multiunidade: { nome: 'Unidade extra', status: 'oculto', termos: ['unidade extra'], evidencia: 'Sem fluxo para contratar, cobrar ou provisionar unidade extra (docs/MATRIZ_RECURSOS_PLANOS_20261010.md).' },
    creditos: { nome: 'Créditos extras de IA', status: 'oculto', termos: ['créditos', 'franquia'], evidencia: 'CREDITOS_* com catálogo oculto e sem compra em production.' },
    cartao: { nome: 'Cartão de crédito nas parcelas', status: 'oculto', termos: ['parcelas no cartão', 'cartão de crédito nas parcelas', 'pagar com cartão'], evidencia: 'Depende da conexão Asaas da conta do buffet; não comprovada.' },
} satisfies Record<string, Recurso>;
export type RecursoId = keyof typeof recursos;

/** Um bloco aparece só quando todos os recursos dele estão disponíveis. Lista vazia = texto institucional, sempre visível. */
export function visivel(ids: readonly RecursoId[]): boolean {
    return ids.every(id => recursos[id].status === 'disponivel');
}
export function filtrar<T extends { recursos: readonly RecursoId[] }>(itens: readonly T[]): T[] {
    return itens.filter(item => visivel(item.recursos));
}

export type ItemPlano = { texto: string; recursos: RecursoId[]; excluido?: boolean; introducao?: boolean };
export type Plano = {
    id: PlanoComercialId; nome: string; mensalCentavos: number; destaque?: boolean; itens: ItemPlano[];
    /** Linha comercial completa; só vale quando os recursos dela estão disponíveis. */
    descricao: string; descricaoRecursos: RecursoId[];
    /** Linha usada enquanto algum recurso da descrição completa está oculto; só vale com os recursos dela disponíveis. */
    descricaoAtual: string; descricaoAtualRecursos: RecursoId[];
    /** Última linha: não promete recurso nenhum. */
    descricaoMinima: string;
};
export const comercial = condicoesComerciais;
export const planos: Plano[] = [
    { id: 'essencial', ...planosComerciais.essencial, descricao: 'Organize. Para sair do caderno e da planilha.', descricaoRecursos: [], descricaoAtual: 'Organize. Para sair do caderno e da planilha.', descricaoAtualRecursos: [], descricaoMinima: 'Organize. Para sair do caderno e da planilha.', itens: [
        { texto: 'Até 3 usuários', recursos: ['permissoes'] },
        { texto: 'Agenda, clientes, festas e pacotes', recursos: ['agenda', 'clientes', 'festas'] },
        { texto: 'Contrato com o seu modelo', recursos: ['contratos'] },
        { texto: 'Assinatura do contrato por código, sem aplicativo', recursos: ['contratos', 'assinatura_codigo'] },
        { texto: 'Pix copia e cola e contas a receber', recursos: ['pix', 'financeiro'] },
        // Horário nobre e adicionais não têm barreira por plano (lib/assinatura/recursos-plano.ts): valem em todos.
        { texto: 'Horário nobre e adicionais na cotação', recursos: ['horarios'] },
        { texto: 'Convite da festa com IA', recursos: ['convite'] },
        { texto: 'Importação por IA na implantação: até 5 documentos (tabela de preços e contratos antigos)', recursos: ['importacao'] },
        // 01/11/2026 (D-PL-3): IA que ajuda o dono entra em todos os planos; os tamanhos das franquias só vão ao site depois do piloto.
        { texto: 'Copiloto de IA, franquia básica', recursos: ['copiloto'] },
        { texto: 'Central de ajuda com vídeos', recursos: ['ajuda'] },
        { texto: 'Suporte por e-mail', recursos: ['suporte'] },
        { texto: 'Implantação guiada incluída', recursos: ['implantacao'] },
        { texto: 'Financeiro completo', recursos: ['financeiro_completo'], excluido: true },
        { texto: 'Orçamento online', recursos: ['orcamento'], excluido: true },
        // 01/11/2026 (D-PL-1): o atendimento por IA no WhatsApp não entra no Essencial, nem como adicional.
        { texto: 'Wall-e no WhatsApp', recursos: ['walle_whatsapp'], excluido: true },
    ] },
    { id: 'profissional', ...planosComerciais.profissional, destaque: true, descricao: 'Venda mais. Caixa completo e uma equipe maior no sistema.', descricaoRecursos: ['financeiro_completo', 'orcamento', 'permissoes'], descricaoAtual: 'Cresça. Para buffets com uma equipe maior no sistema.', descricaoAtualRecursos: ['permissoes'], descricaoMinima: 'Cresça. Para buffets em crescimento.', itens: [
        { texto: 'Tudo do Essencial, mais:', recursos: [], introducao: true },
        { texto: 'Até 10 usuários', recursos: ['permissoes'] },
        { texto: 'Orçamento online pela página do buffet', recursos: ['orcamento'] },
        { texto: 'Financeiro completo: contas a pagar, fluxo de caixa e relatórios', recursos: ['financeiro_completo'] },
        { texto: 'Marketing, site do buffet e automação', recursos: ['marketing'] },
        { texto: 'Importação por IA sempre que precisar: até 10 documentos por mês', recursos: ['importacao'] },
        { texto: 'Copiloto de IA, franquia maior', recursos: ['copiloto'] },
        { texto: 'Convite da festa com IA, franquia maior', recursos: ['convite', 'creditos'] },
        { texto: 'Wall-e no WhatsApp como adicional', recursos: ['walle_whatsapp'] },
    ] },
    { id: 'premium', ...planosComerciais.premium, descricao: 'Atenda 24 h. Para buffets com equipe grande e implantação acompanhada de perto.', descricaoRecursos: ['walle_whatsapp', 'permissoes', 'implantacao'], descricaoAtual: 'Sem limite de equipe. Para buffets grandes.', descricaoAtualRecursos: ['permissoes'], descricaoMinima: 'Para buffets grandes.', itens: [
        { texto: 'Tudo do Profissional, mais:', recursos: [], introducao: true },
        { texto: 'Usuários ilimitados', recursos: ['permissoes'] },
        { texto: 'Importação por IA: até 30 documentos por mês', recursos: ['importacao'] },
        { texto: 'Copiloto de IA, franquia ampla', recursos: ['copiloto'] },
        { texto: 'Convite da festa com IA, franquia ampla', recursos: ['convite', 'creditos'] },
        // 13/11/2026 (D-OF-1): incluído com uso justo, sem número de conversas até medir.
        { texto: 'Wall-e no WhatsApp incluído, com uso justo', recursos: ['walle_whatsapp'] },
        // 19/10: suporte só por e-mail por enquanto (decisão de Felipe); a prioridade é na fila de resposta.
        { texto: 'Suporte prioritário por e-mail', recursos: ['suporte'] },
        { texto: 'Implantação dedicada, com a conexão do seu WhatsApp', recursos: ['implantacao', 'walle_whatsapp'] },
    ] },
];
export function descricaoPlano(plano: Plano): string {
    if (visivel(plano.descricaoRecursos)) return plano.descricao;
    return visivel(plano.descricaoAtualRecursos) ? plano.descricaoAtual : plano.descricaoMinima;
}
/** Implantação não é adicional pago (15/11/2026): está incluída em todos os planos. */
export const adicionais: { nome: string; recursos: RecursoId[]; centavos: number | null; periodo: string; descricao: string }[] = [
    { nome: 'Unidade extra', recursos: ['multiunidade'], centavos: 14700, periodo: '/mês', descricao: 'Outra unidade da operação, com condições próprias.' },
    { nome: 'Wall-e no WhatsApp', recursos: ['walle_whatsapp'], centavos: 19700, periodo: '/mês', descricao: 'Para o Profissional, com uso justo. Quando um limite é atingido, a conversa passa para a sua equipe, sem cobrança extra.' },
    { nome: 'Créditos extras de IA', recursos: ['creditos', 'copiloto'], centavos: null, periodo: '', descricao: 'Para quem usa a IA além do que o plano inclui. Condições a definir.' },
];

/** Painéis interativos da seção "Toque e veja como funciona". */
export type PainelId = 'orcamento' | 'assinatura' | 'convite' | 'parcelas' | 'ajuda' | 'marca';
export const paineis: { id: PainelId; recursos: RecursoId[] }[] = [
    { id: 'orcamento', recursos: ['orcamento'] },
    { id: 'assinatura', recursos: ['assinatura_codigo', 'contratos'] },
    { id: 'convite', recursos: ['convite'] },
    { id: 'parcelas', recursos: ['pix', 'financeiro'] },
    { id: 'ajuda', recursos: ['ajuda'] },
    { id: 'marca', recursos: ['marca', 'logo_convite'] },
];

/** Abas de módulos (substituem o carrossel de capturas). Telas de exemplo com dados fictícios. */
export type Modulo = { id: string; nome: string; titulo: string; texto: string; itens: string[]; tela: [string, string][]; recursos: RecursoId[] };
export const modulos: Modulo[] = [
    { id: 'agenda', nome: 'Agenda e festas', recursos: ['agenda', 'festas', 'clientes'], titulo: 'Todas as datas e festas num lugar só.', texto: 'A agenda mostra o que está livre e o que já foi vendido. Cada festa guarda o cliente, o pacote e o horário.',
        itens: ['Datas livres e ocupadas na mesma tela', 'Pacotes com faixas de convidados', 'Aniversariantes e histórico de cada cliente'],
        tela: [['sáb 13 · 15h', 'Sofia, 6 anos'], ['sáb 13 · 19h', 'livre'], ['dom 14 · 15h', 'Miguel, 4 anos'], ['sáb 20 · 15h', 'Helena, 5 anos']] },
    { id: 'contratos', nome: 'Contratos', recursos: ['contratos', 'assinatura_codigo'], titulo: 'O seu modelo de contrato, preenchido sozinho.', texto: 'Os dados da festa entram nos campos do seu modelo. O cliente confere pelo celular e assina com um código.',
        itens: ['Seu texto jurídico, com campos automáticos', 'Assinatura por código, sem aplicativo', 'PDF de cada contrato guardado na festa'],
        tela: [['Contrato 0142 · Sofia', 'assinado'], ['Contrato 0143 · Miguel', 'aguardando assinatura'], ['Contrato 0144 · Helena', 'rascunho']] },
    { id: 'financeiro', nome: 'Recebimentos', recursos: ['pix', 'financeiro'], titulo: 'Cada parcela no seu lugar.', texto: 'Cada parcela da festa tem Pix copia e cola na chave da sua empresa. Você dá baixa com a data real do pagamento.',
        itens: ['Recebimento parcial e data real da baixa', 'O que vence esta semana', 'Dinheiro direto na conta do buffet'],
        tela: [['Recebido em março', 'R$ 18.400,00'], ['A receber em março', 'R$ 9.650,00'], ['Vence esta semana', '3 parcelas']] },
    { id: 'convites', nome: 'Convites', recursos: ['convite'], titulo: 'O convite sai da própria festa.', texto: 'A família escolhe um modelo, usa uma foto ou pede uma arte à IA. Os convidados confirmam presença pelo link.',
        itens: ['Modelos prontos, foto ou arte por IA', 'Convidados confirmam sem criar conta', 'Adultos e crianças por família'],
        tela: [['Confirmados', '14 famílias'], ['Adultos · crianças', '26 · 19'], ['Aguardando resposta', '6 famílias']] },
    { id: 'equipe', nome: 'Equipe e dados', recursos: ['permissoes', 'exportacao'], titulo: 'Cada um com o próprio acesso.', texto: 'A Gestão cuida da empresa e das configurações. A equipe opera com o próprio login. Os dados podem ser exportados quando você quiser.',
        itens: ['Gestão e equipe com papéis diferentes', 'Acesso individual, sem senha compartilhada', 'Exportação dos dados da empresa'],
        tela: [['Carla', 'Gestão'], ['Rafael', 'Equipe'], ['Exportação', 'pronta para baixar']] },
    { id: 'saloes', nome: 'Agenda por salão', recursos: ['agenda_saloes'], titulo: 'Mais de um salão. A mesma unidade, organizada.', texto: 'Cada espaço recebe uma festa por vez, com horários, intervalos de preparo e bloqueios.',
        itens: ['Disponibilidade por salão', 'Intervalo para preparar a próxima festa', 'Conflito conferido antes de confirmar'],
        tela: [['Salão Principal · sáb 15h', 'Sofia, 6 anos'], ['Espaço Jardim · sáb 15h', 'Miguel, 4 anos']] },
    { id: 'financeiro-completo', nome: 'Financeiro completo', recursos: ['financeiro_completo'], titulo: 'Da parcela do cliente ao caixa do buffet.', texto: 'Contas a receber e a pagar, fluxo de caixa e relatórios ligados aos contratos.',
        itens: ['Despesas por categoria', 'Fluxo de caixa', 'Custos por evento'], tela: [['Entradas do mês', 'R$ 42.300,00'], ['Saídas do mês', 'R$ 17.850,00']] },
    { id: 'marketing', nome: 'Marketing e site', recursos: ['marketing'], titulo: 'Da campanha nas redes à próxima festa.', texto: 'O site do buffet com a sua marca, links rastreáveis para cada campanha e automações para retomar propostas paradas.',
        itens: ['Site com fotos e pacotes', 'Um link para cada campanha', 'Do clique ao contrato, por origem'], tela: [['Instagram · Dia das Crianças', '38 contatos']] },
    { id: 'importacao', nome: 'Importação por IA', recursos: ['importacao'], titulo: 'Seu buffet já tem história. Traga ela para o iA.Fest.', texto: 'A IA lê a tabela de preços, o modelo de contrato e os contratos já vendidos. Você revisa antes de aplicar.',
        itens: ['Pacotes e adicionais', 'Modelo de contrato', 'Festas antigas'], tela: [['tabela-2027.pdf', '3 pacotes · 12 adicionais']] },
    { id: 'copiloto', nome: 'Copiloto', recursos: ['copiloto'], titulo: 'Pergunte ao sistema como perguntaria à equipe.', texto: 'O copiloto resume a festa e mostra o que precisa da sua atenção. Ele sugere; quem decide é você.',
        itens: ['O que precisa da minha atenção hoje?'], tela: [['Hoje', '2 contratos aguardando assinatura']] },
    { id: 'mcp', nome: 'ChatGPT e Claude', recursos: ['mcp'], titulo: 'Use o assistente que você já tem.', texto: 'Conecte o ChatGPT ou o Claude à sua conta e consulte a agenda e os recebíveis por conversa. A conexão é só de leitura.',
        itens: ['Quais festas tenho no sábado?'], tela: [['Você', 'Quais festas tenho no sábado?']] },
    { id: 'familia', nome: 'Área da família', recursos: ['familia'], titulo: 'Tudo o que a família precisa, num link.', texto: 'O contratante acompanha contrato, parcelas e convite da própria festa.',
        itens: ['Sem senha e sem aplicativo'], tela: [['Contrato', 'assinado']] },
    { id: 'pesquisa', nome: 'Pesquisa de satisfação', recursos: ['pesquisa'], titulo: 'Saiba como foi cada festa.', texto: 'Depois do evento, a família responde uma pesquisa curta pelo celular.',
        itens: ['Notas e comentários por evento'], tela: [['Média do mês', '4,8 de 5']] },
];

/** "Uma festa, do pedido ao ...": cada passo só aparece com os recursos dele disponíveis. */
export const passos: { quem: 'Cliente' | 'Você' | 'Automático'; titulo: string; texto: string; recursos: RecursoId[] }[] = [
    { quem: 'Cliente', titulo: 'Pede o orçamento', texto: 'Pela página do buffet, com as datas livres.', recursos: ['orcamento'] },
    { quem: 'Você', titulo: 'Fecha a festa', texto: 'Data livre, pacote, horário e adicionais, com o total pelos seus preços.', recursos: ['agenda', 'festas', 'horarios'] },
    { quem: 'Cliente', titulo: 'Assina por código', texto: 'Confere o contrato no celular e confirma com o código recebido.', recursos: ['contratos', 'assinatura_codigo'] },
    { quem: 'Cliente', titulo: 'Paga as parcelas', texto: 'Pix copia e cola, direto na conta do buffet.', recursos: ['pix'] },
    { quem: 'Cliente', titulo: 'Convida os amigos', texto: 'Cria o convite e acompanha as confirmações de presença.', recursos: ['convite'] },
    { quem: 'Você', titulo: 'Acompanha os recebimentos', texto: 'Dá baixa nas parcelas, inclusive pagamentos parciais, com a data real.', recursos: ['financeiro'] },
    { quem: 'Automático', titulo: 'Cuida do pós-festa', texto: 'Agradecimento e pesquisa de satisfação para a família.', recursos: ['mensagens', 'pesquisa'] },
];
export function tituloFluxo(): string {
    return visivel(['mensagens', 'pesquisa']) ? 'Uma festa, do pedido ao pós-festa.' : 'Uma festa, do fechamento ao dia da festa.';
}

export const confianca: { titulo: string; texto: string; recursos: RecursoId[] }[] = [
    { titulo: 'Feito dentro de um buffet', texto: 'O iA.Fest nasceu na operação de um buffet infantil, que usa o sistema todos os dias.', recursos: [] },
    { titulo: 'Nenhum pagamento passa pelo iA.Fest', texto: 'O Pix usa a chave da sua empresa. Não há taxa sobre as festas.', recursos: ['pix'] },
    { titulo: 'Exportação a qualquer hora', texto: 'Os dados da sua empresa podem ser exportados quando você quiser.', recursos: ['exportacao'] },
    { titulo: 'Cada um no seu papel', texto: 'A Gestão cuida da empresa e das configurações. A equipe opera com o próprio acesso.', recursos: ['permissoes'] },
];

/** Roteiro fixo da conversa de exemplo do Wall-e (sem IA na página). */
export const roteiroWallE: { pergunta: string; respostas: string[]; passagem?: string }[] = [
    { pergunta: 'Tem data dia 13 à tarde?', respostas: ['Sábado, dia 13, está livre às 15h. Para quantos convidados é a festa?'] },
    { pergunta: 'Quanto fica para 40 convidados?', respostas: ['O Pacote Diversão atende até 40 convidados: R$ 5.200,00 no horário nobre.', 'Quer que eu envie o orçamento para conferir?'] },
    { pergunta: 'Dá para visitar o espaço?', respostas: ['Claro! Vou chamar a Carla, do atendimento, para combinar o horário com você.'], passagem: 'Wall-e passou a conversa para a Carla' },
];

export type Pergunta = { pergunta: string; resposta: string; recursos: RecursoId[] };
export function perguntas(teste = dias(condicoesComerciais.testeDias)): Pergunta[] {
    return [
        { pergunta: 'Preciso cadastrar cartão para testar?', resposta: `Não. São ${teste} grátis, sem cartão. Se não assinar, a conta fica em somente leitura e seus dados podem ser exportados.`, recursos: ['exportacao'] },
        { pergunta: 'O iA.Fest recebe o pagamento dos meus clientes?', resposta: 'Não. O Pix usa a chave da sua empresa e o dinheiro cai direto na sua conta.', recursos: ['pix'] },
        { pergunta: 'Meu cliente precisa instalar algum aplicativo?', resposta: 'Não. Contrato, parcelas e convite abrem por link, no navegador do celular.', recursos: ['contratos', 'assinatura_codigo', 'convite'] },
        { pergunta: 'Já tenho tabela de preços e contratos em PDF. Perco o que fiz?', resposta: 'Não. A IA lê os PDFs e prepara pacotes, contratos e festas já vendidas. Você revisa antes de aplicar.', recursos: ['importacao'] },
        { pergunta: 'O que é o Wall-e?', resposta: 'O atendente de IA do buffet no WhatsApp. Ele responde com a sua agenda e os seus preços e passa a conversa para a equipe quando precisa.', recursos: ['walle_whatsapp'] },
        { pergunta: 'Posso usar o ChatGPT ou o Claude com o iA.Fest?', resposta: 'Sim. Você conecta o assistente que já usa e consulta a agenda e os recebíveis do buffet por conversa. Ele só lê; não altera nada.', recursos: ['mcp'] },
        { pergunta: 'A implantação é cobrada?', resposta: 'Não. A implantação guiada está incluída em todos os planos.', recursos: ['implantacao'] },
        { pergunta: 'Posso cancelar quando quiser?', resposta: 'Sim, pelos mesmos canais de atendimento. Seus dados continuam disponíveis para exportação conforme os termos de uso.', recursos: ['exportacao'] },
    ];
}

export type Ciclo = 'mensal' | 'anual';
export function valorPlano(plano: Plano, ciclo: Ciclo, fundador = false): number {
    return valorComercial(plano.id, ciclo, fundador);
}
export function precoExibido(centavos: number | null, publicado: boolean): string {
    return !publicado ? 'Preço a definir' : centavos === null ? 'A definir' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: centavos % 100 ? 2 : 0 }).format(centavos / 100);
}
/** Calculadora "custo por festa": rateio só da mensalidade regular (sem Fundador, sem adicionais). */
export function custoPorFesta(plano: Plano, festasPorMes: number): number {
    const festas = Math.min(40, Math.max(2, Math.round(festasPorMes)));
    return Math.round(plano.mensalCentavos / festas);
}
