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

/** Segundos que faltam até `alvoMs` (arredondados para cima; 0 quando já passou). */
export function segundosAte(alvoMs: number, agoraMs: number) {
  if (!Number.isFinite(alvoMs)) return 0;
  return Math.max(0, Math.ceil((alvoMs - agoraMs) / 1000));
}

/** "0:45", "1:05". */
export function formatarCronometro(segundos: number) {
  const s = Math.max(0, Math.floor(segundos));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Texto do botão "Receber por e-mail". Enquanto a espera mínima do servidor não passou, mostra quanto falta
 * (o botão continua desabilitado: o servidor recusaria com 429).
 */
export function textoBotaoReservaEmail(liberada: boolean, segundosRestantes: number, destinoMascarado: string) {
  if (liberada) return `Não recebeu? Receber por e-mail (${destinoMascarado})`;
  if (segundosRestantes > 0) return `Não recebeu? Receber por e-mail em ${formatarCronometro(segundosRestantes)}`;
  return "Não recebeu? Em instantes você poderá receber por e-mail";
}

/**
 * Espera do botão "Receber por e-mail": `liberada` quando a espera mínima depois do WhatsApp já passou e
 * `segundosRestantes` para o cronômetro (atualizado a cada segundo enquanto falta tempo).
 */
export function useReservaEmailEspera(liberaEm: string | null | undefined) {
  const [agora, setAgora] = useState(() => Date.now());
  const alvo = liberaEm ? Date.parse(liberaEm) : Number.NaN;

  useEffect(() => {
    if (!Number.isFinite(alvo)) return;
    // Os callbacks só rodam depois que `intervalo` já existe.
    const atualizar = () => {
      const atual = Date.now();
      setAgora(atual);
      if (atual >= alvo) clearInterval(intervalo);
    };
    // Primeira leitura logo em seguida (o "agora" inicial pode ser da montagem da tela), depois a cada segundo.
    const primeiro = setTimeout(atualizar, 0);
    const intervalo = setInterval(atualizar, 1000);
    return () => {
      clearTimeout(primeiro);
      clearInterval(intervalo);
    };
  }, [alvo]);

  const liberada = Number.isFinite(alvo) && agora >= alvo;
  return { liberada, segundosRestantes: liberada ? 0 : segundosAte(alvo, agora) };
}
