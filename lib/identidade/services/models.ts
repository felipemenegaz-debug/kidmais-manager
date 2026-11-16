import type {
  ValidacaoIdentidadeCanal,
  ValidacaoIdentidadeFinalidade,
} from "../repositories";
import type { EscopoIdentidade } from "../../clientes/repositories";

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
  /** Documento informado: CPF ou, com a 112, CNPJ (classificado pelo formato; R2-1). Nome mantido por compatibilidade. */
  cpf: string;
  canal: ValidacaoIdentidadeCanal;
  /** Mantém FECHAMENTO_PUBLICO como padrão para compatibilidade. */
  finalidade?: ValidacaoIdentidadeFinalidade;
  /** Obrigatório: empresa do endereço público (resolvida no servidor) ou cliente do contrato. */
  escopo: EscopoIdentidade;
};

export type DesafioIdentidadePublico = {
  validacaoId: string;
  canal: ValidacaoIdentidadeCanal;
  destinoMascarado: string;
  expiraEm: string;
  /**
   * Presente quando o código foi para o e-mail como reserva: na hora, porque o WhatsApp falhou,
   * ou a pedido do cliente que não recebeu o WhatsApp.
   */
  reserva?: "FALHA_WHATSAPP" | "PEDIDO_CLIENTE";
  /** Desafio por WhatsApp com reserva por e-mail disponível: e-mail mascarado e quando o pedido é aceito. */
  reservaEmail?: { destinoMascarado: string; liberaEm: string };
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
  /** Reserva por e-mail do código (trava + e-mail configurado). Padrão: desligada. */
  reservaEmail?: boolean;
  /** Espera mínima, depois do envio pelo WhatsApp, para o cliente pedir o código por e-mail. Padrão: 60 s. */
  reservaEmailEsperaMs?: number;

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
  /** Canal por onde foi o código que provou a identidade (auditoria do aceite). */
  canal: ValidacaoIdentidadeCanal | null;
};
