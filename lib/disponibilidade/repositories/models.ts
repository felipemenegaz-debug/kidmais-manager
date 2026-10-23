export type ConfiguracaoAgendaRecord = {
  id: string;
  codigo: string;
  nome: string;
  horarioInicioPadrao: string;
  horarioFimPadrao: string;
  toleranciaInicioMinutos: number;
  passoInicioMinutos: number;
  ordemExibicao: number;
  ativo: boolean;
  /** 093: dias ISO (1 = segunda) em que o horário existe; null = todos. */
  diasSemana?: number[] | null;
  /** 093: a partir desta data (inclusive) o horário não é mais oferecido. */
  desativadoAPartirDe?: string | null;
};

export type BloqueioAgendaRecord = {
  id: string;
  data: string;
  diaInteiro: boolean;
  horarioInicio: string | null;
  horarioFim: string | null;
  motivo: string;
  observacoes: string | null;
  criadoPorUsuarioId: string | null;
  ativo: boolean;
  criadoEm: string;
  atualizadoEm: string;
  /** 062: null = alcance anterior (global para empresa; empresa inteira para unidade). */
  empresaId?: string | null;
  estabelecimentoId?: string | null;
  alcance?: AlcanceBloqueio;
};

/** GLOBAL = bloqueio anterior à 062 sem dono resolvido (vale para todas as empresas). */
export type AlcanceBloqueio = "GLOBAL" | "EMPRESA" | "UNIDADE";

export type CriarBloqueioAgendaInput = {
  data: string;
  diaInteiro?: boolean;
  horarioInicio?: string | null;
  horarioFim?: string | null;
  motivo: string;
  observacoes?: string | null;
  usuarioId?: string | null;
  /** Empresa comprovada pelo Tenant Context (gravada só com a 062 instalada). */
  empresaId?: string | null;
  estabelecimentoId?: string | null;
};


/** 094: regra de capacidade do escopo (093). null = regra de antes (qualquer sobreposição é conflito). */
export type RegraCapacidadeAgenda = {
  /** 093/2c-2: no modo livre, o horário técnico substitui os horários fixos no cálculo. */
  modo?: "FIXO" | "LIVRE";
  horarioLivre?: ConfiguracaoAgendaRecord | null;
  capacidadeTipo: "POR_HORARIO" | "POR_SALAO";
  limiteFestasDia: number | null;
  intervaloMinimoMinutos: number;
  capacidadePorHorario: Record<string, number>;
  saloesPorHorario: Record<string, string[]>;
  saloesDoEscopo: string[];
};

export type OcupacaoConfirmadaRecord = {
  fechamentoId: string;
  data: string;
  horarioInicio: string;
  horarioFim: string;
  /** 094: horário e salão da ocupação. */
  configuracaoAgendaId?: string | null;
  salaoId?: string | null;
};
