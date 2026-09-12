import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

import type { DbExecutor } from "../../db/contracts";
import {
  buscarClienteCanonicoPorCpf,
  buscarClienteCanonicoPorId,
  type ClienteRecord,
} from "../../clientes/repositories";
import { normalizarCpf } from "../../clientes/repositories/normalizers";
import { cpfValidoServico } from "../../clientes/services/validators";
import {
  buscarProvaConfirmadaPorTokenHash,
  buscarValidacaoPorId,
  confirmarValidacao,
  consumirProvaIdentidade,
  consumirProvaIdentidadeParaContrato,
  criarDesafioIdentidade,
  criarRecuperacaoPendente,
  registrarEnvioOtp,
  registrarTentativaInvalida,
  type ValidacaoIdentidadeCanal,
  type ValidacaoIdentidadeFinalidade,
  type ValidacaoIdentidadeRecord,
} from "../repositories";
import { IdentityServiceError } from "./errors";
import type {
  CanalIdentidadePublico,
  ConfirmarCodigoIdentidadeInput,
  ConsultaCpfPublicaResult,
  DesafioIdentidadePublico,
  IdentityServiceOptions,
  IniciarDesafioIdentidadeInput,
  ProvaIdentidadeConsumida,
  ProvaIdentidadeContratoConsumida,
  ProvaIdentidadePublica,
  ProvaIdentidadeResolvida,
  RecuperacaoIdentidadePublica,
} from "./models";

const DEFAULT_OTP_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PROVA_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TENTATIVAS = 5;
const DEFAULT_MAX_ENVIOS = 3;

function adicionarMs(base: Date, milliseconds: number) {
  return new Date(base.getTime() + milliseconds);
}

function somenteDigitos(value: string) {
  return value.replace(/\D/g, "");
}

function validarCpfObrigatorio(cpfInformado: string) {
  const cpf = normalizarCpf(cpfInformado);

  if (!cpf || !cpfValidoServico(cpf)) {
    throw new IdentityServiceError(
      "CPF_INVALIDO",
      "Informe um CPF válido.",
      400,
      { campo: "cpf" },
    );
  }

  return cpf;
}

export function mascararTelefoneIdentidade(value: string) {
  const digits = somenteDigitos(value);
  if (!digits) return "***";

  const ultimos = digits.slice(-4).padStart(4, "*");
  return `(**) *****-${ultimos}`;
}

export function mascararEmailIdentidade(value: string) {
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "***@***";

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const domainBase = dot > 0 ? domain.slice(0, dot) : domain;
  const suffix = dot > 0 ? domain.slice(dot) : "";

  const localMasked = `${local[0]}***`;
  const domainMasked = domainBase ? `${domainBase[0]}***` : "***";

  return `${localMasked}@${domainMasked}${suffix}`;
}

function destinoDoCanal(
  cliente: ClienteRecord,
  canal: ValidacaoIdentidadeCanal,
): string | null {
  if (canal === "WHATSAPP") return cliente.whatsapp;
  if (canal === "SMS") return cliente.telefone;
  return cliente.email;
}

function mascararDestino(canal: ValidacaoIdentidadeCanal, destino: string) {
  return canal === "EMAIL"
    ? mascararEmailIdentidade(destino)
    : mascararTelefoneIdentidade(destino);
}

function canaisDisponiveis(cliente: ClienteRecord): CanalIdentidadePublico[] {
  const canais: CanalIdentidadePublico[] = [];

  // Escopo V1: somente o canal transacional oficial do WhatsApp é liberado
  // nos fluxos públicos. SMS e e-mail permanecem modelados para evolução futura.
  if (cliente.whatsapp) {
    canais.push({
      canal: "WHATSAPP",
      destinoMascarado: mascararTelefoneIdentidade(cliente.whatsapp),
    });
  }

  return canais;
}

function normalizarInstanteParaHash(value: string) {
  const milliseconds = new Date(value).getTime();

  if (!Number.isFinite(milliseconds)) {
    return value;
  }

  return new Date(milliseconds).toISOString();
}

function hashOtp(
  codigo: string,
  pepper: string,
  validacaoContext: {
    clienteId: string;
    canal: ValidacaoIdentidadeCanal;
    codigoExpiraEm: string;
  },
) {
  return createHmac("sha256", pepper)
    .update(validacaoContext.clienteId)
    .update("|")
    .update(validacaoContext.canal)
    .update("|")
    .update(normalizarInstanteParaHash(validacaoContext.codigoExpiraEm))
    .update("|")
    .update(codigo)
    .digest("hex");
}

