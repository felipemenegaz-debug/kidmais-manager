import type { ContratoSnapshot } from "../repositories";

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
};

export type GerarDocumentoContratoInput = {
  snapshot: ContratoSnapshot;
  numeroVersao: number;
  snapshotHash: string;
  templateVersao?: ContratoDocumentoTemplateVersao;
};
