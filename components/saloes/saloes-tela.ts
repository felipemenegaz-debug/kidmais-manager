/**
 * S-D — regras da tela pública "Conheça os salões" (D4/R3-D3/R3-D4), sem React, para os testes de cliente. O servidor
 * manda só os salões prontos e elegíveis no horário, com a situação e o recomendado; aqui viram ordem, seleção e textos.
 */
import type { SalaoPublico } from "../../lib/agenda/salao-publico.ts";

export type ListaPublica = { saloes: SalaoPublico[]; recomendado: { id: string; motivo: string } | null };

/**
 * Revisão do Astra (P2-1): a etapa some (404) depois de o cliente ter escolhido um salão (`salao`) ou de o fechamento
 * ter devolvido o salão como indisponível (`aviso`). Nesses casos seguir sozinho apagaria a escolha e o aviso; a tela
 * pergunta. Sem nenhum dos dois, o fluxo segue como depois da S-C.
 */
export function seguirSemEtapa(params: URLSearchParams) {
  return !params.get("salao") && !params.get("aviso");
}

export const escolhivel = (s: Pick<SalaoPublico, "situacao">) => s.situacao === "livre";

/** Recomendado primeiro, depois os outros livres (na ordem do servidor); os que não servem ficam à parte. */
export function organizar(lista: ListaPublica) {
  const livres = lista.saloes.filter(escolhivel);
  const rec = livres.find((s) => s.id === lista.recomendado?.id) ?? null;
  return {
    principais: rec ? [rec, ...livres.filter((s) => s.id !== rec.id)] : livres,
    indisponiveis: lista.saloes.filter((s) => !escolhivel(s)),
  };
}

/** D3 (padrão): com uma única opção que serve, ela já vem selecionada; com mais de uma, o cliente escolhe. */
export function selecaoInicial(lista: ListaPublica) {
  const livres = lista.saloes.filter(escolhivel);
  return livres.length === 1 ? livres[0]!.id : null;
}

/** Motivo de um salão que não pode ser escolhido (nunca diz quem ocupa). */
export function textoSituacao(s: Pick<SalaoPublico, "situacao" | "numeros">, convidados: number) {
  if (s.situacao === "nao_comporta") return `Não comporta ${convidados} convidados${s.numeros.capacidade ? ` (até ${s.numeros.capacidade})` : ""}.`;
  if (s.situacao === "abaixo_do_minimo") return `Pede no mínimo ${s.numeros.minimo} convidados.`;
  if (s.situacao === "ocupado") return "Já reservado neste horário.";
  return null;
}

/** Linha de números do cartão: "até 120 convidados · 80 sentados · 150 m² · 3 a 10 anos". */
export function linhaNumeros(s: Pick<SalaoPublico, "numeros" | "idade">) {
  const partes: string[] = [];
  if (s.numeros.capacidade != null) partes.push(`até ${s.numeros.capacidade} convidados`);
  if (s.numeros.minimo != null) partes.push(`mínimo ${s.numeros.minimo}`);
  if (s.numeros.sentados != null) partes.push(`${s.numeros.sentados} sentados`);
  if (s.numeros.areaM2 != null) partes.push(`${s.numeros.areaM2} m²`);
  if (s.idade) partes.push(`${s.idade.min} a ${s.idade.max} anos${s.idade.sugerida ? " (sugerido)" : ""}`);
  return partes.join(" · ");
}

/** Mês das fotos para o rodapé: "2026-09" → "setembro de 2026". */
export function mesPorExtenso(mes: string | null) {
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return null;
  const [ano, m] = mes.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(ano, m - 1, 1)));
}

/** "Comparar em detalhes": só as linhas em que os salões escolhíveis diferem. */
export function diferencas(saloes: SalaoPublico[]) {
  const linhas: Array<{ rotulo: string; valores: string[] }> = [
    { rotulo: "Convidados", valores: saloes.map((s) => (s.numeros.capacidade != null ? `até ${s.numeros.capacidade}` : "—")) },
    { rotulo: "Mínimo", valores: saloes.map((s) => (s.numeros.minimo != null ? String(s.numeros.minimo) : "—")) },
    { rotulo: "Sentados", valores: saloes.map((s) => (s.numeros.sentados != null ? String(s.numeros.sentados) : "—")) },
    { rotulo: "Área", valores: saloes.map((s) => (s.numeros.areaM2 != null ? `${s.numeros.areaM2} m²` : "—")) },
    { rotulo: "Idade", valores: saloes.map((s) => (s.idade ? `${s.idade.min} a ${s.idade.max} anos` : "—")) },
    { rotulo: "Outra festa no mesmo horário", valores: saloes.map((s) => s.convivencia ?? "—") },
    ...gruposComparados(saloes),
  ];
  return linhas.filter((l) => new Set(l.valores).size > 1);
}

function gruposComparados(saloes: SalaoPublico[]) {
  const nomes = [...new Set(saloes.flatMap((s) => s.grupos.map((g) => g.nome)))];
  return nomes.map((nome) => ({
    rotulo: nome,
    valores: saloes.map((s) => s.grupos.find((g) => g.nome === nome)?.itens.join(", ") || "—"),
  }));
}
