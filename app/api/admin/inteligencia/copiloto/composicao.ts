import { CHAVE_COPILOTO, type RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { criarComplementador } from "@/lib/inteligencia/copiloto/complementador";

/**
 * Composição da feature COPILOTO: complemento de leituras já autorizadas (próxima ação por procedimento de skill
 * e explicação validada contra os dados). Entra no CORE só pelo ponto de extensão; a explicação por modelo exige
 * AI_COPILOTO_MODEL_ENABLED (lib/inteligencia/flags.ts), conferida pela conversa. Trace sem texto.
 */
export function registrarCopiloto(registro: RegistroExtensoes) {
  registro.definir(CHAVE_COPILOTO, () => criarComplementador({
    registrar: (rastro) => console.info(`[Kidmais Copiloto] ${JSON.stringify(rastro)}`),
  }));
}
