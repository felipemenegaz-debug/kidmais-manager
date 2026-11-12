"use client";

import { useEffect, useState } from "react";

/** Resposta pública de um envio de código (iniciar ou receber por e-mail). Nunca contém o destino real nem o código. */
export type EnvioCodigoPublico = {
  canal: "WHATSAPP" | "SMS" | "EMAIL";
  destinoMascarado: string;
  reserva?: "FALHA_WHATSAPP" | "PEDIDO_CLIENTE";
  reservaEmail?: { destinoMascarado: string; liberaEm: string };
};

export function rotuloCanal(canal: EnvioCodigoPublico["canal"]) {
  return canal === "EMAIL" ? "E-mail" : "WhatsApp";
}

/** Frase da tela do código: por onde foi e, na reserva automática, por que foi para o e-mail. */
export function textoEnvioCodigo(envio: EnvioCodigoPublico | null) {
  if (!envio) return "Informe o código de 6 dígitos enviado pelo WhatsApp.";
  if (envio.canal === "EMAIL") {
    const motivo = envio.reserva === "FALHA_WHATSAPP"
      ? "Não conseguimos enviar pelo WhatsApp agora, então mandamos o código para o seu e-mail cadastrado. "
      : "";
    return `${motivo}Informe o código de 6 dígitos enviado para o e-mail ${envio.destinoMascarado}. Confira também a caixa de spam.`;
  }
  return `Informe o código de 6 dígitos enviado pelo WhatsApp para ${envio.destinoMascarado}.`;
}

/** true quando o botão "Receber por e-mail" pode ser usado (a espera mínima depois do WhatsApp já passou). */
export function useReservaEmailLiberada(liberaEm: string | null | undefined) {
  const [agora, setAgora] = useState(() => Date.now());
  const alvo = liberaEm ? Date.parse(liberaEm) : Number.NaN;

  useEffect(() => {
    if (!Number.isFinite(alvo)) return;
    const espera = Math.max(0, alvo - Date.now());
    const timer = setTimeout(() => setAgora(Date.now()), espera + 250);
    return () => clearTimeout(timer);
  }, [alvo]);

  return Number.isFinite(alvo) && agora >= alvo;
}
