import type { ClasseAcao } from "./contratos.ts";

/**
 * Canais do Kidmais Intelligence (Fase 28) — interface preparada, sem implementação de WhatsApp.
 *
 * Hoje só existe o canal ADMIN (drawer e telas). Um futuro canal WHATSAPP entra pelo mesmo orquestrador,
 * com estas travas, e nunca pelo fluxo transacional de acesso público (lib/contratos/acesso-publico),
 * que continua separado e sem LLM.
 *
 * - Remetente e empresa vêm do roteamento verificado do provedor (número da empresa + webhook assinado),
 *   nunca do texto da mensagem.
 * - No WhatsApp o agente só consulta e sugere. Qualquer ação CONFIRM vira um rascunho que precisa ser
 *   confirmado dentro do Admin, por usuário autenticado; OTP nunca passa pelo agente.
 * - Envio proativo (disparo) não é capacidade do agente.
 */
export type Canal = "ADMIN" | "WHATSAPP";

export type RemetenteVerificado =
  | { tipo: "USUARIO_ADMIN"; usuarioId: string }
  | { tipo: "CONTATO_EMPRESA"; empresaId: string; contatoId: string };

export type MensagemCanal = {
  canal: Canal;
  remetente: RemetenteVerificado;
  texto: string;
  recebidoEm: string;
};

export type PoliticaCanal = {
  classesPermitidas: readonly ClasseAcao[];
  confirmacao: "NO_PROPRIO_CANAL" | "SOMENTE_NO_ADMIN";
  podeEnviarProativo: false;
};

export const POLITICA_CANAIS: Readonly<Record<Canal, PoliticaCanal>> = Object.freeze({
  ADMIN: { classesPermitidas: ["READ", "SUGGEST", "CONFIRM"], confirmacao: "NO_PROPRIO_CANAL", podeEnviarProativo: false },
  WHATSAPP: { classesPermitidas: ["READ", "SUGGEST"], confirmacao: "SOMENTE_NO_ADMIN", podeEnviarProativo: false },
});

/** O canal permite a classe? DENY nunca; CONFIRM no WhatsApp nunca executa no próprio canal. */
export function canalPermite(canal: Canal, classe: ClasseAcao) {
  return classe !== "DENY" && POLITICA_CANAIS[canal].classesPermitidas.includes(classe);
}
