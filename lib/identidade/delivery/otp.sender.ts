import type { IdentityOtpSender, OtpDelivery } from "../services";

const DEFAULT_TIMEOUT_MS = 10_000;
const META_GRAPH_ORIGIN = "https://graph.facebook.com";

type FetchLike = typeof fetch;

export type WhatsappCloudConfig = {
  graphApiVersion: string;
  phoneNumberId: string;
  accessToken: string;
  templateName: string;
  templateLanguage: string;
  defaultCountryCode: string;
  timeoutMs: number;
};

type OtpProviderConfig =
  | { provider: "console" }
  | { provider: "whatsapp_cloud"; whatsapp: WhatsappCloudConfig };

function envObrigatoria(nome: string) {
  const value = process.env[nome]?.trim();
  if (!value) throw new Error(`${nome} não configurada.`);
  return value;
}

function carregarWhatsappCloudConfig(): WhatsappCloudConfig {
  const graphApiVersion = envObrigatoria("WHATSAPP_CLOUD_API_VERSION");
  const phoneNumberId = envObrigatoria("WHATSAPP_CLOUD_PHONE_NUMBER_ID");
  const accessToken = envObrigatoria("WHATSAPP_CLOUD_ACCESS_TOKEN");
  const templateName = envObrigatoria("WHATSAPP_OTP_TEMPLATE_NAME");
  const templateLanguage =
    process.env.WHATSAPP_OTP_TEMPLATE_LANGUAGE?.trim() || "pt_BR";
  const defaultCountryCode =
    process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.trim() || "55";
  const timeoutValue =
    process.env.WHATSAPP_CLOUD_TIMEOUT_MS?.trim() ||
    String(DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number(timeoutValue);

  if (!/^v\d+(?:\.\d+)?$/.test(graphApiVersion)) {
    throw new Error("WHATSAPP_CLOUD_API_VERSION inválida.");
  }
  if (!/^\d{5,32}$/.test(phoneNumberId)) {
    throw new Error("WHATSAPP_CLOUD_PHONE_NUMBER_ID inválida.");
  }
  if (accessToken.length < 20) {
    throw new Error("WHATSAPP_CLOUD_ACCESS_TOKEN inválido.");
  }
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
    throw new Error("WHATSAPP_OTP_TEMPLATE_NAME inválido.");
  }
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(templateLanguage)) {
    throw new Error("WHATSAPP_OTP_TEMPLATE_LANGUAGE inválido.");
  }
  if (
    !/^\d{1,3}$/.test(defaultCountryCode) ||
    defaultCountryCode.startsWith("0")
  ) {
    throw new Error("WHATSAPP_DEFAULT_COUNTRY_CODE inválido.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error("WHATSAPP_CLOUD_TIMEOUT_MS deve estar entre 1000 e 30000.");
  }

  return {
    graphApiVersion,
    phoneNumberId,
    accessToken,
    templateName,
    templateLanguage,
    defaultCountryCode,
    timeoutMs,
  };
}

function carregarOtpProviderConfig(): OtpProviderConfig {
  const provider = (process.env.IDENTIDADE_OTP_PROVIDER ?? "")
    .trim()
    .toLowerCase();

  if (provider === "console") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "IDENTIDADE_OTP_PROVIDER=console não é permitido em produção.",
      );
    }
    return { provider: "console" };
  }

  if (provider === "whatsapp_cloud") {
    return { provider, whatsapp: carregarWhatsappCloudConfig() };
  }

  throw new Error(
    "IDENTIDADE_OTP_PROVIDER deve ser whatsapp_cloud em produção.",
  );
}

export function validarConfiguracaoOtpAmbiente() {
  carregarOtpProviderConfig();
}

export function normalizarDestinoWhatsapp(
  value: string,
  defaultCountryCode = "55",
) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (
    digits.startsWith("0") &&
    (digits.length === 11 || digits.length === 12)
  ) {
    digits = digits.slice(1);
  }

  if (digits.length === 10 || digits.length === 11) {
    digits = `${defaultCountryCode}${digits}`;
  }

  if (!/^\d{10,15}$/.test(digits) || digits.startsWith("0")) {
    throw new Error("Destino de WhatsApp inválido.");
  }

  return digits;
}

function payloadTemplateOtp(delivery: OtpDelivery, config: WhatsappCloudConfig) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizarDestinoWhatsapp(
      delivery.destino,
      config.defaultCountryCode,
    ),
    type: "template",
    template: {
      name: config.templateName,
      language: { code: config.templateLanguage },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: delivery.codigo }],
        },
      ],
    },
  };
}

export function criarWhatsappCloudSender(
  config: WhatsappCloudConfig,
  fetchImpl: FetchLike = fetch,
): IdentityOtpSender {
  return async (delivery) => {
    if (delivery.canal !== "WHATSAPP") {
      throw new Error("A V1 permite envio de OTP somente por WhatsApp.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetchImpl(
        `${META_GRAPH_ORIGIN}/${config.graphApiVersion}/${config.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payloadTemplateOtp(delivery, config)),
          signal: controller.signal,
        },
      );

      const result = (await response.json().catch(() => null)) as {
        messages?: Array<{ id?: string }>;
        error?: { code?: number };
      } | null;

      if (!response.ok || !result?.messages?.[0]?.id) {
        const providerCode = result?.error?.code;
        throw new Error(
          `WhatsApp Cloud API recusou o envio (HTTP ${response.status}, código ${providerCode ?? "indisponível"}).`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("WhatsApp Cloud API excedeu o tempo limite.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * Emissor selecionado apenas por configuração do servidor.
 * `console` existe exclusivamente para desenvolvimento; produção aceita somente
 * a integração oficial WhatsApp Cloud API.
 */
export const enviarOtpComAmbiente: IdentityOtpSender = async (delivery) => {
  const config = carregarOtpProviderConfig();

  if (config.provider === "console") {
    console.info(
      [
        "[Kidmais Identidade][OTP DEV]",
        `validacaoId=${delivery.validacaoId}`,
        `canal=${delivery.canal}`,
        `codigo=${delivery.codigo}`,
        `expiraEm=${delivery.expiraEm}`,
      ].join(" "),
    );
    return;
  }

  return criarWhatsappCloudSender(config.whatsapp)(delivery);
};
