import { CHAVE_ORQUESTRADOR, type RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { criarDemerzel } from "@/lib/inteligencia/demerzel/orquestradora";

/**
 * Composição da feature DEMERZEL: a orquestradora entra no CORE só pelo ponto de extensão. Ela usa as portas
 * da conversa (Policy, Tenant Context, registro fechado, Human Gate); a flag AI_DEMERZEL_ENABLED
 * (lib/inteligencia/flags.ts) é conferida pela conversa. Traces sem texto do operador.
 */
export function registrarDemerzel(registro: RegistroExtensoes) {
  registro.definir(CHAVE_ORQUESTRADOR, () => criarDemerzel({
    registrarJev: (rastro) => console.info(`[Kidmais JEV] ${JSON.stringify(rastro)}`),
  }));
}
