import type { NextRequest } from "next/server";
import { extrairTextoPdfIsolado } from "@/lib/importacao-contrato/pdf-isolado";
import { documentosDisponiveis, registrarDocumento, registrarExtracao, ultimaExtracao } from "@/lib/importacao-contrato/repositorio-documentos";
import type { DependenciasDocumento, PortaDocumentos } from "@/lib/inteligencia/documentos/upload";
import { dependenciasGateway, roteadorDoAmbiente } from "../dependencias";

/** Composição da feature DOCUMENT: repositório de documentos (ia_documentos, originais, extrações, evidências). */
export const portaDocumentos: PortaDocumentos = { disponivel: documentosDisponiveis, registrarDocumento, registrarExtracao, ultimaExtracao };

export function dependenciasDocumento(request: NextRequest): DependenciasDocumento {
  // PDF lido em Worker isolado: prazo e cancelamento do pedido encerram o Worker à força.
  return { ...dependenciasGateway(request), documentos: portaDocumentos, roteador: roteadorDoAmbiente(), lerPdf: extrairTextoPdfIsolado };
}
