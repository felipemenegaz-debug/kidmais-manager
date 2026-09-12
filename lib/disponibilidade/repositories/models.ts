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
};

export type CriarBloqueioAgendaInput = {
  data: string;
  diaInteiro?: boolean;
  horarioInicio?: string | null;
  horarioFim?: string | null;
  motivo: string;
  observacoes?: string | null;
  usuarioId?: string | null;
};


export type OcupacaoConfirmadaRecord = {
  fechamentoId: string;
  data: string;
  horarioInicio: string;
  horarioFim: string;
};
