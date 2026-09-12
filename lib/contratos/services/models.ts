import type { ContratoRecord, ContratoVersaoRecord } from "../repositories";

export type ContratoServiceContext = {
  usuarioId?: string | null;
  origem: "CONTRATO_INTERNO_DEV" | "SISTEMA";
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type GerarContratoInput = {
  fechamentoId: string;
  motivoNovaVersao?: string | null;
};

export type GerarContratoResult = {
  contrato: ContratoRecord;
  versao: ContratoVersaoRecord;
  reutilizado: boolean;
  pendenciasParaAssinatura: Array<{
    campo: string;
    label: string;
  }>;
};

export type ContratoPublicoRequestContext = {
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type AssinarContratoPublicoInput = {
  contratoId: string;
  provaToken: string;
  acessoToken: string;
  versaoId: string;
  snapshotHash: string;
  documentoPdfHash: string;
};
