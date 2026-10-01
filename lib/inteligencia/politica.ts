import type { Papel } from "../autenticacao/service.ts";
import type { ClasseAcao, ResultadoPolitica } from "./contratos.ts";

export class InteligenciaError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "InteligenciaError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const PAPEIS_CONHECIDOS: readonly Papel[] = ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"];

function negar(): never {
  throw new InteligenciaError("INTELIGENCIA_NAO_AUTORIZADA", "Seu acesso não permite esta consulta.", 403);
}

/** Avaliação pura, usada pelo trace. Papel desconhecido e DENY nunca passam. */
export function avaliarPolitica(
  sessao: { papel: string },
  ferramenta: { classe: ClasseAcao; papeis: readonly string[] },
  caminho: "LEITURA" | "HUMAN_GATE",
): ResultadoPolitica {
  if (ferramenta.classe === "DENY") return "NEGADO_DENY";
  if (caminho === "LEITURA" && ferramenta.classe !== "READ") return "NEGADO_CLASSE";
  if (caminho === "HUMAN_GATE" && ferramenta.classe !== "CONFIRM") return "NEGADO_CLASSE";
  if (!(PAPEIS_CONHECIDOS as readonly string[]).includes(sessao.papel)) return "NEGADO_PAPEL";
  if (!ferramenta.papeis.includes(sessao.papel)) return "NEGADO_PAPEL";
  return "PERMITIDO";
}

/**
 * Falha fechada no caminho de leitura: só READ executa, mesmo que alguém registre outra classe por engano.
 * Papel desconhecido também é recusado.
 */
export function autorizarFerramenta(
  sessao: { papel: string },
  ferramenta: { classe: ClasseAcao; papeis: readonly string[] },
): void {
  if (avaliarPolitica(sessao, ferramenta, "LEITURA") !== "PERMITIDO") negar();
}

/**
 * Caminho do Human Gate: só CONFIRM, com o papel que já faz a mesma operação na tela.
 * Chamado ao montar o rascunho E de novo depois da confirmação humana (RBAC pode ter sido revogado).
 */
export function autorizarAcao(
  sessao: { papel: string },
  ferramenta: { classe: ClasseAcao; papeis: readonly string[] },
): void {
  if (avaliarPolitica(sessao, ferramenta, "HUMAN_GATE") !== "PERMITIDO") {
    throw new InteligenciaError("INTELIGENCIA_NAO_AUTORIZADA", "Seu acesso não permite esta ação.", 403);
  }
}
