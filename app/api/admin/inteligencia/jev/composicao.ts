import { CHAVE_CLASSIFICADOR_AUXILIAR, type RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { criarClassificadorAuxiliarJev, criarJev } from "@/lib/inteligencia/jev/classificador";

/**
 * Composição da feature JEV: o classificador auxiliar entra no CORE só pelo ponto de extensão.
 * Motor local determinístico (sem rede). A flag do JEV (lib/inteligencia/flags.ts) é conferida pela conversa;
 * sem ela, nada muda no roteamento. Trace sem texto do operador.
 */
export function registrarJev(registro: RegistroExtensoes) {
  registro.definir(CHAVE_CLASSIFICADOR_AUXILIAR, () => criarClassificadorAuxiliarJev(criarJev({
    registrar: (rastro) => console.info(`[Kidmais JEV] ${JSON.stringify(rastro)}`),
  })));
}
