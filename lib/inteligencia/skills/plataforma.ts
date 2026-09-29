import type { Skill } from "./contrato.ts";

/**
 * Skills da PLATAFORMA (versionadas no código). Conteúdo de forma e atendimento — nunca autoridade.
 *
 * Revisão: escritas pelo agente de desenvolvimento nesta rodada; a revisão INDEPENDENTE está pendente
 * (docs/SEGURANCA_SKILLS.md, regra 8). Por isso estão RESTRITAS, com a restrição escrita. O `hash` e o
 * `hashRevisado` precisam ser iguais ao hash canônico do conteúdo: qualquer edição exige nova revisão
 * (o teste e o catálogo recusam a skill com hash divergente).
 */
const REVISAO_PENDENTE_INDEPENDENTE = "Revisão independente pendente: usar só em teste/staging, com a orquestradora ligada por flag.";

export const SKILLS_PLATAFORMA: readonly Skill[] = Object.freeze([
  {
    id: "tom_kidmais",
    nivel: "PLATAFORMA",
    escopo: { empresaId: null, estabelecimentoId: null },
    finalidades: ["TOM", "FORMATACAO", "ATENDIMENTO", "SUGESTAO_TEXTO"],
    capacidades: [],
    versao: "1.0.0",
    proveniencia: { origem: "INTERNA", autor: "Kidmais Intelligence", referencia: "ai-v1/03-skills" },
    revisao: { estado: "RESTRITA", revisor: "agente de desenvolvimento (autoria)", revisadoEm: "2026-09-29", hashRevisado: "324d6d440e1b048d1cd40b8e93d4dc7888c4ee595ee7f13ea32678160bcb24a4" },
    permissoes: { classes: ["READ", "SUGGEST"] },
    restricoes: [REVISAO_PENDENTE_INDEPENDENTE, "Usar só dados que vieram do sistema; sem dado, dizer que não há dados suficientes."],
    conteudo: {
      tom: "Cordial, claro e acolhedor, como uma pessoa experiente da equipe de um buffet infantil. Frases curtas, sem jargão técnico.",
      instrucoes: [
        "Responda em português do Brasil.",
        "Use somente fatos que vieram do sistema; se faltar dado, diga que não há dados suficientes.",
        "Não prometa prazos, condições ou disponibilidade que não estejam no sistema.",
        "Toda ação que muda dados é só uma proposta e depende da confirmação de uma pessoa da equipe.",
      ],
      procedimentos: [],
      objecoes: [],
      templates: [],
      formatacao: { maxParagrafos: 4, usarListas: true },
    },
    hash: "324d6d440e1b048d1cd40b8e93d4dc7888c4ee595ee7f13ea32678160bcb24a4",
  },
  {
    id: "atendimento_familias",
    nivel: "PLATAFORMA",
    escopo: { empresaId: null, estabelecimentoId: null },
    finalidades: ["ATENDIMENTO", "OBJECAO", "SUGESTAO_TEXTO"],
    capacidades: [],
    versao: "1.0.0",
    proveniencia: { origem: "INTERNA", autor: "Kidmais Intelligence", referencia: "ai-v1/03-skills" },
    revisao: { estado: "RESTRITA", revisor: "agente de desenvolvimento (autoria)", revisadoEm: "2026-09-29", hashRevisado: "b045e8eae69b5823fa5c17a28e5fb84ebe8532c98763c98f39eb938e1b620373" },
    permissoes: { classes: ["READ", "SUGGEST"] },
    restricoes: [REVISAO_PENDENTE_INDEPENDENTE, "Textos são rascunhos para a equipe revisar; nada é enviado automaticamente."],
    conteudo: {
      tom: null,
      instrucoes: [
        "Trate a família pelo nome quando ele vier do sistema.",
        "Explique o que está incluído no pacote com base no cadastro do pacote, sem inventar itens.",
        "Condições comerciais são sempre as do contrato ou da tabela vigente no sistema.",
      ],
      procedimentos: [
        { titulo: "Primeiro contato", passos: ["Cumprimente e pergunte a data desejada, o número de convidados e a idade do aniversariante.", "Consulte a disponibilidade da data no sistema antes de sugerir um pacote.", "Registre o interesse no cadastro do cliente pela tela de Clientes."] },
      ],
      objecoes: [
        { objecao: "Está caro", resposta: "Entendo. Posso explicar com calma o que está incluído em cada pacote, para você comparar e decidir com segurança. As condições são as da tabela vigente." },
        { objecao: "Preciso pensar", resposta: "Claro! Fico à disposição para qualquer dúvida. Se quiser, envio um resumo do pacote que conversamos para você rever com calma." },
      ],
      templates: [
        { id: "follow_up_orcamento", titulo: "Retomar contato de orçamento", texto: "Olá, {{nome_cliente}}! Tudo bem? Passando para saber se ficou alguma dúvida sobre a festa de {{nome_aniversariante}} em {{data_festa}}. Estou à disposição.", marcadores: ["nome_cliente", "nome_aniversariante", "data_festa"] },
        { id: "confirmacao_agenda", titulo: "Confirmar dados da festa", texto: "Olá, {{nome_cliente}}! Confirmando a festa de {{nome_aniversariante}} em {{data_festa}}, às {{horario_festa}}, no pacote {{nome_pacote}}, para {{convidados}} convidados. Qualquer ajuste, é só avisar.", marcadores: ["nome_cliente", "nome_aniversariante", "data_festa", "horario_festa", "nome_pacote", "convidados"] },
        { id: "lembrete_valor_aberto", titulo: "Lembrete de valor em aberto", texto: "Olá, {{nome_cliente}}! Lembrando que há um valor em aberto de {{valor_em_aberto}} com vencimento em {{data_vencimento}}. Qualquer dúvida, estamos por aqui.", marcadores: ["nome_cliente", "valor_em_aberto", "data_vencimento"] },
      ],
      formatacao: { maxParagrafos: 3, usarListas: false },
    },
    hash: "b045e8eae69b5823fa5c17a28e5fb84ebe8532c98763c98f39eb938e1b620373",
  },
  {
    id: "procedimentos_operacionais",
    nivel: "PLATAFORMA",
    escopo: { empresaId: null, estabelecimentoId: null },
    finalidades: ["PROCEDIMENTO"],
    capacidades: [],
    versao: "1.0.0",
    proveniencia: { origem: "INTERNA", autor: "Kidmais Intelligence", referencia: "ai-v1/03-skills" },
    revisao: { estado: "RESTRITA", revisor: "agente de desenvolvimento (autoria)", revisadoEm: "2026-09-29", hashRevisado: "a626e6ade8b1bf8682703d7515a2babe0e5a2337987a39b570ffbe82dddfa89e" },
    permissoes: { classes: ["READ"] },
    restricoes: [REVISAO_PENDENTE_INDEPENDENTE, "Procedimentos orientam a equipe; toda operação é feita na tela correspondente."],
    conteudo: {
      tom: null,
      instrucoes: ["Indique sempre a tela onde a pessoa resolve o assunto."],
      procedimentos: [
        { titulo: "Contrato aguardando assinatura", passos: ["Abra o contrato e veja quais assinaturas faltam.", "Reenvie o link de assinatura pela tela de Contratos, se precisar."] },
        { titulo: "Festa com pendências", passos: ["Abra a festa e confira o checklist e as pendências abertas.", "Resolva cada item na própria festa e marque como concluído."] },
        { titulo: "Valor em atraso", passos: ["Confira o valor e o vencimento na tela do Financeiro.", "Converse com a família; recebimentos entram no sistema só pela tela do Financeiro, depois da transação real."] },
      ],
      objecoes: [],
      templates: [],
      formatacao: { maxParagrafos: null, usarListas: true },
    },
    hash: "a626e6ade8b1bf8682703d7515a2babe0e5a2337987a39b570ffbe82dddfa89e",
  },
]);
