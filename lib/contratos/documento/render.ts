import type {
  ContratoDocumentoRenderizado,
  GerarDocumentoContratoInput,
} from "./models.ts";
import { CONTRATO_DOCUMENTO_TEMPLATE_ATUAL } from "./models.ts";
import { renderizarContratoTemplateV1 } from "./template-v1.ts";

export function renderizarDocumentoContrato(
  input: GerarDocumentoContratoInput,
): ContratoDocumentoRenderizado {
  const versao = input.templateVersao ?? CONTRATO_DOCUMENTO_TEMPLATE_ATUAL;

  if (versao === 1) {
    return renderizarContratoTemplateV1({ ...input, templateVersao: 1 });
  }

  const exhaustive: never = versao;
  throw new Error(`Template contratual não suportado: ${exhaustive}`);
}
