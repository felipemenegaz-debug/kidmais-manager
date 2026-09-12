export type ClienteFilter =
  | "TODOS"
  | "FESTA_FUTURA"
  | "FECHAMENTO_EM_ANDAMENTO"
  | "SEM_FESTA_FUTURA";

export type StatusFechamento =
  | "RASCUNHO"
  | "AGUARDANDO_APROVACAO"
  | "APROVADO"
  | "AGUARDANDO_CONTRATO"
  | "CONTRATO_ASSINADO"
  | "AGUARDANDO_PAGAMENTO"
  | "CONFIRMADO"
  | "CANCELADO"
  | "RECUSADO"
  | "EXPIRADO";

export type PerfilAcesso = "ATENDIMENTO" | "GESTOR" | "ADMINISTRADOR";

export type Cliente = {
  id: string;
  nomeCompleto: string;
  cpf: string | null;
  rg?: string | null;
  telefone: string | null;
  whatsapp: string | null;
  email: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  observacoes: string | null;
};

export type Aniversariante = {
  id: string;
  clienteId: string;
  nome: string;
  dataNascimento: string;
  temaPreferido: string | null;
  observacoes: string | null;
};

export type ResponsavelAdicional = {
  id: string;
  clienteId: string;
  nome: string;
  cpf: string | null;
  telefone: string | null;
  email: string | null;
  relacao: string | null;
  observacoes: string | null;
};

export type OrigemFechamento = "CLIENTE" | "ATENDIMENTO_KIDMAIS";

export type FechamentoClienteResumo = {
  id: string;
  dataEvento: string;
  horarioInicio: string;
  aniversarianteId: string | null;
  aniversarianteNome: string | null;
  pacoteNome: string | null;
  convidados: number | null;
  valorAprovado: number | null;
  status: StatusFechamento;
  origem: OrigemFechamento;
  iniciadoPor?: string | null;
  iniciadoEm?: string | null;
};

export type BuffetFestaDetalhe = {
  definicao: "AGORA" | "DEPOIS";
  salgados: string | null;
  bebidasSucos: string | null;
  doces: string | null;
  bolo: string | null;
  outros: string | null;
};

export type FestaClienteResumo = {
  id: string;
  fechamentoId: string;
  data: string;
  horarioInicio: string;
  aniversarianteId: string;
  aniversarianteNome: string;
  pacoteNome: string;
  convidados: number | null;
  status: "CONFIRMADA" | "CONCLUIDA" | "CANCELADA";

  // Snapshot/resumo do que foi confirmado no fechamento.
  temaFesta?: string | null;
  idadeAniversariante?: number | null;
  duracao?: string | null;
  adicionais?: string[];
  alteracoesPacote?: string | null;
  observacoesEquipe?: string | null;
  buffet?: BuffetFestaDetalhe | null;
  valorTabela?: number | null;
  valorAdicionais?: number | null;
  valorAprovado?: number | null;
  formaPagamento?: string | null;
  contratoStatus?: string | null;
  pagamentoStatus?: string | null;
  responsavelAdicional?: string | null;
};

export type HistoricoClienteTipo =
  | "CADASTRO"
  | "DADOS"
  | "ANIVERSARIANTE"
  | "RESPONSAVEL"
  | "FECHAMENTO"
  | "NEGOCIACAO"
  | "CONTRATO"
  | "PAGAMENTO"
  | "FESTA"
  | "MESCLAGEM";

export type HistoricoClienteItem = {
  id: string;
  tipo: HistoricoClienteTipo;
  titulo: string;
  descricao?: string | null;
  realizadoPor: string;
  dataHora: string;
  criticidade?: "NORMAL" | "CRITICA";
};

export type ClienteDetalhe = {
  cliente: Cliente;
  aniversariantes: Aniversariante[];
  responsaveis: ResponsavelAdicional[];
  fechamentos: FechamentoClienteResumo[];
  festas: FestaClienteResumo[];
};

export type ProximoEventoCliente = {
  id: string;
  tipo: "FECHAMENTO" | "FESTA";
  data: string;
  horarioInicio: string;
  aniversarianteNome: string | null;
  pacoteNome: string | null;
  status: string;
};

export type ClienteListaItem = {
  id: string;
  nomeCompleto: string;
  whatsapp: string | null;
  telefone: string | null;
  aniversariantes: { id: string; nome: string }[];
  proximoEvento: ProximoEventoCliente | null;
  cadastroCompleto: boolean;
};

export type ClienteFormData = {
  nomeCompleto: string;
  cpf: string;
  rg: string;
  whatsapp: string;
  telefone: string;
  email: string;
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  observacoes: string;
};

export type DuplicidadeCliente = {
  id: string;
  clienteAId: string;
  clienteBId: string;
  motivo: string;
  status: "PENDENTE" | "RESOLVIDA";
};
