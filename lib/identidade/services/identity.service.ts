import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

import type { DbExecutor } from "../../db/contracts";
import {
  buscarClienteCanonicoPorCnpjParaIdentidade,
  buscarClienteCanonicoPorCpfParaIdentidade,
  buscarClienteCanonicoPorId,
  migration112Aplicada,
  type ClienteRecord,
  type EscopoIdentidade,
} from "../../clientes/repositories";
import { classificarDocumentoIdentidade, pareceCpf, type DocumentoIdentidade } from "../documento";
import {
  buscarProvaConfirmadaPorTokenHash,
  buscarValidacaoPorId,
  cancelarValidacaoPendente,
  confirmarValidacao,
  consumirProvaIdentidade,
  consumirProvaIdentidadeParaContrato,
  criarDesafioIdentidade,
  criarRecuperacaoPendente,
  reabrirValidacaoCancelada,
  registrarEnvioOtp,
  registrarTentativaInvalida,
  type ValidacaoIdentidadeCanal,
  type ValidacaoIdentidadeFinalidade,
  type ValidacaoIdentidadeRecord,
} from "../repositories";
import { otpDesabilitadoNoStaging, reservaEmailOtpDisponivel } from "../configuracao-otp.ts";
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
const DEFAULT_RESERVA_EMAIL_ESPERA_MS = 60 * 1000;

function adicionarMs(base: Date, milliseconds: number) {
  return new Date(base.getTime() + milliseconds);
}

function somenteDigitos(value: string) {
  return value.replace(/\D/g, "");
}

/**
 * CPF ou CNPJ (R2-1). Quem digita só números até 11 recebe o erro de hoje (CPF_INVALIDO); o resto, DOCUMENTO_INVALIDO.
 */
function validarDocumentoObrigatorio(informado: string): DocumentoIdentidade {
  const documento = classificarDocumentoIdentidade(informado);
  if (documento) return documento;
  if (pareceCpf(informado)) throw new IdentityServiceError("CPF_INVALIDO", "Informe um CPF válido.", 400, { campo: "cpf" });
  throw new IdentityServiceError("DOCUMENTO_INVALIDO", "Informe um CPF ou CNPJ válido.", 400, { campo: "documento" });
}

/**
 * Cliente canônico do documento no escopo. CNPJ exige a 112 (conferida na transação, sem cache): sem ela,
 * PJ_INDISPONIVEL/MIGRACAO_PENDENTE (R21-4), sem consultar coluna inexistente.
 */
