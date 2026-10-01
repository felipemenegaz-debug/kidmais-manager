import type { PainelDashboard } from "@/components/admin/DashboardGeral";
import type { AmostraFinanceira } from "@/components/admin/FinanceiroTelas";

export const painelVitrine: PainelDashboard = {
  empresa: "Kidmais",
  hoje: "2026-03-17",
  numeros: { recebidoMesCentavos: 6240000, aReceberCentavos: 4730000, aPagarCentavos: 1890000, emAtrasoCentavos: 320000, saldoPrevistoCentavos: 9080000 },
  agenda: [
    { id: "1", data: "2026-03-17", hora: "14:00", cliente: "Maria Silva", pacote: "Festa Premium", convidados: 45, status: "ASSINADO" },
    { id: "2", data: "2026-03-17", hora: "18:30", cliente: "João Souza", pacote: "Festa Completa", convidados: 60, status: "AGUARDANDO_ASSINATURA" },
  ],
  proximas: [
    { id: "1", contratoId: "00000000-0000-4000-8000-000000000002", versaoId: "00000000-0000-4000-8000-000000000003", data: "2026-03-18", hora: "14:00", cliente: "Maria Silva", pacote: "Premium", convidados: 45, status: "ASSINADO" },
    { id: "2", contratoId: "00000000-0000-4000-8000-000000000022", versaoId: "00000000-0000-4000-8000-000000000023", data: "2026-03-19", hora: "18:30", cliente: "João Souza", pacote: "Completa", convidados: 60, status: "AGUARDANDO_ASSINATURA" },
  ],
  atencao: [
    { tom: "alerta", titulo: "Pagamento vencido — Roberto Lima", detalhe: "R$ 3.200 há 5 dias", href: "/admin/financeiro/contas-receber" },
    { tom: "aviso", titulo: "Contrato aguardando assinatura", detalhe: "Cliente de Exemplo", href: "/admin/contratos?contratoId=00000000-0000-4000-8000-000000000002&versaoId=00000000-0000-4000-8000-000000000003#documentacao" },
  ],
  contratosPendentes: 3,
  festasProximas: 8,
  realizadas: 23,
  futuras: 7,
  ticketCentavos: 890000,
  pacote: "Festa Completa",
};

export const financeiroVitrine: AmostraFinanceira = {
  resumo: { recebidoMesCentavos: 6240000, aReceberCentavos: 4730000, aPagarCentavos: 1890000, emAtrasoCentavos: 320000, saldoPrevistoCentavos: 9080000, pagoMesCentavos: 1200000 },
  recebiveis: [
    { id: "r1", cliente: "Roberto Lima", pacote: "Festa Premium", festaId: "f1", parcela: 2, vencimento: "2026-03-12", valorCentavos: 320000, recebidoCentavos: 0, saldoCentavos: 320000, forma: "PIX", status: "Vencido", diasAtraso: 5 },
    { id: "r2", cliente: "Maria Silva", pacote: "Festa Completa", festaId: "f2", parcela: 1, vencimento: "2026-03-28", valorCentavos: 1500000, recebidoCentavos: 500000, saldoCentavos: 1000000, forma: "PIX", status: "Parcialmente pago", diasAtraso: 0 },
  ],
  contas: [
    { id: "c1", descricao: "Aluguel", favorecido: "Imobiliária", categoria: "Aluguel", categoriaId: "cat", vencimento: "2026-03-10", valorCentavos: 800000, saldoCentavos: 800000, pagoCentavos: 0, status: "Vencido", forma: "PIX" },
  ],
  categorias: [{ id: "cat", nome: "Aluguel" }],
  alertas: ["Roberto Lima está em atraso"],
  fluxo: {
    saldoInicialCentavos: 0,
    entradasCentavos: 6240000,
    saidasCentavos: 1890000,
    saldoFinalCentavos: 4350000,
    linhas: [
      { data: "2026-03-05", descricao: "Recebimento", entrada: 2000000, saida: 0, saldo: 2000000, tipo: "realizado" },
      { data: "2026-03-10", descricao: "Aluguel", entrada: 0, saida: 800000, saldo: 1200000, tipo: "previsto" },
    ],
  },
  relatorio: {
    faturamentoCentavos: 9000000,
    recebidoCentavos: 6240000,
    aReceberCentavos: 4730000,
    aPagarCentavos: 1890000,
    inadimplenciaCentavos: 320000,
    ticketCentavos: 890000,
    pacoteMaisVendido: "Festa Completa",
    despesas: [{ categoria: "Aluguel", centavos: 800000 }],
    pacotes: [{ pacote: "Festa Completa", centavos: 5000000 }],
    formas: [{ forma: "PIX", centavos: 6240000 }],
    taxasCentavos: 0,
    margens: [{ festaId: "f1", cliente: "Maria Silva", margemEstimadaCentavos: 300000, resultadoCaixaCentavos: 200000 }],
  },
};

export const festaVitrine = {
  valorContratadoCentavos: 1500000,
  recebidoCentavos: 500000,
  aReceberCentavos: 1000000,
  custosCentavos: 200000,
  margemEstimadaCentavos: 1300000,
  resultadoCaixaCentavos: 300000,
  recebimentos: [{ id: "r2", parcela: 1, vencimento: "2026-03-28", valorCentavos: 1500000, status: "Parcialmente pago" }],
  despesas: [{ id: "d1", categoria: "Buffet / insumos", favorecido: "Fornecedor", valorCentavos: 200000, status: "Pago" }],
};
