export type ValidacaoIdentidadeFinalidade =
  | "FECHAMENTO_PUBLICO"
  | "CONTRATO_ACEITE";

export type ValidacaoIdentidadeCanal =
  | "WHATSAPP"
  | "SMS"
  | "EMAIL";

export type ValidacaoIdentidadeStatus =
  | "PENDENTE"
  | "CONFIRMADA"
  | "CONSUMIDA"
  | "RECUPERACAO_PENDENTE"
  | "EXPIRADA"
  | "BLOQUEADA"
  | "CANCELADA";

export type ValidacaoIdentidadeRecord = {
  id: string;
  clienteId: string;
  finalidade: ValidacaoIdentidadeFinalidade;
  canal: ValidacaoIdentidadeCanal | null;
  status: ValidacaoIdentidadeStatus;

  codigoHash: string | null;

  tentativas: number;
  maxTentativas: number;

  envios: number;
  maxEnvios: number;
  ultimoEnvioEm: string | null;

  codigoExpiraEm: string | null;

  confirmadoEm: string | null;
  tokenProvaHash: string | null;
  provaExpiraEm: string | null;

  consumidoEm: string | null;
  consumidoPorFechamentoId: string | null;
  consumidoPorContratoVersaoId: string | null;

  recuperacaoSolicitadaEm: string | null;

  criadoEm: string;
  atualizadoEm: string;
};

export type CreateDesafioIdentidadeInput = {
  clienteId: string;
  finalidade?: ValidacaoIdentidadeFinalidade;
  canal: ValidacaoIdentidadeCanal;
  codigoHash: string;
  codigoExpiraEm: string;
  maxTentativas?: number;
  maxEnvios?: number;
};

export type ConfirmarValidacaoInput = {
  validacaoId: string;
  tokenProvaHash: string;
  provaExpiraEm: string;
};

export type ConsumirProvaIdentidadeInput = {
  tokenProvaHash: string;
  fechamentoId: string;
};

export type ConsumirProvaIdentidadeContratoInput = {
  tokenProvaHash: string;
  contratoVersaoId: string;
};
