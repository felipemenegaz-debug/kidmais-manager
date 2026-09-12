export type PagamentoStatus =
  | "AGUARDANDO_PAGAMENTO"
  | "PARCIALMENTE_PAGO"
  | "QUITADO"
  | "ESTORNADO"
  | "CANCELADO";

export type ReservaPagamentoStatus = "PENDENTE" | "CONFIRMADA" | "CONFLITO";
export type MeioPlanoPagamento = "PIX" | "CARTAO";
export type ModalidadePagamento = "AVISTA" | "PARCELADO";
export type PlanoPagamentoStatus = "ATIVO" | "SUBSTITUIDO" | "CANCELADO";
export type ParcelaPagamentoStatus =
  | "PENDENTE"
  | "PARCIALMENTE_PAGA"
  | "PAGA"
  | "ESTORNADA"
  | "CANCELADA";
export type RecebimentoStatus = "PENDENTE" | "CONFIRMADO" | "RECUSADO" | "CANCELADO";
export type MeioRecebimento = "PIX" | "CARTAO" | "TRANSFERENCIA" | "DINHEIRO" | "OUTRO";
export type EstornoStatus = "SOLICITADO" | "CONFIRMADO" | "FALHOU" | "CANCELADO";

export type PagamentoRecord = {
  id: string;
  contratoVersaoId: string;
  valorTotalContratado: number;
  moeda: "BRL";
  status: PagamentoStatus;
  reservaStatus: ReservaPagamentoStatus;
  reservaConfirmadaEm: string | null;
  reservaConflitoEm: string | null;
  quitadoEm: string | null;
  canceladoEm: string | null;
  criadoPorUsuarioId: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type PlanoPagamentoRecord = {
  id: string;
  pagamentoId: string;
  numeroVersao: number;
  status: PlanoPagamentoStatus;
  meioPagamento: MeioPlanoPagamento;
  modalidade: ModalidadePagamento;
  quantidadeParcelas: number;
  provedorPreferido: string | null;
  observacoes: string | null;
  motivoSubstituicao: string | null;
  criadoPorUsuarioId: string | null;
  criadoEm: string;
  substituidoEm: string | null;
  canceladoEm: string | null;
};

export type ParcelaPagamentoRecord = {
  id: string;
  planoId: string;
  numero: number;
  valorPrevisto: number;
  vencimento: string;
  confirmaReserva: boolean;
  status: ParcelaPagamentoStatus;
  criadoEm: string;
  atualizadoEm: string;
};

export type RecebimentoRecord = {
  id: string;
  pagamentoId: string;
  status: RecebimentoStatus;
  meioPagamento: MeioRecebimento;
  valorBruto: number;
  recebidoEm: string;
  confirmadoEm: string | null;
  canceladoEm: string | null;
  provedorCodigo: string | null;
  referenciaExterna: string | null;
  chaveIdempotencia: string | null;
  metadataProvedor: Record<string, unknown>;
  registradoPorUsuarioId: string | null;
  observacoes: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type RecebimentoAlocacaoRecord = {
  id: string;
  recebimentoId: string;
  parcelaId: string;
  valorAlocado: number;
  criadoEm: string;
};

export type EstornoRecord = {
  id: string;
  recebimentoId: string;
  parcelaId: string;
  valor: number;
  status: EstornoStatus;
  motivo: string | null;
  solicitadoEm: string;
  confirmadoEm: string | null;
  canceladoEm: string | null;
  provedorCodigo: string | null;
  referenciaExterna: string | null;
  chaveIdempotencia: string | null;
  metadataProvedor: Record<string, unknown>;
  registradoPorUsuarioId: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type ComprovantePagamentoRecord = {
  id: string;
  recebimentoId: string;
  nomeArquivo: string;
  mimeType: string;
  tamanhoBytes: number;
  sha256: string;
  localizadorArquivo: string;
  registradoPorUsuarioId: string | null;
  criadoEm: string;
};

export type ParcelaMovimentoResumo = {
  parcelaId: string;
  valorPrevisto: number;
  recebidoConfirmado: number;
  estornadoConfirmado: number;
};
