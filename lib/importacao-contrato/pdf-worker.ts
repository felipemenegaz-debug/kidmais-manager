import { parentPort, workerData } from "node:worker_threads";
import { extrairTextoPdf, type OpcoesExtracao } from "./pdf-texto.ts";

/**
 * Entrada do Worker de extração de PDF. Roda isolada do event loop do servidor: se um PDF hostil
 * escapar dos limites do parser, quem chama encerra este Worker (`terminate`) no prazo.
 */
const dados = workerData as { bytes: Uint8Array; opcoes: Pick<OpcoesExtracao, "limiteTrabalho" | "prazoMs"> };
parentPort?.postMessage(extrairTextoPdf(new Uint8Array(dados.bytes), dados.opcoes));