async function clienteDoDocumento(documento: DocumentoIdentidade, escopo: EscopoIdentidade, customDb?: DbExecutor) {
  if (documento.tipo === "CPF") return buscarClienteCanonicoPorCpfParaIdentidade(documento.valor, escopo, customDb);
  if (!(await migration112Aplicada(customDb))) {
    throw new IdentityServiceError("PJ_INDISPONIVEL", "Acesso por CNPJ ainda não está disponível nesta instalação.", 409, { motivo: "MIGRACAO_PENDENTE", campo: "documento" });
  }
  return buscarClienteCanonicoPorCnpjParaIdentidade(documento.valor, escopo, customDb);
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

/** E-mail do cadastro do cliente usado na reserva; nunca vem do navegador. */
function emailDeReserva(cliente: ClienteRecord, reservaEmail: boolean) {
  const email = cliente.email?.trim();
  return reservaEmail && email ? email : null;
}

function canaisDisponiveis(cliente: ClienteRecord, reservaEmail: boolean): CanalIdentidadePublico[] {
  const canais: CanalIdentidadePublico[] = [];

  // WhatsApp transacional é o canal principal. O e-mail do cadastro só aparece como canal quando a reserva está
  // ligada e o cliente não tem WhatsApp; com WhatsApp, o e-mail é reserva (falha do envio ou pedido do cliente).
  // SMS permanece modelado para evolução futura.
  if (cliente.whatsapp) {
    canais.push({
      canal: "WHATSAPP",
      destinoMascarado: mascararTelefoneIdentidade(cliente.whatsapp),
    });
  } else {
    const email = emailDeReserva(cliente, reservaEmail);
    if (email) canais.push({ canal: "EMAIL", destinoMascarado: mascararEmailIdentidade(email) });
  }

  return canais;
}

/** Linha de operação sem destino, código, cliente ou validação: só por que a reserva entrou. */
function registrarReservaEmail(motivo: "FALHA_WHATSAPP" | "PEDIDO_CLIENTE") {
  console.warn(JSON.stringify({ otp: "reserva_email", motivo }));
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
    ["reservaEmailEsperaMs", options.reservaEmailEsperaMs ?? DEFAULT_RESERVA_EMAIL_ESPERA_MS],
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

/** Escopo obrigatório: a busca por CPF nunca é global (empresa do endereço ou cliente do contrato). */
function exigirEscopo(escopo: EscopoIdentidade | undefined): EscopoIdentidade {
  if (!escopo || ("clienteId" in escopo ? !escopo.clienteId : !escopo.empresaId)) {
    throw new IdentityServiceError("ESCOPO_IDENTIDADE_AUSENTE", "A validação de identidade está indisponível neste endereço.", 503);
  }
  return escopo;
}

export async function consultarCpfPublico(
  cpfInformado: string,
  escopo: EscopoIdentidade,
  customDb?: DbExecutor,
  reservaEmail: boolean = reservaEmailOtpDisponivel(),
): Promise<ConsultaCpfPublicaResult> {
  const documento = validarDocumentoObrigatorio(cpfInformado);
  const cliente = await clienteDoDocumento(documento, exigirEscopo(escopo), customDb);

  if (!cliente) {
    return { situacao: "NOVO_CLIENTE", canais: [] };
  }

  const canais = canaisDisponiveis(cliente, reservaEmail);
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
/** Contadores do desafio anterior que o desafio novo (troca para o e-mail) precisa respeitar. */
type LimitesHerdados = Pick<ValidacaoIdentidadeRecord, "tentativas" | "envios" | "maxTentativas" | "maxEnvios">;

export function criarIdentityService(options: IdentityServiceOptions) {
  validarConfiguracao(options);

  const now = options.now ?? (() => new Date());
  const gerarOtp = options.gerarOtp ?? otpPadrao;
  const gerarProvaToken = options.gerarProvaToken ?? provaTokenPadrao;
  const otpTtlMs = options.otpTtlMs ?? DEFAULT_OTP_TTL_MS;
  const provaTtlMs = options.provaTtlMs ?? DEFAULT_PROVA_TTL_MS;
  const maxTentativas = options.maxTentativas ?? DEFAULT_MAX_TENTATIVAS;
  const maxEnvios = options.maxEnvios ?? DEFAULT_MAX_ENVIOS;
  const reservaEmail = options.reservaEmail ?? false;
  const reservaEmailEsperaMs = options.reservaEmailEsperaMs ?? DEFAULT_RESERVA_EMAIL_ESPERA_MS;

  async function iniciarDesafio(
    input: IniciarDesafioIdentidadeInput,
    customDb?: DbExecutor,
  ): Promise<DesafioIdentidadePublico> {
    const documento = validarDocumentoObrigatorio(input.cpf);
    const cliente = await clienteDoDocumento(documento, exigirEscopo(input.escopo), customDb);

    if (!cliente) {
      throw new IdentityServiceError(
        "CLIENTE_NAO_ENCONTRADO",
        "Nenhum Cliente existente foi encontrado para validação.",
        404,
      );
    }

    const emailReserva = emailDeReserva(cliente, reservaEmail);
    const destino = destinoDoCanal(cliente, input.canal);
    // E-mail como canal inicial só para quem não tem WhatsApp (com WhatsApp, o e-mail é reserva).
    const emailNaoPermitido =
      input.canal === "EMAIL" && (!emailReserva || Boolean(cliente.whatsapp));
    if (!destino || emailNaoPermitido) {
      throw new IdentityServiceError(
        "CANAL_INDISPONIVEL",
        "O canal selecionado não está disponível para este cadastro.",
        400,
        { canal: input.canal },
      );
    }

    const finalidade = input.finalidade ?? "FECHAMENTO_PUBLICO";
    try {
      const emitido = await emitirDesafio(cliente, finalidade, input.canal, destino, customDb);
      return {
        ...desafioPublico(emitido, input.canal, destino),
        ...(input.canal === "WHATSAPP" && emailReserva
          ? { reservaEmail: { destinoMascarado: mascararEmailIdentidade(emailReserva), liberaEm: emitido.liberaReservaEm } }
          : {}),
      };
    } catch (error) {
      // Reserva automática: só quando o próprio envio pelo WhatsApp falhou (nunca depois de enviado).
      const falhouNoEnvio =
        error instanceof IdentityServiceError &&
        error.code === "FALHA_ENVIO_OTP" &&
        error.details?.etapa === "ENVIO";
      if (!falhouNoEnvio || input.canal !== "WHATSAPP" || !emailReserva) throw error;

      registrarReservaEmail("FALHA_WHATSAPP");
      // O desafio do WhatsApp nunca foi enviado; encerrá-lo evita dois códigos pendentes. O do e-mail herda os limites.
      const anterior = await cancelarValidacaoPendente(String(error.details?.validacaoId), customDb);
      const emitido = await emitirOuDescartar(cliente, finalidade, "EMAIL", emailReserva, customDb, anterior);
      return { ...desafioPublico(emitido, "EMAIL", emailReserva), reserva: "FALHA_WHATSAPP" };
    }
  }

  function desafioPublico(
    emitido: { validacaoId: string; expiraEm: string },
    canal: ValidacaoIdentidadeCanal,
    destino: string,
  ): DesafioIdentidadePublico {
    return {
      validacaoId: emitido.validacaoId,
      canal,
      destinoMascarado: mascararDestino(canal, destino),
      expiraEm: emitido.expiraEm,
    };
  }

  /** Gera o código, grava o desafio (só o HMAC), envia e registra o envio. */
  async function emitirDesafio(
    cliente: ClienteRecord,
    finalidade: ValidacaoIdentidadeFinalidade,
    canal: ValidacaoIdentidadeCanal,
    destino: string,
    customDb?: DbExecutor,
    herdado?: LimitesHerdados | null,
  ) {
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
      canal,
      codigoExpiraEm: expiraEm,
    });

    const validacao = await criarDesafioIdentidade(
      {
        clienteId: cliente.id,
        finalidade,
        canal,
        codigoHash,
        codigoExpiraEm: expiraEm,
        // P1 do Astra (12/11): trocar de canal não zera tentativas nem envios do desafio anterior.
        maxTentativas: herdado?.maxTentativas ?? maxTentativas,
        maxEnvios: herdado?.maxEnvios ?? maxEnvios,
        tentativas: herdado?.tentativas ?? 0,
        envios: herdado?.envios ?? 0,
      },
      customDb,
    );

    // `etapa` separa a falha do provedor (ENVIO, elegível à reserva) da falha ao registrar um envio já feito.
    let etapa: "ENVIO" | "REGISTRO" = "ENVIO";
    try {
      await options.enviarOtp({
        validacaoId: validacao.id,
        canal,
        destino,
        codigo,
        expiraEm,
      });

      etapa = "REGISTRO";
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

      const enviadoEm = new Date(envioRegistrado.ultimoEnvioEm ?? now().toISOString());
      const baseReserva = Number.isFinite(enviadoEm.getTime()) ? enviadoEm : now();
      return {
        validacaoId: validacao.id,
        expiraEm,
        liberaReservaEm: adicionarMs(baseReserva, reservaEmailEsperaMs).toISOString(),
      };
    } catch (error) {
      throw new IdentityServiceError(
        "FALHA_ENVIO_OTP",
        "Não foi possível enviar o código de validação.",
        503,
        {
          validacaoId: validacao.id,
          etapa,
          causa: error instanceof Error ? error.message : "erro_desconhecido",
        },
      );
    }
  }

  /** Emite o desafio; se falhar, cancela o que chegou a ser criado (nunca fica um código pendente sem envio). */
  async function emitirOuDescartar(
    cliente: ClienteRecord,
    finalidade: ValidacaoIdentidadeFinalidade,
    canal: ValidacaoIdentidadeCanal,
    destino: string,
    customDb: DbExecutor | undefined,
    herdado: LimitesHerdados | null,
  ) {
    try {
      return await emitirDesafio(cliente, finalidade, canal, destino, customDb, herdado);
    } catch (error) {
      const criada = error instanceof IdentityServiceError ? error.details?.validacaoId : undefined;
      if (typeof criada === "string") await cancelarValidacaoPendente(criada, customDb).catch(() => null);
      throw error;
    }
  }

  /**
   * Botão "Não recebeu? Receber por e-mail": troca um desafio pendente do WhatsApp por um código novo no e-mail do
   * cadastro. Exige a reserva ligada, a espera mínima desde o envio e o desafio ainda pendente e válido; o código do
   * WhatsApp deixa de valer. Mesma finalidade, mesmo cliente, mesmos limites.
   */
  async function receberCodigoPorEmail(
    validacaoId: string,
    customDb?: DbExecutor,
  ): Promise<DesafioIdentidadePublico> {
    const indisponivel = () =>
      new IdentityServiceError(
        "RESERVA_EMAIL_INDISPONIVEL",
        "O envio do código por e-mail não está disponível para esta validação.",
        409,
      );
    if (!reservaEmail) throw indisponivel();

    const validacao = await buscarValidacaoPorId(validacaoId, customDb);
    if (!validacao) {
      throw new IdentityServiceError(
        "VALIDACAO_NAO_ENCONTRADA",
        "Validação de identidade não encontrada.",
        404,
      );
    }
    assertValidacaoPendente(validacao);
    if (validacao.canal !== "WHATSAPP") throw indisponivel();

    const expiraEmMs = new Date(validacao.codigoExpiraEm ?? "").getTime();
    if (!Number.isFinite(expiraEmMs) || expiraEmMs <= now().getTime()) {
      throw new IdentityServiceError(
        "CODIGO_EXPIRADO",
        "O código de validação expirou.",
        410,
      );
    }

    const baseMs = new Date(validacao.ultimoEnvioEm ?? validacao.criadoEm).getTime();
    const liberaEmMs = baseMs + reservaEmailEsperaMs;
    if (!Number.isFinite(liberaEmMs) || now().getTime() < liberaEmMs) {
      throw new IdentityServiceError(
        "RESERVA_EMAIL_AGUARDE",
        "Aguarde um pouco: o código pelo WhatsApp pode ainda estar chegando.",
        429,
        Number.isFinite(liberaEmMs) ? { liberaEm: new Date(liberaEmMs).toISOString() } : undefined,
      );
    }

    const cliente = await buscarClienteCanonicoPorId(validacao.clienteId, customDb);
    if (!cliente) {
      throw new IdentityServiceError(
        "CLIENTE_NAO_ENCONTRADO",
        "Cliente canônico não encontrado.",
        404,
      );
    }
    const email = emailDeReserva(cliente, reservaEmail);
    if (!email) throw indisponivel();
    if (validacao.envios >= validacao.maxEnvios) {
      throw new IdentityServiceError(
        "LIMITE_ENVIOS_OTP",
        "O limite de envios do código foi atingido. Comece a validação de novo.",
        429,
      );
    }

    // Só um pedido vence (cliques repetidos ou abas paralelas): o perdedor recebe VALIDACAO_NAO_PENDENTE.
    const cancelada = await cancelarValidacaoPendente(validacao.id, customDb);
    if (!cancelada) {
      throw new IdentityServiceError(
        "VALIDACAO_NAO_PENDENTE",
        "Esta validação não está mais pendente.",
        409,
      );
    }

    registrarReservaEmail("PEDIDO_CLIENTE");
    let emitido: Awaited<ReturnType<typeof emitirDesafio>>;
    try {
      emitido = await emitirOuDescartar(cliente, validacao.finalidade, "EMAIL", email, customDb, cancelada);
    } catch (error) {
      // P2 do Astra (12/11): se o e-mail falha, o código do WhatsApp volta a valer (mesmo id, mesmo acesso da tela).
      await reabrirValidacaoCancelada(validacao.id, customDb).catch(() => null);
      throw error;
    }
    return { ...desafioPublico(emitido, "EMAIL", email), reserva: "PEDIDO_CLIENTE" };
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
      canal: consumida.canal,
    };
  }

  async function solicitarRecuperacao(
    cpfInformado: string,
    escopo: EscopoIdentidade,
    customDb?: DbExecutor,
  ): Promise<RecuperacaoIdentidadePublica> {
    const documento = validarDocumentoObrigatorio(cpfInformado);
    const cliente = await clienteDoDocumento(documento, exigirEscopo(escopo), customDb);

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
    receberCodigoPorEmail,
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
  try {
    if (otpDesabilitadoNoStaging()) {
      throw new IdentityServiceError(
        "OTP_INDISPONIVEL",
        "A validação por código está temporariamente indisponível neste ambiente de staging.",
        503,
      );
    }
  } catch (error) {
    if (error instanceof IdentityServiceError) throw error;
    throw new IdentityServiceError(
      "CONFIGURACAO_IDENTIDADE_INVALIDA",
      "A configuração do provedor de OTP é inválida.",
      500,
    );
  }

  const otpPepper = process.env.IDENTIDADE_OTP_PEPPER;

  if (!otpPepper) {
    throw new IdentityServiceError(
      "CONFIGURACAO_IDENTIDADE_INVALIDA",
      "IDENTIDADE_OTP_PEPPER não configurada no ambiente.",
      500,
    );
  }

  let reservaEmail: boolean;
  try {
    reservaEmail = reservaEmailOtpDisponivel();
  } catch {
    throw new IdentityServiceError(
      "CONFIGURACAO_IDENTIDADE_INVALIDA",
      "A configuração da reserva por e-mail é inválida.",
      500,
    );
  }

  return criarIdentityService({
    otpPepper,
    enviarOtp,
    reservaEmail,
    ...overrides,
  });
}
