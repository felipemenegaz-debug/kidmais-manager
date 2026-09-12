export type StatusOperacionalPublico = "DISPONIVEL" | "INDISPONIVEL";

export type HorarioCandidatoPublico = {
  inicio: string;
  fim: string;
  ajusteMinutos: number;
  status: StatusOperacionalPublico;
};

export type PeriodoDisponibilidadePublica = {
  configuracaoId: string;
  codigo: string;
  nome: string;
  horarioInicioPadrao: string;
  horarioFimPadrao: string;
  status: StatusOperacionalPublico;
  horarios: HorarioCandidatoPublico[];
};

export type DisponibilidadeDataPublica = {
  data: string;
  periodos: PeriodoDisponibilidadePublica[];
};
