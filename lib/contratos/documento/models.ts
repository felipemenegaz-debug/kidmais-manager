import type { ContratoSnapshot } from "../repositories";
import type { MarcaContrato } from "../marca-contrato.ts";

export const CONTRATO_DOCUMENTO_TEMPLATE_ATUAL = 1 as const;

export type ContratoDocumentoTemplateVersao = 1;

export type ContratoDocumentoLinha = {
  texto: string;
  estilo: "titulo" | "subtitulo" | "secao" | "corpo" | "destaque" | "aviso" | "rodape";
  espacoDepois?: number;
};

export type ContratoDocumentoRenderizado = {
  cabecalhoRotulo?: string;
  templateVersao: ContratoDocumentoTemplateVersao;
  homologadoParaProducao: boolean;
  titulo: string;
  linhas: ContratoDocumentoLinha[];
  /** Buffet do documento. Ausente = identidade histórica da Kidmais; quem gera para um contrato sempre informa. */
  marca?: MarcaContrato;
};

export type GerarDocumentoContratoInput = {
  snapshot: ContratoSnapshot;
  numeroVersao: number;
  snapshotHash: string;
  templateVersao?: ContratoDocumentoTemplateVersao;
  marca?: MarcaContrato;
};
