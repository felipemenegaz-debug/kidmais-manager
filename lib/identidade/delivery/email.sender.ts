import type { EnviarEmail, MensagemEmail } from "../../acessos/email.ts";
import type { IdentityOtpSender, OtpDelivery } from "../services/models.ts";

/**
 * Código de validação por e-mail: reserva quando o WhatsApp falha (decisão de Felipe, 12/11/2026).
 * O destino é sempre o e-mail do cadastro do cliente, resolvido no servidor pelo serviço de identidade.
 * Nunca registra destino, código ou corpo em log; o erro devolvido é genérico.
 */

function minutosAte(expiraEm: string, agora: Date) {
  const ms = new Date(expiraEm).getTime() - agora.getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 1;
}

export function mensagemCodigoOtpEmail(delivery: OtpDelivery, agora: Date = new Date()): MensagemEmail {
  if (!/^\d{6}$/.test(delivery.codigo)) throw new Error("Código de validação inválido.");
  const minutos = minutosAte(delivery.expiraEm, agora);
  const paragrafos = [
    `Seu código de validação do iA.Fest é ${delivery.codigo}.`,
    `Ele vale por ${minutos} minutos e serve para confirmar que é você quem está assinando ou confirmando com o buffet.`,
    "Não compartilhe este código com ninguém. A equipe do buffet e do iA.Fest nunca pede o código.",
  ];
  const texto = `${paragrafos.join("\n\n")}\n\nSe você não pediu este código, ignore esta mensagem.`;
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">' +
    `<p>Seu código de validação do iA.Fest é:</p>` +
    `<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${delivery.codigo}</p>` +
    paragrafos.slice(1).map((p) => `<p>${p}</p>`).join("") +
    '<p style="color:#555;font-size:13px">Se você não pediu este código, ignore esta mensagem.</p></div>';
  return {
    para: delivery.destino,
    assunto: `Seu código do iA.Fest: ${delivery.codigo}`,
    texto,
    html,
    idempotencia: `otp-email:${delivery.validacaoId}`,
  };
}

export function criarEmailOtpSender(enviarEmail: EnviarEmail, agora: () => Date = () => new Date()): IdentityOtpSender {
  return async (delivery) => {
    if (delivery.canal !== "EMAIL") throw new Error("Este envio aceita somente o canal EMAIL.");
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(delivery.destino.trim())) {
      throw new Error("Destino de e-mail inválido.");
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(delivery.validacaoId)) throw new Error("Validação inválida.");
    try {
      await enviarEmail(mensagemCodigoOtpEmail({ ...delivery, destino: delivery.destino.trim() }, agora()));
    } catch {
      throw new Error("O envio do código por e-mail falhou.");
    }
  };
}
