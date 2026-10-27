import type { ContratoSnapshot } from "../../repositories/index.ts";

/** S-E (plano S-E/S-D rev. 4.1): V5 = V4 + salão fixado (snapshot V3); sem salão, texto igual ao da V4. */
export const CONTRATO_OFICIAL_TEMPLATE_ATUAL = 5 as const;

export type ContratoOficialTemplateVersao = 1 | 2 | 3 | 4 | 5;

export type ContratoOficialClausula = {
  numero: number;
  texto: string;
  destaques?: string[];
};

export type ContratoOficialRenderizado = {
  /** Modelos oficiais Kidmais: 1 a 5. Modelo da empresa (072): a versão do modelo publicado. */
  templateVersao: number;
  modeloCodigo: string;
  pacoteCodigo: string;
  pacoteNome: string;
  homologadoParaProducao: boolean;
  titulo: string;
  subtitulo: string;
  avisoHomologacao: string | null;
  contratada: string[];
  contratante: string[];
  preambulo: string[];
  clausulas: ContratoOficialClausula[];
  observacoes: string[];
  integridade: string[];
  assinatura: string[];
};

export type GerarContratoOficialInput = {
  snapshot: ContratoSnapshot;
  numeroVersao: number;
  snapshotHash: string;
  geradoEm?: string | null;
  templateVersao?: ContratoOficialTemplateVersao;
};

export type ModeloContratoOficial = {
  modeloCodigo: string;
  pacoteCodigo: string;
  pacoteNome: string;
  templateVersao: ContratoOficialTemplateVersao;
  homologadoParaProducao: boolean;
  renderizar(input: GerarContratoOficialInput): ContratoOficialRenderizado;
};
