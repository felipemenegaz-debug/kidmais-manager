import type {
  AdicionalComPrecoRecord,
  CategoriaHorario,
  EstadoElegibilidadePacote,
  PacoteRecord,
  PrecoPacoteRecord,
  RegraDescontoPacoteRecord,
  TabelaPrecoRecord,
  UnidadeCobrancaAdicional,
} from "../repositories";

export type ObterContextoComercialInput = {
  data: string;
  configuracaoAgendaId: string;
};

export type ContextoComercial = {
  tabelaPreco: TabelaPrecoRecord;
  categoriaHorario: CategoriaHorario;
};

export type PrecificarPacoteInput = ObterContextoComercialInput & {
  pacoteId: string;
  convidados: number;
};

export type DescontoAplicado = {
  aplicado: boolean;
  regraId: string | null;
  codigo: string | null;
  titulo: string | null;
  percentual: number;
  valor: number;
};

export type ResultadoPrecoPacote = {
  pacote: PacoteRecord;
  tabelaPreco: TabelaPrecoRecord;
  categoriaHorario: CategoriaHorario;
  elegibilidade: EstadoElegibilidadePacote;
  convidadosInformados: number;
  convidadosFaturados: number;
  minimoFaturavelAplicado: boolean;
  precoRegra: PrecoPacoteRecord;
  valorTabelaBase: number;
  desconto: DescontoAplicado;
  valorTabelaAplicado: number;
};

export type AdicionalSelecionadoInput = {
  codigo: string;
  quantidade?: number;
};

export type PrecificarAdicionaisInput = {
  data: string;
  convidados: number;
  itens: AdicionalSelecionadoInput[];
};

export type AdicionalPrecificado = {
  adicionalId: string;
  codigo: string;
  nome: string;
  categoria: string;
  unidadeCobranca: UnidadeCobrancaAdicional;
  precoRegraId: string;
  quantidade: number;
  valorUnitarioAplicado: number;
  valorTotal: number;
};

export type ResultadoAdicionais = {
  tabelaPreco: TabelaPrecoRecord;
  convidados: number;
  itens: AdicionalPrecificado[];
  valorTotal: number;
};

export type CalcularResumoComercialInput = PrecificarPacoteInput & {
  adicionais?: AdicionalSelecionadoInput[];
};

export type ResumoComercial = {
  pacote: ResultadoPrecoPacote;
  adicionais: ResultadoAdicionais;
  valorTabelaPacoteBase: number;
  valorDescontoPacote: number;
  valorTabelaPacoteAplicado: number;
  valorAdicionais: number;
  valorTotalTabela: number;
};

export type CatalogoAdicionaisInput = {
  data: string;
  convidados: number;
  codigos?: string[];
};

export type CatalogoAdicionais = {
  tabelaPreco: TabelaPrecoRecord;
  convidados: number;
  itens: AdicionalComPrecoRecord[];
};

export type PacoteComercialResumo = {
  pacote: PacoteRecord;
  elegibilidade: EstadoElegibilidadePacote | null;
  regraElegibilidadeId: string | null;
};

export type ListarPacotesComerciaisInput = ObterContextoComercialInput;

export type RegraDescontoSelecionada = RegraDescontoPacoteRecord | null;
