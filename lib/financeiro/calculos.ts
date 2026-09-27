export const FORMAS = ["PIX", "CARTAO_CREDITO", "CARTAO_DEBITO", "BOLETO", "DINHEIRO", "TRANSFERENCIA", "OUTRO"] as const;
export type FormaFinanceira = (typeof FORMAS)[number];
export const HORIZONTE_RECORRENCIA_MESES = 12;

export const CATEGORIAS_DESPESA = [
  "Buffet / insumos",
  "Pessoal",
  "Fornecedores",
  "Aluguel",
  "Energia",
  "Água",
  "Marketing",
  "Manutenção",
  "Impostos",
  "Comissões",
  "Compras",
  "Outros",
] as const;

export type StatusReceber = "A receber" | "Parcialmente pago" | "Pago" | "Vencido" | "Cancelado" | "Reembolsado";
export type StatusPagar = "A pagar" | "Pago" | "Vencido" | "Cancelado";

export function centavosDe(valor: string | number) {
  const texto = String(valor).trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(texto)) throw new Error("valor inválido");
  const negativo = texto.startsWith("-");
  const [inteiro, fracao = ""] = texto.replace("-", "").split(".");
  const centavos = Number(inteiro) * 100 + Number((fracao + "00").slice(0, 2));
  return negativo ? -centavos : centavos;
}

export function reaisDe(centavos: number) {
  const sinal = centavos < 0 ? "-" : "";
  const absoluto = Math.abs(centavos);
  const inteiro = Math.floor(absoluto / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fracao = String(absoluto % 100).padStart(2, "0");
  return `${sinal}R$ ${inteiro},${fracao}`;
}

export function statusReceber(input: {
  cancelado: boolean;
  reembolsado: boolean;
  valorCentavos: number;
  recebidoCentavos: number;
  vencimento: string;
  hoje: string;
}): StatusReceber {
  if (input.cancelado) return "Cancelado";
  if (input.reembolsado && input.recebidoCentavos <= 0) return "Reembolsado";
  const saldo = input.valorCentavos - input.recebidoCentavos;
  if (saldo <= 0) return "Pago";
  if (input.vencimento < input.hoje) return "Vencido";
  if (input.recebidoCentavos > 0) return "Parcialmente pago";
  return "A receber";
}

export function statusPagar(input: {
  cancelado: boolean;
  valorCentavos: number;
  pagoCentavos: number;
  vencimento: string;
  hoje: string;
}): StatusPagar {
  if (input.cancelado) return "Cancelado";
  if (input.pagoCentavos >= input.valorCentavos) return "Pago";
  if (input.vencimento < input.hoje) return "Vencido";
  return "A pagar";
}

export function saldoCentavos(valor: number, movimentado: number) {
  return Math.max(0, valor - movimentado);
}

export function liquidoCentavos(recebido: number, taxa: number) {
  if (taxa < 0 || taxa > recebido) throw new Error("taxa inválida");
  return recebido - taxa;
}

export function aceitaBaixa(saldo: number, valor: number) {
  return valor > 0 && valor <= saldo;
}

export function margemEstimada(receitaCentavos: number, custosCentavos: number) {
  return receitaCentavos - custosCentavos;
}

export function vencimentosMensais(inicio: string, quantidade = HORIZONTE_RECORRENCIA_MESES) {
  const [ano, mes, dia] = inicio.split("-").map(Number);
  return Array.from({ length: quantidade }, (_, indice) => {
    const alvo = new Date(Date.UTC(ano, mes - 1 + indice, 1));
    const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
    const diaUtil = Math.min(dia, ultimo);
    const data = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth(), diaUtil));
    return data.toISOString().slice(0, 10);
  });
}

export function formaParaRecebimento(forma: FormaFinanceira): "PIX" | "CARTAO" | "TRANSFERENCIA" | "DINHEIRO" | "OUTRO" {
  if (forma === "PIX" || forma === "TRANSFERENCIA" || forma === "DINHEIRO") return forma;
  if (forma === "CARTAO_CREDITO" || forma === "CARTAO_DEBITO") return "CARTAO";
  return "OUTRO";
}
