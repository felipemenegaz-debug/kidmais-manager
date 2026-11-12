import type { PeriodoDisponibilidadePublica } from "./models.ts";

/**
 * 2c-2: o "almoço/noite" da conversa (IA, links antigos) num horário da empresa: TURNO_1/TURNO_2 quando existem; senão
 * o horário que começa mais cedo (almoço) ou mais tarde (noite); com um único horário (ex.: o horário livre), ele.
 */
export function periodoDoTurno<P extends Pick<PeriodoDisponibilidadePublica, "codigo" | "horarioInicioPadrao">>(
  periodos: readonly P[],
  turno: string | null | undefined,
): P | undefined {
  const codigo = turno === "almoco" ? "TURNO_1" : turno === "noite" ? "TURNO_2" : null;
  if (!codigo) return undefined;
  const exato = periodos.find((p) => p.codigo === codigo);
  if (exato || periodos.length === 0) return exato;
  if (periodos.length === 1) return periodos[0];
  const ordenados = [...periodos].sort((a, b) => a.horarioInicioPadrao.localeCompare(b.horarioInicioPadrao));
  return turno === "almoco" ? ordenados[0] : ordenados[ordenados.length - 1];
}