export function hashProvaIdentidadeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function hashesIguais(a: string, b: string) {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function otpPadrao() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function provaTokenPadrao() {
  return randomBytes(32).toString("base64url");
}

function validarConfiguracao(options: IdentityServiceOptions) {
  if (options.otpPepper.trim().length < 16) {
    throw new IdentityServiceError(
      "CONFIGURACAO_IDENTIDADE_INVALIDA",
      "IDENTIDADE_OTP_PEPPER precisa ter pelo menos 16 caracteres.",
      500,
    );
  }

  const numericOptions = [
    ["otpTtlMs", options.otpTtlMs ?? DEFAULT_OTP_TTL_MS],
    ["provaTtlMs", options.provaTtlMs ?? DEFAULT_PROVA_TTL_MS],
    ["maxTentativas", options.maxTentativas ?? DEFAULT_MAX_TENTATIVAS],
    ["maxEnvios", options.maxEnvios ?? DEFAULT_MAX_ENVIOS],
  ] as const;

  for (const [name, value] of numericOptions) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new IdentityServiceError(
        "CONFIGURACAO_IDENTIDADE_INVALIDA",
        `Configuração inválida: ${name}.`,
        500,
      );
    }
  }
}

function validarFormatoOtp(codigo: string) {
  return /^\d{6}$/.test(codigo.trim());
}

function assertValidacaoPendente(record: ValidacaoIdentidadeRecord) {
  if (record.status === "BLOQUEADA") {
    throw new IdentityServiceError(
      "CODIGO_BLOQUEADO",
      "O limite de tentativas desta validação foi atingido.",
      429,
    );
  }

  if (record.status !== "PENDENTE") {
    throw new IdentityServiceError(
      "VALIDACAO_NAO_PENDENTE",
      "Esta validação não está mais pendente.",
      409,
    );
  }
}

export async function consultarCpfPublico(
  cpfInformado: string,
  customDb?: DbExecutor,
): Promise<ConsultaCpfPublicaResult> {
  const cpf = validarCpfObrigatorio(cpfInformado);
  const cliente = await buscarClienteCanonicoPorCpf(cpf, customDb);

  if (!cliente) {
    return { situacao: "NOVO_CLIENTE", canais: [] };
  }

  const canais = canaisDisponiveis(cliente);
  if (canais.length === 0) {
    return {
      situacao: "CLIENTE_EXISTENTE_SEM_CONTATO",
      canais: [],
    };
  }

  return {
    situacao: "CLIENTE_EXISTENTE",
    canais,
  };
}

/**
 * Cria o serviço de Identidade pública.
 *
 * Regras de segurança:
 * - respostas públicas nunca incluem clienteId, nome ou endereço;
 * - OTP é persistido apenas como HMAC com pepper de servidor;
 * - token de prova possui alta entropia e só seu SHA-256 é persistido;
 * - cliente canônico é sempre resolvido no backend.
 */
