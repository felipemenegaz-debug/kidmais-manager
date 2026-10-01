import type { TipoEntidade } from "../contratos.ts";
import type { CapacidadeCatalogo } from "../intencao.ts";
import type { FatoSolicitado } from "./composicao.ts";
import { CAPACIDADES_NAVEGACAO, validarPlano, type MotivoRejeicao, type PassoPlano, type Plano } from "./plano.ts";

/**
 * Complemento DETERMINÍSTICO do plano (AI V1.1, PR 6.4.3), ANTES da execução.
 *
 * Confere se as leituras que entram na resposta (final + marcadas) cobrem os fatos pedidos no texto. Faltando, e
 * havendo uma leitura conhecida e uma referência INEQUÍVOCA ao mesmo contrato na cadeia do plano, acrescenta os passos
 * que faltam — sempre a partir das relações do Core (nunca de id, nunca de escrita):
 *   - cliente      ⇒ relações da festa/contrato na resposta;
 *   - situação     ⇒ resumir_contrato do CONTRATO das relações (ou do último contrato);
 *   - posição      ⇒ saldo_contrato do mesmo CONTRATO.
 * O plano completo é VALIDADO DE NOVO por inteiro (entradas, dependências, `resposta`, limites). Se não for possível
 * completar com segurança, o plano original segue e a completude aponta, na resposta, o que faltou.
 */

/** Leituras que FORNECEM cada fato (as mesmas que a composição aceita como cobertura). */
export const FORNECEDORES: Readonly<Record<FatoSolicitado, readonly string[]>> = {
  CLIENTE: ["relacoes_festa", "relacoes_contrato", "resumir_cliente"],
  SITUACAO_CONTRATO: ["resumir_contrato"],
  POSICAO_FINANCEIRA: ["saldo_contrato"],
  CONVIDADOS: ["contexto_operacional_festa"],
  BUFFET: ["contexto_operacional_festa"],
};

/** Fonte inequívoca de UM contrato na cadeia: relações (o contrato da festa/do contrato) ou o último contrato. */
const FONTES_DE_CONTRATO = new Set(["relacoes_festa", "relacoes_contrato", "ultimo_contrato"]);

export type Complemento =
  | { tipo: "INALTERADO" }
  | { tipo: "COMPLETADO"; plano: Plano; adicionados: string[]; marcados: string[] }
  | { tipo: "IMPOSSIVEL"; motivo: "SEM_FONTE" | "NAVEGACAO_OU_ACAO" | MotivoRejeicao };

const id = (i: number) => `p${i + 1}` as PassoPlano["id"];

