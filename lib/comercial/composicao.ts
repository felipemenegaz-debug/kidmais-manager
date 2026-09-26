import { PacoteAdminError } from "./pacotes-admin.ts";

export function validarVinculoComposicao(input: {
  pacoteCodigo: string;
  adicionalCodigo: string;
  modalidade: "INCLUSO" | "EXTRA" | "INDISPONIVEL";
  modalidadeAtual: "INCLUSO" | "EXTRA" | "INDISPONIVEL" | null;
}) {
  if (input.pacoteCodigo === "COMPLETA" && input.adicionalCodigo === "SALADA_PREMIUM" && input.modalidade === "INCLUSO") {
    throw new PacoteAdminError("SALADA_COMPLETA", "Festa Completa mantém a salada tradicional. Salada premium não entra como item incluso.", 409);
  }
  if (input.pacoteCodigo === "PREMIUM" && input.adicionalCodigo === "SALADA_PREMIUM" && input.modalidade !== "INCLUSO") {
    throw new PacoteAdminError("SALADA_PREMIUM", "Festa Premium inclui salada premium no lugar da tradicional.", 409);
  }
  if (input.modalidade === "EXTRA" && input.modalidadeAtual === "INCLUSO") {
    throw new PacoteAdminError("INCLUSO_NAO_PAGO", "Item incluso não pode ser cobrado como adicional.", 409);
  }
}
