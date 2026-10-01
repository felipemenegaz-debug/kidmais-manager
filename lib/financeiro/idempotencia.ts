import { createHash } from "node:crypto";
import { centavosDe, formaParaRecebimento, type FormaFinanceira } from "./calculos.ts";

/** Escopo da chave: empresa + operação + chave informada. Não é única no SaaS. */
export function chaveNoTenant(empresaId: string, operacao: "recebimento" | "pagamento", chave: string) {
  return createHash("sha256").update(`${operacao}\0${empresaId}\0${chave}`).digest("hex");
}

/** `taxaCentavos` já está em centavos. Não passa de novo por centavosDe. */
export function centavosDaTaxaGravada(taxaCentavos: unknown) {
  if (taxaCentavos == null) return 0;
  if (typeof taxaCentavos === "number" && Number.isInteger(taxaCentavos) && taxaCentavos >= 0) return taxaCentavos;
  if (typeof taxaCentavos === "string" && /^\d+$/.test(taxaCentavos)) return Number(taxaCentavos);
  return null;
}

export function textoOperacao(valor: string | null | undefined) {
  return (valor ?? "").trim();
}

export type BaixaGravada = {
  brutoCentavos: number;
  meio: string;
  forma: string | null;
  taxaCentavos: number | null;
  parcelaId: string | null;
  alocadoCentavos: number | null;
  data: string | null;
  observacao: string | null;
  alocacoes: number;
};

export type PedidoComparavel = {
  parcelaId: string;
  valor: number;
  data: string;
  forma: FormaFinanceira;
  taxa?: number;
  observacao?: string;
};

/** Mesma chave só reaproveita a operação quando o payload informado é o mesmo. */
export function mesmaBaixa(gravada: BaixaGravada, input: PedidoComparavel) {
  if (gravada.taxaCentavos == null || gravada.alocacoes !== 1 || gravada.alocadoCentavos == null) return false;
  const bruto = centavosDe(input.valor);
  return gravada.meio === formaParaRecebimento(input.forma)
    && gravada.forma === input.forma
    && gravada.brutoCentavos === bruto
    && gravada.taxaCentavos === centavosDe(input.taxa ?? 0)
    && gravada.parcelaId === input.parcelaId
    && gravada.alocadoCentavos === bruto
    && gravada.data === input.data
    && textoOperacao(gravada.observacao) === textoOperacao(input.observacao);
}
