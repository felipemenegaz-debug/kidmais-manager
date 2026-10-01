import type { OrigemChamada, ResultadoPolitica } from "./contratos.ts";
import { InteligenciaError } from "./politica.ts";
import type { Manifesto } from "./registro-ferramentas.ts";

/**
 * Policy V1: decisão única e pura sobre o MANIFESTO do Tool Registry (nunca sobre o que o pedido ou o modelo dizem).
 *
 * Ordem (a primeira negação vence):
 * 1. sem manifesto ⇒ NEGADO_SEM_MANIFESTO (ferramenta ou ação fora do registro nunca executa);
 * 2. FORBIDDEN ⇒ NEGADO_DENY;
 * 3. caminho × classe: LEITURA só READ; SUGESTAO só SUGGEST; HUMAN_GATE e CONFIRMACAO só CONFIRM ⇒ NEGADO_CLASSE;
 * 4. origem: CONFIRMACAO só pela origem HUMAN_GATE (clique humano no endpoint de confirmação); modelo, JEV, regras e
 *    agentes nunca confirmam ⇒ NEGADO_ORIGEM;
 * 5. papel: desconhecido ou fora de `papeisExigidos` ⇒ NEGADO_PAPEL. Dentro do tenant, o papel é o da MEMBERSHIP
 *    comprovada (`papelAtual`), não o da sessão;
 * 6. flags: grupo exigido desligado no ambiente, ou fora da allowlist da empresa comprovada ⇒ NEGADO_FLAG;
 * 7. estabelecimento: capacidade ESTABLISHMENT sem unidade COMPROVADA no Tenant Context ⇒ NEGADO_ESTABELECIMENTO.
 *    (Avaliado dentro do tenant; unidade pedida e não comprovada já falha antes, no Establishment Context.)
 *
 * Aprovação anterior não concede autoridade: cada passo do Human Gate (abrir, responder, confirmar, cancelar) chama a
 * Policy de novo com o estado atual (papel, flags, manifesto).
 */
export const VERSAO_POLITICA = "policy-v1.0.0";

export type CaminhoPolitica = "LEITURA" | "SUGESTAO" | "HUMAN_GATE" | "CONFIRMACAO";

export type EntradaPolitica = {
  papel: string;
  manifesto: Manifesto | null;
  caminho: CaminhoPolitica;
  origem: OrigemChamada;
  /** Grupo de flag ativo no ambiente. */
  grupoAtivo: boolean;
  /** Allowlist da empresa comprovada; null ⇒ ainda sem tenant (avaliação prévia, refeita dentro do tenant). */
  grupoAtivoNaEmpresa: boolean | null;
  /**
   * Unidade comprovada no Tenant Context (null = escopo da empresa). undefined ⇒ ainda sem tenant (avaliação
   * prévia); a regra de estabelecimento é aplicada na reavaliação dentro do tenant.
   */
  estabelecimento?: string | null;
};

const PAPEIS_CONHECIDOS: readonly string[] = ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"];
const CLASSE_DO_CAMINHO = { LEITURA: "READ", SUGESTAO: "SUGGEST", HUMAN_GATE: "CONFIRM", CONFIRMACAO: "CONFIRM" } as const;

export function decidirPolitica(e: EntradaPolitica): ResultadoPolitica {
  const m = e.manifesto;
  if (!m) return "NEGADO_SEM_MANIFESTO";
  if (m.classe === "FORBIDDEN") return "NEGADO_DENY";
  if (CLASSE_DO_CAMINHO[e.caminho] !== m.classe) return "NEGADO_CLASSE";
  if (e.caminho === "CONFIRMACAO" && e.origem !== "HUMAN_GATE") return "NEGADO_ORIGEM";
  if (!PAPEIS_CONHECIDOS.includes(e.papel) || !m.papeisExigidos.includes(e.papel)) return "NEGADO_PAPEL";
  if (!e.grupoAtivo || e.grupoAtivoNaEmpresa === false) return "NEGADO_FLAG";
  if (m.escopoEstabelecimento === "ESTABLISHMENT" && e.estabelecimento === null) return "NEGADO_ESTABELECIMENTO";
  return "PERMITIDO";
}

/** Mensagens humanas por negação; nenhuma revela regra interna, papel alheio ou existência de outro tenant. */
const MENSAGENS: Readonly<Record<Exclude<ResultadoPolitica, "PERMITIDO">, [string, number, string]>> = {
  NEGADO_SEM_MANIFESTO: ["CAPACIDADE_DESCONHECIDA", 400, "Capacidade não disponível."],
  NEGADO_DENY: ["ACAO_NEGADA", 403, "Esse pedido não é feito pelo Kidmais."],
  NEGADO_CLASSE: ["INTELIGENCIA_NAO_AUTORIZADA", 403, "Seu acesso não permite esta operação."],
  NEGADO_ORIGEM: ["INTELIGENCIA_NAO_AUTORIZADA", 403, "Esta ação só é concluída pela sua confirmação."],
  NEGADO_PAPEL: ["INTELIGENCIA_NAO_AUTORIZADA", 403, "Seu acesso não permite esta operação."],
  NEGADO_FLAG: ["INTELIGENCIA_DESATIVADA", 503, "Kidmais Intelligence indisponível neste ambiente."],
  NEGADO_ESTABELECIMENTO: ["ESTABELECIMENTO_OBRIGATORIO", 400, "Escolha a unidade para esta consulta."],
};

/** Falha fechada: qualquer negação vira InteligenciaError com mensagem humana. Devolve a decisão (PERMITIDO). */
export function exigirPolitica(e: EntradaPolitica): ResultadoPolitica {
  const r = decidirPolitica(e);
  if (r !== "PERMITIDO") {
    const [codigo, status, mensagem] = MENSAGENS[r];
    throw new InteligenciaError(codigo, mensagem, status);
  }
  return r;
}
