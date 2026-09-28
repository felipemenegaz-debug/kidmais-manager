import type { ArquivoSelecionado, ExtracaoContrato } from "./modelo.ts";

/**
 * DEMO ADAPTER — NÃO É EXTRAÇÃO REAL.
 *
 * Devolve sempre o mesmo contrato fictício, apenas para demonstrar a UX de revisão e o Human Gate.
 * O arquivo selecionado não é lido, não é enviado a nenhum serviço e não sai do navegador;
 * só nome, tipo e tamanho são exibidos. Nenhum dado aqui corresponde a cliente real.
 *
 * Substituir por um Import Engine validado (com fonte própria em `ExtracaoContrato.fonte`)
 * antes de qualquer uso fora de demonstração.
 */
export function demoContractExtraction(arquivo: ArquivoSelecionado): ExtracaoContrato {
  return {
    fonte: "DEMONSTRACAO",
    arquivo: { nome: arquivo.nome, tipo: arquivo.tipo, tamanhoBytes: arquivo.tamanhoBytes },
    secoes: [
      {
        id: "contratante",
        titulo: "Contratante",
        campos: [
          { id: "contratante.nome", rotulo: "Nome", valor: "Mariana Souza Lima", estado: "ENCONTRADO", origem: "Página 1 · Qualificação das partes" },
          { id: "contratante.cpf", rotulo: "CPF", valor: "123.456.789-09", estado: "ENCONTRADO", origem: "Página 1 · Qualificação das partes" },
          { id: "contratante.telefone", rotulo: "Telefone", valor: "(11) 98765-4321", estado: "ENCONTRADO", origem: "Página 1 · Qualificação das partes" },
          { id: "contratante.email", rotulo: "E-mail", valor: null, estado: "NAO_ENCONTRADO", motivo: "O contrato não informa e-mail. Pode ser completado depois no cadastro." },
        ],
      },
      {
        id: "evento",
        titulo: "Evento",
        campos: [
          { id: "evento.data", rotulo: "Data", valor: "21/11/2026", estado: "ENCONTRADO", origem: "Página 1 · Cláusula 2" },
          { id: "evento.horario", rotulo: "Horário", valor: "14:00 às 18:00", estado: "ENCONTRADO", origem: "Página 1 · Cláusula 2" },
          { id: "evento.aniversariante", rotulo: "Aniversariante", valor: "Lucas", estado: "ENCONTRADO", origem: "Página 1 · Cláusula 2" },
          { id: "evento.idade", rotulo: "Idade", valor: "6 anos", estado: "PRECISA_REVISAO", origem: "Página 1 · Anotação manuscrita", motivo: "Escrito à mão. Confirme a leitura." },
          { id: "evento.convidados", rotulo: "Convidados", valor: "80", estado: "ENCONTRADO", origem: "Página 1 · Cláusula 2" },
        ],
      },
      {
        id: "pacote",
        titulo: "Pacote",
        nota: "Mantido exatamente como no contrato. Não é substituído pelo pacote atual do catálogo.",
        campos: [
          { id: "pacote.nome", rotulo: "Pacote original", valor: "Festa Completa — tabela 2025", estado: "PRECISA_REVISAO", origem: "Página 1 · Cláusula 3", motivo: "O nome não corresponde a um pacote atual. Será preservado como histórico." },
          { id: "pacote.itens", rotulo: "Itens originais", valor: "Salão exclusivo, 4 monitores, decoração temática, brinquedos", estado: "ENCONTRADO", origem: "Página 1 · Cláusula 3" },
          { id: "pacote.duracao", rotulo: "Duração", valor: "4 horas", estado: "ENCONTRADO", origem: "Página 1 · Cláusula 3" },
        ],
      },
      {
        id: "buffet",
        titulo: "Buffet",
        campos: [
          { id: "buffet.cardapio", rotulo: "Cardápio", valor: "Salgados, mini-hambúrguer, doces, bolo de 3 kg, bebidas não alcoólicas", estado: "ENCONTRADO", origem: "Página 2 · Anexo I" },
          { id: "buffet.restricoes", rotulo: "Restrições alimentares", valor: "Sem lactose para 2 crianças", estado: "PRECISA_REVISAO", origem: "Página 2 · Anotação manuscrita", motivo: "Anotação à margem. Confirme se faz parte do combinado." },
        ],
      },
      {
        id: "valores",
        titulo: "Valores",
        nota: "Valores do contrato original. Não são recalculados com a tabela de preços atual.",
        campos: [
          { id: "valores.pacote", rotulo: "Valor do pacote", valor: "R$ 8.400,00", estado: "ENCONTRADO", origem: "Página 2 · Cláusula 5" },
          { id: "valores.adicionais", rotulo: "Adicionais", valor: "R$ 500,00 (10 convidados extras)", estado: "ENCONTRADO", origem: "Página 2 · Cláusula 5" },
          { id: "valores.total", rotulo: "Valor contratado", valor: "R$ 8.900,00", estado: "ENCONTRADO", origem: "Página 2 · Cláusula 5" },
        ],
      },
      {
        id: "pagamentos",
        titulo: "Pagamentos previstos",
        nota: "Pagamento previsto não é pagamento recebido. Recebimentos continuam sendo registrados no Financeiro.",
        campos: [
          { id: "pagamentos.condicao", rotulo: "Condição de pagamento", valor: "Entrada + 3 parcelas via PIX", estado: "ENCONTRADO", origem: "Página 2 · Cláusula 6" },
          { id: "pagamentos.entrada", rotulo: "Entrada prevista", valor: "R$ 2.900,00 em 03/12/2025", estado: "ENCONTRADO", origem: "Página 2 · Cláusula 6" },
          { id: "pagamentos.parcelas", rotulo: "Parcelas previstas", valor: "3 × R$ 2.000,00 — 10/09, 10/10 e 10/11/2026", estado: "ENCONTRADO", origem: "Página 2 · Cláusula 6" },
          { id: "pagamentos.realizados", rotulo: "Pagamentos já realizados", valor: null, estado: "NAO_ENCONTRADO", motivo: "O contrato mostra só o combinado. Confirme os recebimentos no Financeiro." },
        ],
      },
      {
        id: "observacoes",
        titulo: "Observações",
        campos: [
          { id: "observacoes.gerais", rotulo: "Observações do contrato", valor: "Decoração em azul e dourado. Mesa de doces montada pelo buffet.", estado: "ENCONTRADO", origem: "Página 2 · Cláusula 9" },
        ],
      },
    ],
  };
}
