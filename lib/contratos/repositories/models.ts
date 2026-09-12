export type ContratoStatus =
  | "AGUARDANDO_ASSINATURA"
  | "ASSINADO"
  | "CANCELADO";

export type ContratoAceiteMetodo = "OTP";

export type ContratoVersaoStatus =
  | "ATIVA"
  | "SUBSTITUIDA"
  | "ASSINADA"
  | "CANCELADA";

export type ContratoRecord = {
  id: string;
  fechamentoId: string;
  status: ContratoStatus;
  versaoAtual: number;
  criadoPorUsuarioId: string | null;
  assinadoEm: string | null;
  canceladoEm: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type ContratoSnapshotV1 = {
  schemaVersao: 1;
  fechamento: {
    id: string;
    status: string;
    origem: string;
  };
  contratante: {
    clienteId: string;
    nomeCompleto: string;
    cpf: string;
    rg: string | null;
    telefone: string | null;
    whatsapp: string | null;
    email: string;
    endereco: {
      cep: string;
      logradouro: string;
      numero: string;
      complemento: string | null;
      bairro: string;
      cidade: string;
      uf: string;
    };
  };
  responsavelAdicional: {
    id: string;
    nome: string;
    cpf: string | null;
    telefone: string | null;
    whatsapp: string | null;
    email: string | null;
    relacao: string | null;
  } | null;
  aniversariante: {
    id: string;
    nome: string;
    dataNascimento: string | null;
    idadeNoEvento: number | null;
    temaFesta: string | null;
  };
  evento: {
    data: string;
    horarioInicio: string;
    horarioFim: string;
    pacote: {
      id: string;
      codigo: string;
      nome: string;
      duracaoMinutos: number | null;
    };
    convidados: number;
    convidadosFaturados: number;
  };
  contratacao: {
    adicionais: Array<{
      adicionalId: string;
      nome: string;
      unidadeCobranca: string;
      quantidade: number;
      valorUnitario: number;
      valorTotal: number;
      observacoes: string | null;
    }>;
    alteracoesPacote: string | null;
    observacoesCliente: string | null;
    observacoesEquipe: string | null;
    buffet: {
      status: "PENDENTE" | "DEFINIDO";
      salgados: string | null;
      bebidas: string | null;
      doces: string | null;
      bolo: string | null;
      outros: string | null;
lembrancinha?: string | null;
empratado?: string | null;
bombom?: string | null;
    };
  };
  comercial: {
    tabelaPreco: {
      id: string;
      codigo: string;
      nome: string;
    };
    categoriaHorario: string;
    categoriaPrecoAplicada: string;
    valorPacoteBase: number;
    descontoPercentual: number;
    valorDescontoPacote: number;
    valorPacoteAplicado: number;
    valorAdicionais: number;
    valorTabela: number;
    valorNegociado: number | null;
    valorAprovado: number | null;
    valorFinalContrato: number;
    valorBaseComercial?: number;
    descontoFormaPagamentoPercentual?: number;
    valorDescontoFormaPagamento?: number;
    condicaoPagamento?: import("../../comercial/condicao-pagamento").CondicaoPagamento;
    formaPagamentoPretendida: string | null;
  };
};

export type ContratoVersaoRecord = {
  id: string;
  contratoId: string;
  numeroVersao: number;
  status: ContratoVersaoStatus;
  snapshotSchemaVersao: number;
  snapshot: ContratoSnapshotV1;
  snapshotHash: string;
  motivoNovaVersao: string | null;
  geradoPorUsuarioId: string | null;
  documentoTemplateVersao: number | null;
  documentoPdfHash: string | null;
  aceiteMetodo: ContratoAceiteMetodo | null;
  criadoEm: string;
  substituidoEm: string | null;
  assinadoEm: string | null;
};

export type ReferenciasComerciaisContrato = {
  pacoteId: string;
  pacoteCodigo: string;
  pacoteNome: string;
  pacoteDuracaoMinutos: number | null;
  tabelaPrecoId: string;
  tabelaPrecoCodigo: string;
  tabelaPrecoNome: string;
};
