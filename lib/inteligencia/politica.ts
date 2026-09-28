import type { Papel } from "../autenticacao/service.ts";
import type { ClasseFerramenta } from "./ferramentas.ts";

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

/**
 * Falha fechada. Na V1 só existe leitura: qualquer outra classe é recusada,
 * mesmo que alguém a registre por engano. Papel desconhecido também é recusado.
 */
export function autorizarFerramenta(
  sessao: { papel: string },
  ferramenta: { classe: ClasseFerramenta; papeis: readonly string[] },
): void {
  if (ferramenta.classe !== "READ") negar();
  if (!(PAPEIS_CONHECIDOS as readonly string[]).includes(sessao.papel)) negar();
  if (!ferramenta.papeis.includes(sessao.papel)) negar();
}