export function criarIdentityService(options: IdentityServiceOptions) {
  validarConfiguracao(options);

  const now = options.now ?? (() => new Date());
  const gerarOtp = options.gerarOtp ?? otpPadrao;
  const gerarProvaToken = options.gerarProvaToken ?? provaTokenPadrao;
  const otpTtlMs = options.otpTtlMs ?? DEFAULT_OTP_TTL_MS;
  const provaTtlMs = options.provaTtlMs ?? DEFAULT_PROVA_TTL_MS;
  const maxTentativas = options.maxTentativas ?? DEFAULT_MAX_TENTATIVAS;
  const maxEnvios = options.maxEnvios ?? DEFAULT_MAX_ENVIOS;

  async function iniciarDesafio(
    input: IniciarDesafioIdentidadeInput,
    customDb?: DbExecutor,
  ): Promise<DesafioIdentidadePublico> {
    const cpf = validarCpfObrigatorio(input.cpf);
    const cliente = await buscarClienteCanonicoPorCpf(cpf, customDb);

    if (!cliente) {
      throw new IdentityServiceError(
        "CLIENTE_NAO_ENCONTRADO",
        "Nenhum Cliente existente foi encontrado para validação.",
        404,
      );
    }

    const destino = destinoDoCanal(cliente, input.canal);
    if (!destino) {
      throw new IdentityServiceError(
        "CANAL_INDISPONIVEL",
        "O canal selecionado não está disponível para este cadastro.",
        400,
        { canal: input.canal },
      );
    }

    const codigo = gerarOtp();
    if (!validarFormatoOtp(codigo)) {
      throw new IdentityServiceError(
        "CONFIGURACAO_IDENTIDADE_INVALIDA",
        "O gerador de OTP deve produzir exatamente 6 dígitos.",
        500,
      );
    }

    const expiraEm = adicionarMs(now(), otpTtlMs).toISOString();
    const codigoHash = hashOtp(codigo, options.otpPepper, {
      clienteId: cliente.id,
      canal: input.canal,
      codigoExpiraEm: expiraEm,
    });

    const validacao = await criarDesafioIdentidade(
      {
        clienteId: cliente.id,
        finalidade: input.finalidade ?? "FECHAMENTO_PUBLICO",
        canal: input.canal,
        codigoHash,
        codigoExpiraEm: expiraEm,
        maxTentativas,
        maxEnvios,
      },
      customDb,
    );

    try {
      await options.enviarOtp({
        validacaoId: validacao.id,
        canal: input.canal,
        destino,
        codigo,
        expiraEm,
      });

      const envioRegistrado = await registrarEnvioOtp(
        validacao.id,
        customDb,
      );

      if (!envioRegistrado) {
        throw new IdentityServiceError(
          "CONFIGURACAO_IDENTIDADE_INVALIDA",
          "Não foi possível registrar o envio do código de validação.",
          500,
        );
      }
    } catch (error) {
      throw new IdentityServiceError(
        "FALHA_ENVIO_OTP",
        "Não foi possível enviar o código de validação.",
        503,
        {
          validacaoId: validacao.id,
          causa: error instanceof Error ? error.message : "erro_desconhecido",
        },
      );
    }

    return {
      validacaoId: validacao.id,
      canal: input.canal,
      destinoMascarado: mascararDestino(input.canal, destino),
      expiraEm,
    };
  }

  async function confirmarCodigo(
    input: ConfirmarCodigoIdentidadeInput,
    customDb?: DbExecutor,
  ): Promise<ProvaIdentidadePublica> {
    const codigo = input.codigo.trim();
    const validacao = await buscarValidacaoPorId(input.validacaoId, customDb);

    if (!validacao) {
      throw new IdentityServiceError(
        "VALIDACAO_NAO_ENCONTRADA",
        "Validação de identidade não encontrada.",
        404,
      );
    }

    assertValidacaoPendente(validacao);

    if (
      !validacao.codigoHash ||
      !validacao.codigoExpiraEm ||
      !validacao.canal
    ) {
      throw new IdentityServiceError(
        "CONFIGURACAO_IDENTIDADE_INVALIDA",
        "A validação pendente está inconsistente.",
        500,
      );
    }

    const expiraEmMs = new Date(validacao.codigoExpiraEm).getTime();
    if (!Number.isFinite(expiraEmMs) || expiraEmMs <= now().getTime()) {
      throw new IdentityServiceError(
        "CODIGO_EXPIRADO",
        "O código de validação expirou.",
        410,
      );
    }

    const candidatoHash = validarFormatoOtp(codigo)
      ? hashOtp(codigo, options.otpPepper, {
          clienteId: validacao.clienteId,
          canal: validacao.canal,
          codigoExpiraEm: validacao.codigoExpiraEm,
        })
      : "";

    if (!hashesIguais(validacao.codigoHash, candidatoHash)) {
      const aposTentativa = await registrarTentativaInvalida(
        validacao.id,
        customDb,
      );

      if (aposTentativa?.status === "BLOQUEADA") {
        throw new IdentityServiceError(
          "CODIGO_BLOQUEADO",
          "O limite de tentativas desta validação foi atingido.",
          429,
        );
      }

      const tentativasRestantes = aposTentativa
        ? Math.max(
            aposTentativa.maxTentativas - aposTentativa.tentativas,
            0,
          )
        : 0;

      throw new IdentityServiceError(
        "CODIGO_INVALIDO",
        "Código de validação inválido.",
        400,
        { tentativasRestantes },
      );
    }

    const provaToken = gerarProvaToken();
    if (provaToken.length < 32) {
      throw new IdentityServiceError(
        "CONFIGURACAO_IDENTIDADE_INVALIDA",
        "O gerador da prova de identidade produziu um token fraco.",
        500,
      );
    }

    const provaExpiraEm = adicionarMs(now(), provaTtlMs).toISOString();
    const confirmada = await confirmarValidacao(
      {
        validacaoId: validacao.id,
        tokenProvaHash: hashProvaIdentidadeToken(provaToken),
        provaExpiraEm,
      },
      customDb,
    );

    if (!confirmada) {
      throw new IdentityServiceError(
        "VALIDACAO_NAO_PENDENTE",
        "A validação não pôde ser confirmada.",
        409,
      );
    }

    return {
      provaToken,
      expiraEm: provaExpiraEm,
    };
  }

  async function resolverClientePorProva(
    provaToken: string,
    customDb?: DbExecutor,
    finalidadeEsperada: ValidacaoIdentidadeFinalidade = "FECHAMENTO_PUBLICO",
  ): Promise<ProvaIdentidadeResolvida> {
    const token = provaToken.trim();
    if (token.length < 32) {
      throw new IdentityServiceError(
        "PROVA_INVALIDA_OU_EXPIRADA",
        "A prova de identidade é inválida ou expirou.",
        401,
      );
    }

    const validacao = await buscarProvaConfirmadaPorTokenHash(
      hashProvaIdentidadeToken(token),
      customDb,
    );

    if (!validacao || !validacao.provaExpiraEm) {
      throw new IdentityServiceError(
        "PROVA_INVALIDA_OU_EXPIRADA",
        "A prova de identidade é inválida ou expirou.",
        401,
      );
    }

    if (validacao.finalidade !== finalidadeEsperada) {
      throw new IdentityServiceError(
        "PROVA_FINALIDADE_INVALIDA",
        "A prova de identidade não pertence a este fluxo.",
        401,
      );
    }

    // Defesa adicional contra referências antigas caso haja mesclagem posterior.
    const cliente = await buscarClienteCanonicoPorId(
      validacao.clienteId,
      customDb,
    );

    if (!cliente) {
      throw new IdentityServiceError(
        "CLIENTE_NAO_ENCONTRADO",
        "Cliente canônico não encontrado.",
        404,
      );
    }

    return {
      validacaoId: validacao.id,
      clienteId: cliente.id,
      finalidade: validacao.finalidade,
      expiraEm: validacao.provaExpiraEm,
    };
  }

  async function consumirProvaParaFechamento(
    provaToken: string,
    fechamentoId: string,
    customDb?: DbExecutor,
  ): Promise<ProvaIdentidadeConsumida> {
    // Resolve primeiro para assegurar que a prova aponta ao Cliente canônico.
    const resolvida = await resolverClientePorProva(
      provaToken,
      customDb,
      "FECHAMENTO_PUBLICO",
    );

    const consumida = await consumirProvaIdentidade(
      {
        tokenProvaHash: hashProvaIdentidadeToken(provaToken.trim()),
        fechamentoId,
      },
      customDb,
    );

    if (!consumida) {
      throw new IdentityServiceError(
        "PROVA_INVALIDA_OU_EXPIRADA",
        "A prova de identidade é inválida, expirou ou já foi utilizada.",
        401,
      );
    }

    return {
      validacaoId: consumida.id,
      clienteId: resolvida.clienteId,
      fechamentoId,
    };
  }

  async function consumirProvaParaContrato(
    provaToken: string,
    contratoVersaoId: string,
    customDb?: DbExecutor,
  ): Promise<ProvaIdentidadeContratoConsumida> {
    const resolvida = await resolverClientePorProva(
      provaToken,
      customDb,
      "CONTRATO_ACEITE",
    );

    const consumida = await consumirProvaIdentidadeParaContrato(
      {
        tokenProvaHash: hashProvaIdentidadeToken(provaToken.trim()),
        contratoVersaoId,
      },
      customDb,
    );

    if (!consumida) {
      throw new IdentityServiceError(
        "PROVA_INVALIDA_OU_EXPIRADA",
        "A prova de identidade é inválida, expirou ou já foi utilizada.",
        401,
      );
    }

    return {
      validacaoId: consumida.id,
      clienteId: resolvida.clienteId,
      contratoVersaoId,
    };
  }

  async function solicitarRecuperacao(
    cpfInformado: string,
    customDb?: DbExecutor,
  ): Promise<RecuperacaoIdentidadePublica> {
    const cpf = validarCpfObrigatorio(cpfInformado);
    const cliente = await buscarClienteCanonicoPorCpf(cpf, customDb);

    if (!cliente) {
      throw new IdentityServiceError(
        "CLIENTE_NAO_ENCONTRADO",
        "Nenhum Cliente existente foi encontrado para recuperação.",
        404,
      );
    }

    await criarRecuperacaoPendente(cliente.id, customDb);

    return { situacao: "RECUPERACAO_PENDENTE" };
  }

  return {
    consultarCpfPublico,
    iniciarDesafio,
    confirmarCodigo,
    resolverClientePorProva,
    consumirProvaParaFechamento,
    consumirProvaParaContrato,
    solicitarRecuperacao,
  };
}

/**
 * Factory para uso posterior nas rotas reais.
 * O provedor de envio continua sendo injetado explicitamente.
 */
export function criarIdentityServiceComAmbiente(
  enviarOtp: IdentityServiceOptions["enviarOtp"],
  overrides: Omit<Partial<IdentityServiceOptions>, "enviarOtp" | "otpPepper"> = {},
) {
  const otpPepper = process.env.IDENTIDADE_OTP_PEPPER;

  if (!otpPepper) {
    throw new IdentityServiceError(
      "CONFIGURACAO_IDENTIDADE_INVALIDA",
      "IDENTIDADE_OTP_PEPPER não configurada no ambiente.",
      500,
    );
  }

  return criarIdentityService({
    otpPepper,
    enviarOtp,
    ...overrides,
  });
}
