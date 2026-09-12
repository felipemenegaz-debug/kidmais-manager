import { createHmac, timingSafeEqual } from "node:crypto";

import { ContratoServiceError } from "./errors.ts";

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

type ContratoAcessoTokenPayload = {
  v: 1;
  contratoId: string;
  versaoId: string;
  validacaoId: string;
  exp: number;
};

function secret() {
  const value = process.env.IDENTIDADE_OTP_PEPPER?.trim() ?? "";
  if (value.length < 16) {
    throw new ContratoServiceError(
      "CONTRATO_ACESSO_NAO_AUTORIZADO",
      "Não foi possível validar o acesso a este Contrato.",
      404,
    );
  }
  return value;
}

function assinatura(payloadB64: string) {
  return createHmac("sha256", secret())
    .update("kidmais-contrato-acesso-v1|")
    .update(payloadB64)
    .digest("base64url");
}

function assinaturasIguais(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function criarContratoAcessoToken(input: {
  contratoId: string;
  versaoId: string;
  validacaoId: string;
  ttlMs?: number;
}) {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const payload: ContratoAcessoTokenPayload = {
    v: TOKEN_VERSION,
    contratoId: input.contratoId,
    versaoId: input.versaoId,
    validacaoId: input.validacaoId,
    exp: Date.now() + ttl,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${assinatura(payloadB64)}`;
}

export function validarContratoAcessoToken(
  token: string,
  esperado: { contratoId: string; versaoId?: string },
): ContratoAcessoTokenPayload {
  try {
    const [payloadB64, assinaturaRecebida, extra] = token.trim().split(".");
    if (!payloadB64 || !assinaturaRecebida || extra) throw new Error("formato");

    const assinaturaEsperada = assinatura(payloadB64);
    if (!assinaturasIguais(assinaturaRecebida, assinaturaEsperada)) throw new Error("assinatura");

    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as Partial<ContratoAcessoTokenPayload>;

    if (
      payload.v !== TOKEN_VERSION ||
      typeof payload.contratoId !== "string" ||
      typeof payload.versaoId !== "string" ||
      typeof payload.validacaoId !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp <= Date.now() ||
      payload.contratoId !== esperado.contratoId ||
      typeof payload.versaoId !== 'string' ||
      (esperado.versaoId !== undefined && payload.versaoId !== esperado.versaoId)
    ) {
      throw new Error("payload");
    }

    return payload as ContratoAcessoTokenPayload;
  } catch {
    throw new ContratoServiceError(
      "CONTRATO_ACESSO_NAO_AUTORIZADO",
      "Não foi possível validar o acesso a este Contrato.",
      404,
    );
  }
}
