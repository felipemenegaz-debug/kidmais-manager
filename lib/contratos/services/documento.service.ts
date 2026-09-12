import {
  CONTRATO_DOCUMENTO_TEMPLATE_ATUAL,
  gerarPdfDocumentoContrato,
  gerarPdfContratoOficial,
  hashPdfContrato,
  hashPdfContratoOficial,
  renderizarContratoOficial,
  renderizarDocumentoContrato,
  resolverModeloContratoOficial,
  type ContratoDocumentoTemplateVersao,
} from "../documento";
import type { ContratoVersaoRecord } from "../repositories";
import { ContratoServiceError } from "./errors";

function templateResumoDaVersao(versao: ContratoVersaoRecord): ContratoDocumentoTemplateVersao {
  // O template persistido na versão pertence ao CONTRATO OFICIAL assinado.
  // O resumo informativo possui versionamento próprio e, no V1 atual, é sempre V1.
  void versao;
  return CONTRATO_DOCUMENTO_TEMPLATE_ATUAL;
}

export function gerarResumoContratacaoPdfDaVersao(versao: ContratoVersaoRecord) {
  const templateVersao = templateResumoDaVersao(versao);
  const documento = renderizarDocumentoContrato({
    snapshot: versao.snapshot,
    numeroVersao: versao.numeroVersao,
    snapshotHash: versao.snapshotHash,
    templateVersao,
  });
  const pdf = gerarPdfDocumentoContrato(documento);
  const pdfHash = hashPdfContrato(pdf);

  return {
    documento,
    pdf,
    pdfHash,
    templateVersao,
  };
}

export function contratoOficialDisponivelParaVersao(versao: ContratoVersaoRecord) {
  const modelo = resolverModeloContratoOficial(versao.snapshot, versao.status === 'ASSINADA' ? versao.documentoTemplateVersao ?? 1 : undefined);
  return modelo
    ? {
        disponivel: true as const,
        modeloCodigo: modelo.modeloCodigo,
        templateVersao: modelo.templateVersao,
        homologadoParaProducao: modelo.homologadoParaProducao,
      }
    : {
        disponivel: false as const,
        modeloCodigo: null,
        templateVersao: null,
        homologadoParaProducao: false,
      };
}

export function gerarContratoOficialPdfDaVersao(versao: ContratoVersaoRecord) {
  const modelo = resolverModeloContratoOficial(versao.snapshot, versao.status === 'ASSINADA' ? versao.documentoTemplateVersao ?? 1 : undefined);
  if (!modelo) {
    throw new ContratoServiceError(
      "MODELO_CONTRATO_OFICIAL_NAO_DISPONIVEL",
      `Ainda não existe Contrato Oficial configurado para o pacote ${versao.snapshot.evento.pacote.nome}.`,
      409,
      {
        pacoteCodigo: versao.snapshot.evento.pacote.codigo,
        pacoteNome: versao.snapshot.evento.pacote.nome,
      },
    );
  }

  const documento = renderizarContratoOficial({
    snapshot: versao.snapshot,
    numeroVersao: versao.numeroVersao,
    snapshotHash: versao.snapshotHash,
    geradoEm: versao.criadoEm,
    templateVersao: modelo.templateVersao,
  });

  if (!documento) {
    throw new ContratoServiceError(
      "MODELO_CONTRATO_OFICIAL_NAO_DISPONIVEL",
      "O modelo de Contrato Oficial não pôde ser resolvido para esta versão.",
      409,
    );
  }

  const pdf = gerarPdfContratoOficial(documento);
  const pdfHash = hashPdfContratoOficial(pdf);

  if (
    versao.status === "ASSINADA" &&
    versao.documentoPdfHash &&
    versao.documentoPdfHash !== pdfHash
  ) {
    throw new ContratoServiceError(
      "DOCUMENTO_CONTRATO_INTEGRIDADE_FALHOU",
      "O Contrato Oficial regenerado não corresponde ao hash do documento assinado.",
      409,
      {
        versaoId: versao.id,
        hashPersistido: versao.documentoPdfHash,
        hashGerado: pdfHash,
        modeloCodigo: documento.modeloCodigo,
      },
    );
  }

  return {
    documento,
    pdf,
    pdfHash,
    templateVersao: documento.templateVersao,
    modeloCodigo: documento.modeloCodigo,
  };
}

// Compatibilidade interna: daqui em diante "documento contratual" significa o
// CONTRATO OFICIAL, pois é ele que recebe o aceite e o hash persistido.
export const gerarDocumentoPdfDaVersao = gerarContratoOficialPdfDaVersao;

export function aceiteDoTemplatePermitido(options?: {
  disponivel?: boolean;
  homologadoParaProducao?: boolean;
}) {
  if (options?.disponivel === false) return false;
  if (process.env.NODE_ENV === "production") {
    return options?.homologadoParaProducao === true;
  }
  return process.env.CONTRATO_ACEITE_DEV_ENABLED === "true";
}
