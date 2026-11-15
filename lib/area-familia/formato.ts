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

// F3 (125): abas da área e texto livre da família.
export const ABAS = [
  { id: "inicio", rotulo: "Início" },
  { id: "festa", rotulo: "Festa" },
  { id: "pagamentos", rotulo: "Pagamentos" },
  { id: "pendencias", rotulo: "Pendências" },
  { id: "documentos", rotulo: "Documentos" },
  { id: "pessoas", rotulo: "Pessoas" },
] as const;
export type Aba = (typeof ABAS)[number]["id"];

/** Abas visíveis: Pendências só com a 125; Pessoas só para quem contratou (o segundo responsável não convida ninguém). */
export function abasVisiveis(dados: { papel: "CONTRATANTE" | "SEGUNDO_RESPONSAVEL"; acoes: { disponivel: boolean } }) {
  return ABAS.filter((a) => (a.id !== "pendencias" && a.id !== "pessoas")
    || (dados.acoes.disponivel && (a.id === "pendencias" || dados.papel === "CONTRATANTE")));
}

/** Texto livre da família: espaços nas pontas fora; vazio vira null; acima do limite é recusado. */
export function textoLivre(valor: string | null | undefined, max: number): string | null | false {
  const t = (valor ?? "").trim();
  if (!t) return null;
  return t.length > max ? false : t;
}
