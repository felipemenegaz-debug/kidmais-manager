import { cnpjRaizPlaceholder, cnpjValido, normalizarCnpj } from "../cadastro/cnpj.ts";
import { cpfValidoServico } from "../clientes/services/validators.ts";

/**
 * Documento da identidade pública (Entrega B, 112; plano R2-1): a chave é o documento do contratante — CPF da PF, CNPJ
 * da PJ. A entrada "CPF ou CNPJ" é classificada pelo formato: 11 dígitos com DV de CPF = CPF; 14 posições com DV de CNPJ
 * (numérico ou alfanumérico, sem raiz repetida) = CNPJ. O resto é recusado. O CPF do representante de uma PJ nunca é
 * chave: a PJ não tem CPF (CHECK da 112), então nenhuma busca por CPF a encontra.
 */
export type DocumentoIdentidade = { tipo: "CPF" | "CNPJ"; valor: string };

export function classificarDocumentoIdentidade(entrada: string | null | undefined): DocumentoIdentidade | null {
  const texto = (entrada ?? "").trim();
  const digitos = texto.replace(/[\s.\-/]/g, "");
  if (/^\d{11}$/.test(digitos)) return cpfValidoServico(digitos) ? { tipo: "CPF", valor: digitos } : null;
  const cnpj = normalizarCnpj(texto);
  if (/^[0-9A-Z]{12}\d{2}$/.test(cnpj) && cnpjValido(cnpj) && !cnpjRaizPlaceholder(cnpj)) return { tipo: "CNPJ", valor: cnpj };
  return null;
}

/** Parece CPF (só dígitos, até 11)? Mantém a mensagem e o código de hoje para quem digita um CPF incompleto. */
export function pareceCpf(entrada: string | null | undefined) {
  const t = (entrada ?? "").trim().replace(/[\s.\-/]/g, "");
  return /^\d{0,11}$/.test(t);
}

/** Documento congelado do contratante na versão: CNPJ na PJ, CPF na PF (ausência de tipo = PF). */
export function documentoDoSnapshot(contratante: { tipoPessoa?: "PJ"; cpf: string; cnpj?: string }): DocumentoIdentidade | null {
  if (contratante.tipoPessoa === "PJ") {
    const cnpj = normalizarCnpj(contratante.cnpj);
    return cnpj ? { tipo: "CNPJ", valor: cnpj } : null;
  }
  const cpf = (contratante.cpf ?? "").replace(/\D/g, "");
  return cpf ? { tipo: "CPF", valor: cpf } : null;
}

export const mesmoDocumento = (a: DocumentoIdentidade | null, b: DocumentoIdentidade | null) =>
  !!a && !!b && a.tipo === b.tipo && a.valor === b.valor;
