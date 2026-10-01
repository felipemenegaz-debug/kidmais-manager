import { CHAVE_AGENTES, type RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { criarRegistroAgentes } from "@/lib/inteligencia/agentes/agentes";

/**
 * Composição da feature AGENTES: quatro agentes determinísticos (Atendimento, Analista Operacional, Documentos e
 * Copiloto Administrativo) com plano fechado. Só entram pela Demerzel (AI_DEMERZEL_ENABLED), usando as portas
 * contadas da orquestração; leituras pelo catálogo do operador e ações apenas como proposta no Human Gate.
 */
export function registrarAgentes(registro: RegistroExtensoes) {
  registro.definir(CHAVE_AGENTES, () => criarRegistroAgentes());
}
