import type { CondicaoPagamento, DecisaoCondicaoPagamento } from "../../comercial/condicao-pagamento";

export type FechamentoStatus =
  | "RASCUNHO"
  | "AGUARDANDO_APROVACAO"
  | "APROVADO"
  | "AGUARDANDO_CONTRATO"
  | "CONTRATO_ASSINADO"
  | "AGUARDANDO_PAGAMENTO"
  | "CONFIRMADO"
  | "CANCELADO"
  | "RECUSADO"
  | "EXPIRADO";

export type OrigemFechamento = "CLIENTE" | "ATENDIMENTO_KIDMAIS";
export type BuffetStatus = "PENDENTE" | "DEFINIDO";
export type FormaPagamentoPretendida = "PIX_AVISTA" | "PIX_PARCELADO" | "CARTAO_CIELO";
export type CategoriaHorario = "PADRAO" | "NOBRE";
export type CategoriaPrecoAplicada = "GERAL" | "PADRAO" | "NOBRE";

export type FechamentoRecord = {
  id: string;
  clienteId: string | null;
  aniversarianteId: string | null;
  dataEvento: string;
  horarioInicio: string;
  horarioFim: string;
  configuracaoAgendaId: string;
  pacoteId: string;
  tabelaPrecoId: string;
  precoPacoteId: string;
  regraDescontoPacoteId: string | null;
  categoriaHorario: CategoriaHorario;
  categoriaPrecoAplicada: CategoriaPrecoAplicada;
  convidados: number;
  convidadosFaturados: number;
  valorPacoteBase: number;
  descontoPercentual: number;
  valorDescontoPacote: number;
  valorPacoteAplicado: number;
  valorAdicionais: number;
  valorTabela: number;
  valorNegociado: number | null;
  valorAprovado: number | null;
  motivoNegociacao: string | null;
  observacoesNegociacao: string | null;
  status: FechamentoStatus;
  origemFechamento: OrigemFechamento;
  iniciadoPorUsuarioId: string | null;
  iniciadoEm: string;
  usuarioResponsavelId: string | null;
  responsavelAdicionalId: string | null;
  idadeAniversarianteEvento: number | null;
  temaFesta: string | null;
  formaPagamentoPretendida: FormaPagamentoPretendida | null;
  condicaoPagamento?: CondicaoPagamento | null;
  alteracoesPacote: string | null;
  observacoesCliente: string | null;
  observacoesEquipe: string | null;
  buffetStatus: BuffetStatus;
  buffetSalgados: string | null;
  buffetBebidas: string | null;
  buffetDoces: string | null;
  buffetBolo: string | null;
  buffetOutros: string | null;
  buffetLembrancinha?: string | null;
  buffetEmpratado?: string | null;
  buffetBombom?: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type CreateFechamentoInput = {
  clienteId?: string | null;
  aniversarianteId?: string | null;
  dataEvento: string;
  horarioInicio: string;
  horarioFim: string;
  configuracaoAgendaId: string;
  pacoteId: string;
  tabelaPrecoId: string;
  precoPacoteId: string;
  regraDescontoPacoteId?: string | null;
  categoriaHorario: CategoriaHorario;
  categoriaPrecoAplicada: CategoriaPrecoAplicada;
  convidados: number;
  convidadosFaturados: number;
  valorPacoteBase: number;
  descontoPercentual?: number;
  valorDescontoPacote?: number;
  valorPacoteAplicado: number;
  valorAdicionais?: number;
  valorTabela: number;
  valorNegociado?: number | null;
  valorAprovado?: number | null;
  motivoNegociacao?: string | null;
  observacoesNegociacao?: string | null;
  status: FechamentoStatus;
  origemFechamento: OrigemFechamento;
  iniciadoPorUsuarioId?: string | null;
  usuarioResponsavelId?: string | null;
  responsavelAdicionalId?: string | null;
  idadeAniversarianteEvento?: number | null;
  temaFesta?: string | null;
  formaPagamentoPretendida?: FormaPagamentoPretendida | null;
  condicaoPagamento?: CondicaoPagamento | null;
  alteracoesPacote?: string | null;
  observacoesCliente?: string | null;
  observacoesEquipe?: string | null;
  buffetStatus?: BuffetStatus;
  buffetSalgados?: string | null;
  buffetBebidas?: string | null;
  buffetDoces?: string | null;
  buffetBolo?: string | null;
  buffetOutros?: string | null;
  buffetLembrancinha?: string | null;
  buffetEmpratado?: string | null;
  buffetBombom?: string | null;
};

export type UnidadeCobrancaAdicional =
  | "VALOR_FIXO"
  | "CONVIDADO"
  | "UNIDADE"
  | "CENTO"
  | "HORA"
  | "PACOTE"
  | "METRO";

export type FechamentoAdicionalRecord = {
  id: string;
  fechamentoId: string;
  adicionalId: string;
  precoAdicionalId: string;
  nomeAplicado: string;
  unidadeCobrancaAplicada: UnidadeCobrancaAdicional;
  quantidade: number;
  valorUnitarioAplicado: number;
  valorTotal: number;
  observacoes: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type CreateFechamentoAdicionalInput = {
  fechamentoId: string;
  adicionalId: string;
  precoAdicionalId: string;
  nomeAplicado: string;
  unidadeCobrancaAplicada: UnidadeCobrancaAdicional;
  quantidade: number;
  valorUnitarioAplicado: number;
  valorTotal: number;
  observacoes?: string | null;
};

export type AprovacaoNegociacaoStatus =
  | "PENDENTE"
  | "APROVADO"
  | "CORRIGIDO"
  | "RECUSADO";

export type AprovacaoNegociacaoRecord = {
  condicaoPagamento: DecisaoCondicaoPagamento | null;
  id: string;
  fechamentoId: string;
  valorInformado: number;
  valorAprovado: number | null;
  status: AprovacaoNegociacaoStatus;
  motivo: string | null;
  aprovadoPorUsuarioId: string | null;
  observacoes: string | null;
  criadoEm: string;
};

export type CreateAprovacaoNegociacaoInput = {
  condicaoPagamento?: DecisaoCondicaoPagamento | null;
  fechamentoId: string;
  valorInformado: number;
  valorAprovado?: number | null;
  status: AprovacaoNegociacaoStatus;
  motivo?: string | null;
  aprovadoPorUsuarioId?: string | null;
  observacoes?: string | null;
};
