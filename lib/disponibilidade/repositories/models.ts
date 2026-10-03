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


export type OcupacaoConfirmadaRecord = {
  fechamentoId: string;
  data: string;
  horarioInicio: string;
  horarioFim: string;
};
