export type StatusOperacionalPublico = "DISPONIVEL" | "INDISPONIVEL";

/** S-C: OK = há salão livre que comporta; OCUPADO = sem salão livre; CAPACIDADE = nenhum salão (livre) comporta. */
export type MotivoCapacidade = "OK" | "OCUPADO" | "CAPACIDADE";

/** S-C: só contagens e motivo, nunca ids, nomes de salão ou ocupações de outras festas. */
export type CapacidadeConvidadosPublica = { opcoes: number; motivo: MotivoCapacidade };

export type HorarioCandidatoPublico = {
  pacotesVendaveis?: string[];
  inicio: string;
  fim: string;
  ajusteMinutos: number;
  status: StatusOperacionalPublico;
  /** S-C: só com convidados informados e capacidade por salão. */
  capacidade?: CapacidadeConvidadosPublica;
};

export type PeriodoDisponibilidadePublica = {
  motivoComercial?: string;
  minimoFaturavel?: number;
  avisoMinimoFaturavel?: string;
  configuracaoId: string;
  codigo: string;
  nome: string;
  horarioInicioPadrao: string;
  horarioFimPadrao: string;
  status: StatusOperacionalPublico;
  horarios: HorarioCandidatoPublico[];
  /** S-C: soma dos horários (alguma opção = OK). */
  capacidade?: CapacidadeConvidadosPublica;
};

export type DisponibilidadeDataPublica = {
  minimoFaturavel?: number;
  data: string;
  periodos: PeriodoDisponibilidadePublica[];
  /** S-C: soma dos períodos do dia, para o calendário. */
  motivoDia?: CapacidadeConvidadosPublica;
};
