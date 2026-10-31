/**
 * S-D — regras da tela pública "Conheça os salões" (D4/R3-D3/R3-D4), sem React, para os testes de cliente. O servidor
 * manda só os salões prontos e elegíveis no horário, com a situação e o recomendado; aqui viram ordem, seleção e textos.
 */
import type { SalaoPublico } from "../../lib/agenda/salao-publico.ts";
import { ehMotivoPreferencia, TEXTO_MOTIVO_PREFERENCIA } from "../../lib/agenda/preferencia-salao-textos.ts";

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

/**
 * D3 (padrão): com uma única opção que serve, ela já vem selecionada; com mais de uma, o cliente escolhe.
 * E2b (sem troca silenciosa): a ALTERNATIVA nunca vem selecionada, nem quando é a única livre.
 */
export function selecaoInicial(lista: ListaPublica) {
  const livres = lista.saloes.filter(escolhivel);
  return livres.length === 1 && livres[0]!.papel !== "alternativa" ? livres[0]!.id : null;
}

/** "R$ 4.990,00" a partir do texto com 2 casas do servidor; null se não for um número positivo legível. */
export function precoLegivel(valor: string | null | undefined) {
  if (valor == null || !/^\d+(\.\d{1,2})?$/.test(valor)) return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}

/** Membros por extenso: "Salão 1 + Salão 2". */
const membrosPorExtenso = (membros: readonly string[]) => membros.join(" + ");

/**
 * E2b (D-R5/D-E2b-3): faixa do combinado — "Os dois salões juntos · até N pessoas · a partir de R$ X". Com mais de dois
 * membros, "Os salões X + Y + Z juntos". Preço do pacote (nunca A+B); sem preço legível, "valores na escolha do pacote"
 * (nunca R$ 0). Sem "+R$" em nenhum caso. null no salão simples.
 */
export function faixaCombinado(s: Pick<SalaoPublico, "combinado" | "numeros" | "precoAPartirDe">) {
  if (!s.combinado) return null;
  const membros = s.combinado.membros;
  const partes = [membros.length === 2 ? "Os dois salões juntos" : `Os salões ${membrosPorExtenso(membros)} juntos`];
  if (s.numeros.capacidade != null) partes.push(`até ${s.numeros.capacidade} pessoas`);
  const preco = precoLegivel(s.precoAPartirDe);
  partes.push(preco ? `a partir de ${preco}` : "valores na escolha do pacote");
  return partes.join(" · ");
}

/** E2b: selo da alternativa ("os salões 1 + 2 juntos, livres neste horário"); null fora do papel. */
export function seloAlternativa(s: Pick<SalaoPublico, "papel" | "combinado" | "nome">) {
  if (s.papel !== "alternativa") return null;
  const quem = s.combinado?.membros.length ? `os salões ${membrosPorExtenso(s.combinado.membros)} juntos` : s.nome;
  return `Alternativa: ${quem}, livres neste horário`;
}

/**
 * E2b (R2-P2-2): aviso da volta por recusa do envio (`aviso=salao-recusado`), com a frase do motivo quando houver.
 * O aviso da E2a (`aviso=salao`) continua com a frase de antes.
 */
export function textoAvisoSalao(params: URLSearchParams) {
  if (params.get("aviso") === "salao") return "O salão escolhido não está mais disponível para a sua festa. Escolha outro salão.";
  const motivo = motivoDaRecusa(params);
  return motivo ? `${motivo} Escolha outro salão.` : null;
}

/**
 * Só a explicação da recusa do envio (E2b), sem orientar a escolha: também aparece quando a etapa de salões sai do
 * ar (lista 404), onde não há salão para escolher. Fora de "salao-recusado", null.
 */
export function motivoDaRecusa(params: URLSearchParams) {
  if (params.get("aviso") !== "salao-recusado") return null;
  const motivo = params.get("motivo");
  return ehMotivoPreferencia(motivo)
    ? TEXTO_MOTIVO_PREFERENCIA[motivo]
    : "O salão escolhido não está mais disponível para esta data, horário e número de convidados.";
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
