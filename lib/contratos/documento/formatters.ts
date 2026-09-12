export function formatarCpf(value: string | null | undefined) {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length !== 11) return value?.trim() || "Não informado";
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

export function formatarCep(value: string | null | undefined) {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length !== 8) return value?.trim() || "Não informado";
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

export function formatarMoeda(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  }).format(value);
}

export function formatarCondicaoPix(condicao: import("../../comercial/condicao-pagamento").CondicaoPix | null) {
  if (!condicao) return "Não informada";
  return [
    condicao.entradaCentavos === null ? null : `Entrada: ${formatarMoeda(condicao.entradaCentavos / 100)}`,
    condicao.parcelaCentavos === null ? null : `Valor da parcela: ${formatarMoeda(condicao.parcelaCentavos / 100)}`,
    condicao.quantidadeParcelas === null ? null : `Quantidade: ${condicao.quantidadeParcelas}`,
  ].filter(Boolean).join("; ");
}

export function formatarDataContrato(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function formatarHorarioContrato(value: string) {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}:${match[2]}` : value;
}

export function textoOuNaoInformado(value: string | null | undefined) {
  const texto = value?.trim();
  return texto || "Não informado";
}

export function formatarFormaPagamento(value: string | null) {
  const labels: Record<string, string> = {
    PIX_AVISTA: "PIX à vista",
    PIX_PARCELADO: "PIX parcelado",
    CARTAO_CIELO: "Cartão / Cielo",
  };
  return value ? (labels[value] ?? value) : "A definir";
}