export function completarPlano(plano: Plano, solicitados: readonly FatoSolicitado[], catalogo: readonly CapacidadeCatalogo[], contexto: readonly TipoEntidade[]): Complemento {
  const ultimo = plano.passos.length - 1;
  const naResposta = (p: PassoPlano, i: number) => i === ultimo || p.resposta === true;
  const faltam = solicitados.filter((f) => !plano.passos.some((p, i) => naResposta(p, i) && FORNECEDORES[f].includes(p.capacidade)));
  if (!faltam.length) return { tipo: "INALTERADO" };
  const final = plano.passos[ultimo];
  // Navegação e ação mantêm o contrato atual: nada é acrescentado depois delas.
  if (CAPACIDADES_NAVEGACAO.has(final.capacidade) || catalogo.find((c) => c.id === final.capacidade)?.tipo !== "leitura") {
    return { tipo: "IMPOSSIVEL", motivo: "NAVEGACAO_OU_ACAO" };
  }

  const passos: PassoPlano[] = plano.passos.map((p) => ({ ...p }));
  const adicionados: string[] = [];
  const marcados: string[] = [];
  const empurrar = (p: Omit<PassoPlano, "id">) => { passos.push({ ...p, id: id(passos.length) } as PassoPlano); adicionados.push(p.capacidade); return passos.at(-1)!; };

  // Relações da cadeia (já no plano, ou a partir da festa / do contrato que o plano ancorou).
  // IA operacional: convidados/buffet ⇒ projeção operacional da MESMA festa da cadeia (passo que produz FESTA).
  if (faltam.includes("CONVIDADOS") || faltam.includes("BUFFET")) {
    const festa = passos.find((p) => p.capacidade !== "contexto_operacional_festa" && catalogo.find((c) => c.id === p.capacidade)?.produz?.includes("FESTA"));
    if (!festa) return { tipo: "IMPOSSIVEL", motivo: "SEM_FONTE" };
    empurrar({ capacidade: "contexto_operacional_festa", entradaDe: { de: "PASSO", passo: festa.id, entidade: "FESTA" }, resposta: true });
  }
  if (!faltam.some((f) => f === "CLIENTE" || f === "SITUACAO_CONTRATO" || f === "POSICAO_FINANCEIRA")) {
    passos[ultimo].resposta = true;
    delete passos[passos.length - 1].resposta;
    const v = validarPlano({ ...plano, passos }, catalogo, { contexto });
    if (!v.ok) return { tipo: "IMPOSSIVEL", motivo: v.motivo };
    return { tipo: "COMPLETADO", plano: v.plano, adicionados, marcados };
  }
  let relacoes = passos.find((p) => p.capacidade === "relacoes_festa" || p.capacidade === "relacoes_contrato");
  const precisaContrato = faltam.includes("SITUACAO_CONTRATO") || faltam.includes("POSICAO_FINANCEIRA");
  let fonteContrato = relacoes ?? passos.find((p) => FONTES_DE_CONTRATO.has(p.capacidade));
  if (!relacoes && (faltam.includes("CLIENTE") || (precisaContrato && !fonteContrato))) {
    // Âncora de festa: listagem/leitura de festa sem entrada (ou da tela/foco revalidados).
    const festa = passos.find((p) => catalogo.find((c) => c.id === p.capacidade)?.produz?.includes("FESTA") && (!p.entradaDe || p.entradaDe.de === "CONTEXTO"));
    const contrato = passos.find((p) => p.capacidade === "ultimo_contrato");
    if (festa) relacoes = empurrar({ capacidade: "relacoes_festa", entradaDe: { de: "PASSO", passo: festa.id, entidade: "FESTA" } });
    else if (contrato) relacoes = empurrar({ capacidade: "relacoes_contrato", entradaDe: { de: "PASSO", passo: contrato.id, entidade: "CONTRATO" } });
    else return { tipo: "IMPOSSIVEL", motivo: "SEM_FONTE" };
    fonteContrato = relacoes;
  }
  if (faltam.includes("CLIENTE") && !relacoes!.resposta && !adicionados.includes(relacoes!.capacidade)) marcados.push(relacoes!.capacidade);
  if (faltam.includes("CLIENTE")) relacoes!.resposta = true;
  if (precisaContrato) {
    if (!fonteContrato) return { tipo: "IMPOSSIVEL", motivo: "SEM_FONTE" };
    const de = { de: "PASSO" as const, passo: fonteContrato.id, entidade: "CONTRATO" as const };
    if (faltam.includes("SITUACAO_CONTRATO")) empurrar({ capacidade: "resumir_contrato", entradaDe: de, resposta: true });
    if (faltam.includes("POSICAO_FINANCEIRA")) empurrar({ capacidade: "saldo_contrato", entradaDe: de, resposta: true });
  }
  // A leitura final original continua na resposta (agora intermediária); a nova última é a final.
  passos[ultimo].resposta = true;
  delete passos[passos.length - 1].resposta;

  // Plano alterado ⇒ VALIDAÇÃO COMPLETA de novo (entradas, dependências, `resposta`, limites de passos).
  const v = validarPlano({ ...plano, passos }, catalogo, { contexto });
  if (!v.ok) return { tipo: "IMPOSSIVEL", motivo: v.motivo };
  return { tipo: "COMPLETADO", plano: v.plano, adicionados, marcados };
}
