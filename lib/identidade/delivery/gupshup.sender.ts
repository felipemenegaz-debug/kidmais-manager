import type { OtpDelivery, OtpSubmission } from "../services/models.ts";
import { messageIdHash } from "../../integracoes/gupshup/correlacao.ts";

const GUPSHUP_TEMPLATE_ENDPOINT = "https://api.gupshup.io/wa/api/v1/template/msg";
const MAX_RESPONSE_BYTES = 16_384;

export type GupshupConfig = {
  apiKey: string;
  source: string;
  appName: string;
  templateId: string;
  defaultCountryCode: string;
  timeoutMs: number;
};

const ERROR_MESSAGES = {
  AUTHENTICATION: "Gupshup recusou a autenticação do envio de OTP.",
  TIMEOUT: "Gupshup excedeu o tempo limite do envio de OTP.",
  UNAVAILABLE: "Gupshup está temporariamente indisponível para envio de OTP.",
  INVALID_RESPONSE: "Gupshup retornou uma resposta inválida ao envio de OTP.",
  REJECTED: "Gupshup recusou a submissão do OTP.",
  INVALID_DESTINATION: "Destino de WhatsApp inválido.",
  INVALID_CHANNEL: "A V1 permite envio de OTP somente por WhatsApp.",
  INVALID_CONFIG: "Configuração do provedor Gupshup inválida ou incompleta.",
} as const;

export type GupshupOtpErrorCode = keyof typeof ERROR_MESSAGES;
type ConfigVariable =
  | "GUPSHUP_API_KEY" | "GUPSHUP_SOURCE" | "GUPSHUP_APP_NAME"
  | "GUPSHUP_OTP_TEMPLATE_ID" | "GUPSHUP_DEFAULT_COUNTRY_CODE" | "GUPSHUP_TIMEOUT_MS";

/** Somente código e mensagem estáticos; nunca carrega a causa ou o corpo remoto. */
export class GupshupOtpError extends Error {
  readonly code: GupshupOtpErrorCode;

  constructor(code: GupshupOtpErrorCode, variable?: ConfigVariable) {
    super(`${ERROR_MESSAGES[code]}${variable ? ` Verifique ${variable}.` : ""}`);
    this.name = "GupshupOtpError";
    this.code = code;
  }
}

function digitosTelefone(value: string) {
  if (typeof value !== "string" || value.length > 64) {
    throw new GupshupOtpError("INVALID_DESTINATION");
  }
  const trimmed = value.trim();
  if (
    !/^\+?[0-9 ()-]+$/.test(trimmed) ||
    (/[()]/.test(trimmed) && !/^[^()]*\([0-9]{1,4}\)[^()]*$/.test(trimmed))
  ) {
    throw new GupshupOtpError("INVALID_DESTINATION");
  }

  let digits = trimmed.replace(/[+ ()-]/g, "");
  const explicitInternational = trimmed.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("00") && !trimmed.startsWith("+")) digits = digits.slice(2);
  return { digits, explicitInternational };
}

function validarE164(digits: string) {
  if (!/^[1-9][0-9]{7,14}$/.test(digits) || /^[1-9]0+$/.test(digits)) {
    throw new GupshupOtpError("INVALID_DESTINATION");
  }
  // O Brasil usa DDD de dois dígitos e número local de oito ou nove dígitos.
  if (digits.startsWith("55") && !/^55[1-9][0-9][1-9][0-9]{7,8}$/.test(digits)) {
    throw new GupshupOtpError("INVALID_DESTINATION");
  }
  return digits;
}

/** Prefixos + e 00 são internacionais; números nacionais usam o DDI configurado. */
export function normalizarDestinoGupshup(value: string, defaultCountryCode = "55") {
  if (!/^[1-9][0-9]{0,2}$/.test(defaultCountryCode)) {
    throw new GupshupOtpError("INVALID_CONFIG");
  }
  const parsed = digitosTelefone(value);
  let digits = parsed.digits;
  if (
    defaultCountryCode === "55" && !parsed.explicitInternational &&
    digits.startsWith("0") && (digits.length === 11 || digits.length === 12)
  ) {
    digits = digits.slice(1);
  }
  if (!parsed.explicitInternational && digits.length < 10) {
    throw new GupshupOtpError("INVALID_DESTINATION");
  }
  // No NANP, onze dígitos iniciados em 1 já incluem o DDI, mesmo após o
  // cadastro remover o sinal +. Não duplicar o DDI configurado nesse caso.
  const includesNanpCountryCode = defaultCountryCode === "1" && digits.length === 11 && digits.startsWith("1");
  if (!parsed.explicitInternational && !includesNanpCountryCode && (digits.length === 10 || digits.length === 11)) {
    digits = `${defaultCountryCode}${digits}`;
  }
  return validarE164(digits);
}

