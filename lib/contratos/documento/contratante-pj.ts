import type { ContratoSnapshot } from "../repositories/models.ts";
import { formatarCpf } from "./formatters.ts";

/**
 * Contratante pessoa jurídica no documento (Entrega B, 112; plano R2-2). O snapshot PF não tem `tipoPessoa`: ausência =
 * PF, e todo texto PF continua saindo exatamente como antes. Só a PJ passa por aqui.
 */
export function contratantePj(s: Pick<ContratoSnapshot, "contratante">) {
  return s.contratante.tipoPessoa === "PJ";
}

/** CNPJ numérico ou alfanumérico (14 posições) como 00.000.000/0000-00; fora disso, o texto como está. */
export function formatarCnpj(value: string | null | undefined) {
  const v = (value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(v)) return value?.trim() || "Não informado";
  return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`;
}

/** Representante legal: texto contratual ("Nome, CPF 000.000.000-00"), nunca identidade. PF: vazio. */
export function representanteDoContratante(s: Pick<ContratoSnapshot, "contratante">) {
  if (!contratantePj(s)) return "";
  const r = s.contratante.representante;
  if (!r?.nome) return "Não informado";
  return r.cpf ? `${r.nome}, CPF ${formatarCpf(r.cpf)}` : r.nome;
}

/** Documento do contratante: CPF formatado na PF (igual a {{contratante.cpf}}), CNPJ na PJ. */
export function documentoDoContratante(s: Pick<ContratoSnapshot, "contratante">) {
  return contratantePj(s) ? formatarCnpj(s.contratante.cnpj) : formatarCpf(s.contratante.cpf);
}

/** "<razão social>, inscrita no CNPJ nº …[, nome fantasia …][, neste ato representada por …]" — início da qualificação PJ. */
export function identificacaoPj(s: Pick<ContratoSnapshot, "contratante">) {
  const c = s.contratante;
  const fantasia = c.nomeFantasia?.trim() ? `, nome fantasia ${c.nomeFantasia.trim()}` : "";
  const representante = c.representante?.nome ? `, neste ato representada por ${representanteDoContratante(s)}` : "";
  return `${c.nomeCompleto}, inscrita no CNPJ nº ${formatarCnpj(c.cnpj)}${fantasia}${representante}`;
}
