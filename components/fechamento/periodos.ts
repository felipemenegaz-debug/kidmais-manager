import type { HorarioCandidatoPublico, PeriodoDisponibilidadePublica } from "../../lib/disponibilidade/services/models.ts";
import type { HorarioBase } from "./types.ts";

/**
 * Horários configurados da agenda (configuracao_agenda): qualquer quantidade por empresa, identificados por
 * `configuracaoId`. Só TURNO_1/TURNO_2 têm o equivalente legado almoco/noite (regras fixas Kidmais, ajustes e
 * descontos manuais em JSON, scripts antigos); os demais (HORARIO_n) não têm e recebem "".
 */
export function horarioLegadoDoCodigo(codigo: string | null | undefined): HorarioBase | "" {
  if (codigo === "TURNO_1") return "almoco";
  if (codigo === "TURNO_2") return "noite";
  return "";
}

/** Código do período a partir do legado almoco/noite (links e scripts antigos). */
export function codigoDoHorarioLegado(horario: string | null | undefined): "TURNO_1" | "TURNO_2" | null {
  if (horario === "almoco") return "TURNO_1";
  if (horario === "noite") return "TURNO_2";
  return null;
}

/** 2c-2: almoço/noite → horário configurado (regra em lib, compartilhada com a IA). */
export { periodoDoTurno } from "../../lib/disponibilidade/services/turno-legado.ts";

/** Rótulo do horário configurado: nome e faixa padrão (ex.: "Tarde · 14:00–18:00"). */
export function rotuloPeriodo(periodo: Pick<PeriodoDisponibilidadePublica, "nome" | "horarioInicioPadrao" | "horarioFimPadrao"> & { codigo?: string }) {
  // Horário técnico do modo livre: o cliente escolhe a hora de início; a faixa 00:00–23:59 não informa nada.
  if (periodo.codigo === "HORARIO_LIVRE") return periodo.nome || "Horário livre";
  const faixa = `${periodo.horarioInicioPadrao}–${periodo.horarioFimPadrao}`;
  return periodo.nome ? `${periodo.nome} · ${faixa}` : faixa;
}

/** Candidatos livres do horário, na ordem do servidor (o deslocamento vem da tolerância/passo de cada horário). */
export function candidatosDisponiveis(periodo: Pick<PeriodoDisponibilidadePublica, "horarios"> | null | undefined): HorarioCandidatoPublico[] {
  return (periodo?.horarios ?? []).filter((item) => item.status === "DISPONIVEL");
}

/** Candidato preferido: o horário padrão (ajuste 0) quando livre; senão o primeiro livre. */
export function candidatoPreferido(candidatos: readonly HorarioCandidatoPublico[]): HorarioCandidatoPublico | null {
  return candidatos.find((item) => item.ajusteMinutos === 0) ?? candidatos[0] ?? null;
}

/** Texto do deslocamento do candidato em relação ao horário padrão. */
export function rotuloAjuste(ajusteMinutos: number) {
  if (ajusteMinutos === 0) return "Horário padrão";
  return ajusteMinutos < 0 ? `${-ajusteMinutos} minutos antes` : `${ajusteMinutos} minutos depois`;
}