function validarConfig(config: GupshupConfig): GupshupConfig {
  if (!config) throw new GupshupOtpError("INVALID_CONFIG");
  const checks: Array<[ConfigVariable, boolean]> = [
    ["GUPSHUP_API_KEY", typeof config.apiKey === "string" && /^sk_[A-Za-z0-9_-]{16,509}$/.test(config.apiKey)],
    // O webhook operacional também reconhece somente este aplicativo.
    ["GUPSHUP_APP_NAME", config.appName === "KidmaisManager"],
    ["GUPSHUP_OTP_TEMPLATE_ID", typeof config.templateId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(config.templateId)],
    ["GUPSHUP_DEFAULT_COUNTRY_CODE", typeof config.defaultCountryCode === "string" && /^[1-9][0-9]{0,2}$/.test(config.defaultCountryCode)],
    ["GUPSHUP_TIMEOUT_MS", Number.isInteger(config.timeoutMs) && config.timeoutMs >= 1_000 && config.timeoutMs <= 30_000],
  ];
  for (const [variable, valid] of checks) {
    if (!valid) throw new GupshupOtpError("INVALID_CONFIG", variable);
  }

  try {
    // Source identifica o número cadastrado no provedor e já deve conter DDI.
    const source = validarE164(digitosTelefone(config.source).digits);
    return { ...config, source };
  } catch {
    throw new GupshupOtpError("INVALID_CONFIG", "GUPSHUP_SOURCE");
  }
}

export function carregarGupshupConfig(env: NodeJS.ProcessEnv = process.env): GupshupConfig {
  const timeoutValue = env.GUPSHUP_TIMEOUT_MS?.trim() || "10000";
  if (!/^[0-9]+$/.test(timeoutValue)) throw new GupshupOtpError("INVALID_CONFIG", "GUPSHUP_TIMEOUT_MS");
  return validarConfig({
    apiKey: env.GUPSHUP_API_KEY?.trim() || "",
    source: env.GUPSHUP_SOURCE?.trim() || "",
    appName: env.GUPSHUP_APP_NAME?.trim() || "",
    templateId: env.GUPSHUP_OTP_TEMPLATE_ID?.trim() || "",
    defaultCountryCode: env.GUPSHUP_DEFAULT_COUNTRY_CODE?.trim() || "55",
    timeoutMs: Number(timeoutValue),
  });
}

function cancelarCorpo(response: Response) {
  // O corpo de erros não é necessário para classificá-los e pode conter segredos.
  void response.body?.cancel().catch(() => undefined);
}

export function criarGupshupSender(config: GupshupConfig, fetchImpl: typeof fetch = fetch) {
  // Cópia validada evita mudanças acidentais na configuração após criar o emissor.
  const validatedConfig = validarConfig(config);

  return async (delivery: OtpDelivery): Promise<OtpSubmission> => {
    if (delivery.canal !== "WHATSAPP") throw new GupshupOtpError("INVALID_CHANNEL");
    const destination = normalizarDestinoGupshup(delivery.destino, validatedConfig.defaultCountryCode);
    const body = new URLSearchParams({
      channel: "whatsapp",
      source: validatedConfig.source,
      destination,
      "src.name": validatedConfig.appName,
      template: JSON.stringify({ id: validatedConfig.templateId, params: [delivery.codigo, delivery.codigo] }),
    });
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new GupshupOtpError("TIMEOUT"));
        controller.abort();
        void reader?.cancel().catch(() => undefined);
      }, validatedConfig.timeoutMs);
    });

    const submit = async (): Promise<OtpSubmission> => {
      let response: Response;
      try {
        response = await fetchImpl(GUPSHUP_TEMPLATE_ENDPOINT, {
          method: "POST",
          headers: { apikey: validatedConfig.apiKey, "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: controller.signal,
          redirect: "error",
          cache: "no-store",
        });
      } catch {
        throw new GupshupOtpError(controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE");
      }

      if (response.status !== 202) {
        cancelarCorpo(response);
        if (response.status === 401 || response.status === 403) throw new GupshupOtpError("AUTHENTICATION");
        if (response.status === 429 || response.status >= 500) throw new GupshupOtpError("UNAVAILABLE");
        throw new GupshupOtpError(response.ok ? "INVALID_RESPONSE" : "REJECTED");
      }

      let result: unknown;
      try {
        if (!response.body) throw new Error();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let responseText = "";
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            void reader.cancel().catch(() => undefined);
            throw new Error();
          }
          responseText += decoder.decode(chunk.value, { stream: true });
        }
        result = JSON.parse(responseText + decoder.decode());
      } catch {
        throw new GupshupOtpError(controller.signal.aborted ? "TIMEOUT" : "INVALID_RESPONSE");
      } finally {
        void reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
      }

      if (
        !result || typeof result !== "object" ||
        !("status" in result) || result.status !== "submitted" ||
        !("messageId" in result) || typeof result.messageId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result.messageId)
      ) {
        throw new GupshupOtpError("INVALID_RESPONSE");
      }
      return { provider: "gupshup", status: "submitted", messageId: result.messageId };
    };

    try {
      // O prazo cobre conexão e leitura do corpo. Uma única submissão, sem retry.
      const submission = await Promise.race([submit(), deadline]);
      // Só após sucesso dentro do prazo: não registrar resposta bruta, destino ou OTP.
      console.info(JSON.stringify({ provider: "gupshup", status: "submitted", messageIdHash: messageIdHash(submission.messageId) }));
      return submission;
    } finally {
      clearTimeout(timeout);
    }
  };
}
