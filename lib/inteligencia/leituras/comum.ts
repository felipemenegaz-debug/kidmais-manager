import { z } from "zod";
import type { Papel } from "../../autenticacao/service.ts";
import type { EntidadeRef, Evidencia, Fato, ItemResposta, RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta } from "../ferramentas.ts";

/**
 * Peças comuns das respostas READ. Todo número vem de serviço de domínio ou de cálculo determinístico
 * aqui; nenhum texto é produzido por modelo. Cada frase é classificada como FATO, CALCULO ou AUSENCIA.
 */

/** Paridade com as telas: Dashboard, Financeiro, CRM e Contratos exigem só sessão e tenant comprovado. */
export const PAPEIS_ADMIN: readonly Papel[] = ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"];

export const semParametros = z.object({}).strict();
export const comEntidade = z.object({ id: z.string().uuid() }).strict();

export function plural(n: number, singular: string, pluralTexto: string) {
  return n === 1 ? singular : pluralTexto;
}

export function fato(texto: string, fonte: string): Fato {
  return { natureza: "FATO", texto, fonte };
}

export function calculo(texto: string, fonte: string): Fato {
  return { natureza: "CALCULO", texto, fonte };
}

/** Parâmetro que o usuário informou só para esta consulta (nunca padrão da empresa). */
export function parametro(texto: string, fonte: string): Fato {
  return { natureza: "PARAMETRO", texto, fonte };
}

/** Hipótese pedida pelo usuário: nunca padrão da empresa, nunca recomendação comprovada. */
export function estimativa(texto: string, fonte: string): Fato {
  return { natureza: "ESTIMATIVA", texto, fonte };
}

export function ausencia(texto: string, fonte: string): Fato {
  return { natureza: "AUSENCIA", texto, fonte };
}

export function evidencia(fonte: string, rotulo: string, valor: string | number, destino?: string): Evidencia {
  return { fonte, rotulo, valor: String(valor), ...(destino ? { destino } : {}) };
}

export function montarResposta(
  capacidade: string,
  contexto: ContextoFerramenta,
  partes: {
    estado: RespostaLeitura["estado"];
    resumo: string;
    fatos: Fato[];
    itens?: ItemResposta[];
    evidencias?: Evidencia[];
    fontes: string[];
    /** AI V1.1 (PR 4): referências de entidade do Core (só quando a leitura as devolve). */
    entidades?: EntidadeRef[];
  },
): RespostaLeitura {
  return {
    capacidade,
    estado: partes.estado,
    resumo: partes.resumo,
    fatos: partes.fatos,
    itens: partes.itens ?? [],
    evidencias: partes.evidencias ?? [],
    referencia: { hoje: contexto.hoje, geradoEm: contexto.geradoEm, fontes: [...new Set(partes.fontes)] },
    ...(partes.entidades ? { entidades: partes.entidades } : {}),
  };
}

/** Diferença em dias entre duas datas ISO (YYYY-MM-DD), sem fuso. */
export function diasEntre(de: string, ate: string) {
  return Math.round((Date.parse(`${ate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${de.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export function somarDias(data: string, dias: number) {
  const d = new Date(`${data.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function dataCurta(data: string) {
  const [ano, mes, dia] = data.slice(0, 10).split("-");
  return dia && mes && ano ? `${dia}/${mes}/${ano}` : data;
}

/** Id de entidade devolvido ao foco só se for UUID (o outputSchema exige). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
