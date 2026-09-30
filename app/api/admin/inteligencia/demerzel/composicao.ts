import { CHAVE_ORQUESTRADOR, type RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { criarDemerzel } from "@/lib/inteligencia/demerzel/orquestradora";
import { prazoModeloJevDoAmbiente } from "@/lib/inteligencia/jev/v1/juiz";
import { politicaDoAmbiente } from "@/lib/inteligencia/modelos/roteador";

/**
 * Composição da feature DEMERZEL: a orquestradora entra no CORE só pelo ponto de extensão. Ela usa as portas
 * da conversa (Policy, Tenant Context, registro fechado, Human Gate); a flag AI_DEMERZEL_ENABLED
 * (lib/inteligencia/flags.ts) é conferida pela conversa. Traces sem texto do operador.
 * Prazo do modelo no JEV: `AI_JEV_MODEL_TIMEOUT_MS`, limitado ao timeout do Model Router (H1).
 */
export function registrarDemerzel(registro: RegistroExtensoes) {
  registro.definir(CHAVE_ORQUESTRADOR, () => criarDemerzel({
    registrarJev: (rastro) => console.info(`[Kidmais JEV] ${JSON.stringify(rastro)}`),
    prazoModeloJevMs: prazoModeloJevDoAmbiente(process.env, politicaDoAmbiente(process.env).timeoutMs),
  }));
}
