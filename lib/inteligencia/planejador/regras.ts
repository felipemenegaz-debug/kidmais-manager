import type { EntidadeRef, TipoEntidade } from "../contratos.ts";
import { objetivoDoTexto } from "../entendimento.ts";
import { LEITURA_DE_RELACAO, RELACOES, type Referencia } from "../referencias.ts";
import type { PlanoRastreio } from "../contratos.ts";
import type { PassoPlano, Plano } from "./plano.ts";

/**
 * Planner por REGRAS (deterministic-first): referência → âncora → relação do Core → capacidade final.
 *
 *   âncora: temporal ("próxima festa", "sábado") ⇒ `proximas_festas`; "último contrato" ⇒ `ultimo_contrato`;
 *           nome ⇒ `buscar_clientes`; tela/foco ⇒ âncora já revalidada (CONTEXTO), sem leitura extra.
 *   relação: alvo diferente da âncora ⇒ `relacoes_festa` / `relacoes_contrato` (só relações que o Core fornece).
 *   final: financeiro ⇒ saldo/parcela do CONTRATO; "abra" ⇒ navegação; senão o resumo do alvo.
 *
 * Mutação nunca é planejada por regra (segue o caminho atual: Human Gate ou indisponível). Sem plano seguro ⇒ null,
 * e a conversa segue como antes. Nenhum id entra no plano: vêm todos de `entradaDe`.
 */
const ACOES_DE_MUTACAO = new Set(["CRIAR", "EDITAR", "EXCLUIR", "ENVIAR", "REGISTRAR", "CANCELAR"]);
const RESUMO: Partial<Record<TipoEntidade, string>> = { FESTA: "resumir_festa", CLIENTE: "resumir_cliente", CONTRATO: "resumir_contrato" };
const TELA: Partial<Record<TipoEntidade, "cliente" | "contrato">> = { CLIENTE: "cliente", CONTRATO: "contrato" };

export type PlanoPorRegras = { plano: Plano; motivo: PlanoRastreio["motivo"] };

export function planejarPorRegras(ref: Referencia, texto: string, ancoraContexto: EntidadeRef | null): PlanoPorRegras | null {
  const passos: PassoPlano[] = [];
  const id = () => `p${passos.length + 1}` as PassoPlano["id"];
  let fonte: NonNullable<PassoPlano["entradaDe"]>;
  let tipoAncora: TipoEntidade;

  if (ancoraContexto) {
    fonte = { de: "CONTEXTO", entidade: ancoraContexto.tipo };
    tipoAncora = ancoraContexto.tipo;
  } else if (ref.tipo === "TEMPORAL" && ref.temporal?.seletor === "ULTIMO_CONTRATO") {
    passos.push({ id: id(), capacidade: "ultimo_contrato", parametros: {}, selecao: "UNICA" });
    fonte = { de: "PASSO", passo: "p1", entidade: "CONTRATO" };
    tipoAncora = "CONTRATO";
  } else if (ref.tipo === "TEMPORAL" && ref.temporal) {
    const t = ref.temporal;
    const parametros: Record<string, string | number> = t.seletor === "DIA" && t.dia ? { ordem: "ASC", inicio: t.dia, fim: t.dia, limite: 5 } : { ordem: t.seletor === "PROXIMA" ? "ASC" : "DESC", limite: 2 };
    // Mais de uma no dia ⇒ ambíguo; próxima/última: a primeira, salvo empate real de data e hora.
    passos.push({ id: id(), capacidade: "proximas_festas", parametros, selecao: t.seletor === "DIA" ? "UNICA" : "PRIMEIRA" });
    fonte = { de: "PASSO", passo: "p1", entidade: "FESTA" };
    tipoAncora = "FESTA";
  } else if (ref.tipo === "NOME" && ref.nome) {
    passos.push({ id: id(), capacidade: "buscar_clientes", parametros: { termo: ref.nome }, selecao: "UNICA" });
    fonte = { de: "PASSO", passo: "p1", entidade: "CLIENTE" };
    tipoAncora = "CLIENTE";
  } else {
    return null;
  }

  const alvo = ref.alvo ?? tipoAncora;
  if (alvo !== tipoAncora) {
    const leitura = RELACOES[tipoAncora].includes(alvo) ? LEITURA_DE_RELACAO[tipoAncora] : undefined;
    if (!leitura) return null;
    passos.push({ id: id(), capacidade: leitura, entradaDe: fonte });
    fonte = { de: "PASSO", passo: passos.at(-1)!.id, entidade: alvo };
  }

  const acao = objetivoDoTexto(texto).acao;
  let final: PassoPlano;
  let objetivo: string;
  if (ref.financeiro) {
    if (alvo !== "CONTRATO") return null;
    final = { id: id(), capacidade: ref.financeiro === "SALDO" ? "saldo_contrato" : "proxima_parcela", entradaDe: fonte };
    objetivo = "CONSULTAR:PAGAMENTO";
  } else if (acao && ACOES_DE_MUTACAO.has(acao)) {
    return null;
  } else if (acao === "ABRIR") {
    if (alvo === "FESTA") final = { id: id(), capacidade: "abrir_festa", entradaDe: fonte };
    else if (TELA[alvo]) final = { id: id(), capacidade: "abrir_tela", parametros: { tela: TELA[alvo]! }, entradaDe: fonte };
    else return null;
    objetivo = `ABRIR:${alvo}`;
  } else {
    const resumo = RESUMO[alvo];
    if (!resumo) return null;
    final = { id: id(), capacidade: resumo, entradaDe: fonte };
    objetivo = `CONSULTAR:${alvo}`;
  }
  passos.push(final);
  const motivo: PlanoRastreio["motivo"] = ref.temporal?.seletor === "ULTIMO_CONTRATO" ? "ULTIMO_CONTRATO" : "REFERENCIA";
  return { plano: { objetivo, recursoFinal: alvo, passos }, motivo };
}
