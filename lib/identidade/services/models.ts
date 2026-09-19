import type {
  ValidacaoIdentidadeCanal,
  ValidacaoIdentidadeFinalidade,
} from "../repositories";

export type CanalIdentidadePublico = {
  canal: ValidacaoIdentidadeCanal;
  destinoMascarado: string;
};

export type ConsultaCpfPublicaResult =
  | {
      situacao: "NOVO_CLIENTE";
      canais: [];
    }
  | {
      situacao: "CLIENTE_EXISTENTE";
      canais: CanalIdentidadePublico[];
    }
  | {
      situacao: "CLIENTE_EXISTENTE_SEM_CONTATO";
      canais: [];
    };

export type IniciarDesafioIdentidadeInput = {
  cpf: string;
  canal: ValidacaoIdentidadeCanal;
  /** Mantém FECHAMENTO_PUBLICO como padrão para compatibilidade. */
  finalidade?: ValidacaoIdentidadeFinalidade;
};

export type DesafioIdentidadePublico = {
  validacaoId: string;
  canal: ValidacaoIdentidadeCanal;
  destinoMascarado: string;
  expiraEm: string;
};

export type ConfirmarCodigoIdentidadeInput = {
  validacaoId: string;
  codigo: string;
};

export type ProvaIdentidadePublica = {
  provaToken: string;
  expiraEm: string;
};

export type RecuperacaoIdentidadePublica = {
  situacao: "RECUPERACAO_PENDENTE";
};

/**
 * Estrutura entregue apenas ao provedor de envio no servidor.
 * O destino real e o OTP nunca devem compor a resposta pública da API.
 */
export type OtpDelivery = {
  validacaoId: string;
  canal: ValidacaoIdentidadeCanal;
  destino: string;
  codigo: string;
  expiraEm: string;
};

/** Recibo de transporte interno e transitório; não comprova entrega ao destinatário. */
export type OtpSubmission = {
  provider: "gupshup";
  status: "submitted";
  messageId: string;
};

export type IdentityOtpSender = (delivery: OtpDelivery) => Promise<void | OtpSubmission>;

export type IdentityServiceOptions = {
  /** Segredo de servidor usado como pepper do HMAC do OTP. */
  otpPepper: string;
  enviarOtp: IdentityOtpSender;

  otpTtlMs?: number;
  provaTtlMs?: number;
  maxTentativas?: number;
  maxEnvios?: number;

  /** Dependências substituíveis apenas para testes. */
  now?: () => Date;
  gerarOtp?: () => string;
  gerarProvaToken?: () => string;
};

/** Uso estritamente interno no servidor. Nunca retornar ao navegador. */
export type ProvaIdentidadeResolvida = {
  validacaoId: string;
  clienteId: string;
  finalidade: ValidacaoIdentidadeFinalidade;
  expiraEm: string;
};

/** Uso estritamente interno no servidor após consumir a prova do Fechamento. */
export type ProvaIdentidadeConsumida = {
  validacaoId: string;
  clienteId: string;
  fechamentoId: string;
};

/** Uso estritamente interno no servidor após consumir a prova do Contrato. */
export type ProvaIdentidadeContratoConsumida = {
  validacaoId: string;
  clienteId: string;
  contratoVersaoId: string;
};
