export type CategoriaHorario = "PADRAO" | "NOBRE";
export type CategoriaPrecoPacote = "GERAL" | CategoriaHorario;
export type TipoCalculoPrecoPacote = "FIXO" | "POR_CONVIDADO";
export type EstadoElegibilidadePacote =
  | "DISPONIVEL"
  | "INDISPONIVEL"
  | "SOB_CONSULTA";

export type UnidadeCobrancaAdicional =
  | "VALOR_FIXO"
  | "CONVIDADO"
  | "UNIDADE"
  | "CENTO"
  | "HORA"
  | "PACOTE"
  | "METRO";

export type PacoteRecord = {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  convidadosMinimos: number | null;
  convidadosMaximos: number | null;
  duracaoMinutos: number | null;
  ordemExibicao: number;
  ativo: boolean;
};

export type TabelaPrecoRecord = {
  id: string;
  codigo: string;
  nome: string;
  vigenciaInicio: string;
  vigenciaFim: string | null;
  ativa: boolean;
};

export type RegraCategoriaHorarioRecord = {
  id: string;
  diaSemana: number;
  configuracaoAgendaId: string;
  categoriaHorario: CategoriaHorario;
  vigenciaInicio: string;
  vigenciaFim: string | null;
};

export type PrecoPacoteRecord = {
  id: string;
  tabelaPrecoId: string;
  pacoteId: string;
  convidadosMin: number;
  convidadosMax: number | null;
  tipoCalculo: TipoCalculoPrecoPacote;
  valor: number;
  categoriaHorario: CategoriaPrecoPacote;
  observacoes: string | null;
};

export type RegraElegibilidadePacoteRecord = {
  id: string;
  pacoteId: string;
  diaSemana: number;
  configuracaoAgendaId: string;
  estado: EstadoElegibilidadePacote;
  vigenciaInicio: string;
  vigenciaFim: string | null;
  observacoes: string | null;
};

export type PacoteComElegibilidadeRecord = PacoteRecord & {
  elegibilidade: EstadoElegibilidadePacote | null;
  regraElegibilidadeId: string | null;
};

export type AdicionalRecord = {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  categoria: string;
  unidadeCobranca: UnidadeCobrancaAdicional;
  ordemExibicao: number;
  ativo: boolean;
};

export type PrecoAdicionalRecord = {
  id: string;
  tabelaPrecoId: string;
  adicionalId: string;
  convidadosMin: number;
  convidadosMax: number | null;
  valor: number;
  observacoes: string | null;
};

export type AdicionalComPrecoRecord = AdicionalRecord & {
  preco: PrecoAdicionalRecord | null;
};

export type RegraDescontoPacoteRecord = {
  id: string;
  pacoteId: string;
  diaSemana: number;
  configuracaoAgendaId: string | null;
  percentual: number;
  baseCalculo: "PACOTE";
  codigo: string;
  titulo: string | null;
  prioridade: number;
  vigenciaInicio: string;
  vigenciaFim: string | null;
  observacoes: string | null;
};

export type BuscarPrecoPacoteAplicavelInput = {
  tabelaPrecoId: string;
  pacoteId: string;
  categoriaHorario: CategoriaHorario;
  convidados: number;
};

export type BuscarRegraComercialInput = {
  pacoteId: string;
  data: string;
  configuracaoAgendaId: string;
};

export type ListarPacotesElegibilidadeInput = {
  data: string;
  configuracaoAgendaId: string;
};

export type BuscarPrecosAdicionaisInput = {
  tabelaPrecoId: string;
  convidados: number;
  codigos?: string[];
};
