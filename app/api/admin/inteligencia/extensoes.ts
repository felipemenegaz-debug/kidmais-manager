import type { NextRequest } from "next/server";
import { RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { registrarJev } from "./jev/composicao"; // @pr:JEV
import { registrarAcoes } from "./operacoes/composicao"; // @pr:ACTIONS
import { registrarImportacao } from "./importacoes/composicao"; // @pr:IMPORT

/**
 * Único ponto em que as features instaladas se registram no CORE.
 *
 * Cada PR de feature acrescenta exatamente as suas linhas (marcadas com `@pr:`). Sem nenhuma delas,
 * o registro fica vazio e a IA funciona só com leituras. A ordem importa só para a lista de ações:
 * ACTIONS define o módulo; IMPORT acrescenta a própria ação à lista antes do primeiro uso.
 */
export function montarExtensoes(request: NextRequest) {
  const registro = new RegistroExtensoes();
  registrarJev(registro); // @pr:JEV
  registrarAcoes(registro); // @pr:ACTIONS
  registrarImportacao(registro, request); // @pr:IMPORT
  return registro;
}
