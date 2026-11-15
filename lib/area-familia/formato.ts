/** Formatos puros das telas da área "Minha festa" (F2), testados em area-familia-leitura.test.ts. */
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function dataPorExtenso(iso: string) {
  const [a, m, d] = iso.slice(0, 10).split("-").map(Number);
  return a && m && d && m <= 12 ? `${d} de ${MESES[m - 1]} de ${a}` : iso;
}

export function dataCurta(iso: string) {
  const [a, m, d] = iso.slice(0, 10).split("-");
  return a && m && d ? `${d}/${m}/${a}` : iso;
}

/** Minimização: só o primeiro nome (o nome completo do aniversariante nunca vai ao navegador da família). */
export function primeiroNome(nome: string | null | undefined) {
  return (nome ?? "").trim().split(/\s+/)[0] ?? "";
}

export function reais(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function contagem(dias: number) {
  if (dias > 1) return `Faltam ${dias} dias`;
  if (dias === 1) return "Falta 1 dia";
  if (dias === 0) return "É hoje!";
  return "A festa já aconteceu";
}

export const ROTULO_ESTADO = {
  PAGA: "Paga", EM_ABERTO: "Em aberto", VENCIDA: "Vencida", FUTURA: "Futura", CANCELADA: "Cancelada",
} as const;
