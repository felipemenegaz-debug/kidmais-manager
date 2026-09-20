import type {
  EstornoRecord,
  MeioPlanoPagamento,
  MeioRecebimento,
  ModalidadePagamento,
  PagamentoRecord,
  ParcelaPagamentoRecord,
  PlanoPagamentoRecord,
  RecebimentoAlocacaoRecord,
  RecebimentoRecord,
} from "../repositories";

export type PagamentoServiceContext = {
  token?: string;
  usuarioId?: string | null;
  origem: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type PlanoPagamentoInput = {
  meioPagamento: MeioPlanoPagamento;
  modalidade: ModalidadePagamento;
  provedorPreferido?: string | null;
  observacoes?: string | null;
  parcelas: Array<{
    valor: number;
    vencimento: string;
    confirmaReserva?: boolean;
  }>;
};

export type CriarPagamentoInput = {
  fechamentoId: string;
  plano: PlanoPagamentoInput;
};

export type SugerirPagamentoInput = {
  fechamentoId: string;
  plano: import('../../comercial/condicao-pagamento').PretensaoPixInput & {
    meioPagamento: 'PIX';
    modalidade: 'PARCELADO';
    confirmacao?: { dataReferencia: string; hash: string };
  };
};
export type SugestaoPagamentoResult = {
  sugestao: import('./sugestao-pix').SugestaoPix & { hash: string };
  exigeConfirmacao: true;
};

export type PagamentoDetalhe = {
  cronogramaId?: string;
  fonteProgramacao?: 'CRONOGRAMA_CONSOLIDADO';
  creditoCentavos?: string;
  pagamento: PagamentoRecord;
  plano: PlanoPagamentoRecord;
  parcelas: Array<ParcelaPagamentoRecord & {
    recebidoConfirmado: number;
    estornadoConfirmado: number;
    valorLiquidoRecebido: number;
    saldo: number;
    vencida: boolean;
  }>;
  totais: {
    valorContratado: number;
    recebidoConfirmado: number;
    estornadoConfirmado: number;
    recebidoLiquido: number;
    saldo: number;
  };
};

export type RegistrarRecebimentoInput = {
  pagamentoId: string;
  meioPagamento: MeioRecebimento;
  valorBruto: number;
  recebidoEm?: string | null;
  provedorCodigo?: string | null;
  referenciaExterna?: string | null;
  chaveIdempotencia?: string | null;
  metadataProvedor?: Record<string, unknown>;
  observacoes?: string | null;
  confirmarAgora?: boolean;
  alocacoes: Array<{
    parcelaId: string;
    valor: number;
  }>;
};

export type RegistrarRecebimentoResult = {
  recebimento: RecebimentoRecord;
  alocacoes: RecebimentoAlocacaoRecord[];
  detalhe: PagamentoDetalhe;
  reutilizado: boolean;
  reserva: {
    status: PagamentoRecord["reservaStatus"];
    conflito: boolean;
  };
};

export type RegistrarEstornoInput = {
  reprogramacao?: import('./alteracao-financeira.models').PedidoResolucao;
  pagamentoId: string;
  recebimentoId: string;
  parcelaId: string;
  valor: number;
  motivo?: string | null;
  provedorCodigo?: string | null;
  referenciaExterna?: string | null;
  chaveIdempotencia?: string | null;
  metadataProvedor?: Record<string, unknown>;
  confirmarAgora?: boolean;
};

export type RegistrarEstornoResult = {
  estorno: EstornoRecord;
  detalhe: PagamentoDetalhe;
  reutilizado: boolean;
};
