export type ClienteStatus = "ATIVO" | "INATIVO" | "MESCLADO";

/** 112: pessoa física (padrão, CPF) ou jurídica (CNPJ). Sem a 112 todo cliente é PF. */
export type TipoPessoa = "PF" | "PJ";

export type ClienteRecord = {
  id: string;
  empresaId: string | null;
  /** PF: nome da pessoa. PJ: razão social (a busca e as telas seguem por este campo). */
  nomeCompleto: string;
  tipoPessoa: TipoPessoa;
  cpf: string | null;
  /** 112, só PJ: CNPJ canônico (14, numérico ou alfanumérico). */
  cnpj: string | null;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  /** Representante legal da PJ: texto contratual, nunca chave de identidade nem de duplicidade. */
  representanteNome: string | null;
  representanteCpf: string | null;
  rg: string | null;
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
  status: ClienteStatus;
  clientePrincipalId: string | null;
  mescladoEm: string | null;
  criadoPorUsuarioId: string | null;
  atualizadoPorUsuarioId: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type CreateClienteInput = {
  empresaId: string | null;
  nomeCompleto: string;
  /** Ausente = PF. PJ exige a 112 aplicada (o serviço recusa antes, com PJ_INDISPONIVEL). */
  tipoPessoa?: TipoPessoa;
  cpf?: string | null;
  cnpj?: string | null;
  nomeFantasia?: string | null;
  representanteNome?: string | null;
  representanteCpf?: string | null;
  rg?: string | null;
  telefone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  observacoes?: string | null;
  usuarioId?: string | null;
};

export type UpdateClienteInput = Partial<
  Omit<CreateClienteInput, "usuarioId" | "empresaId">
> & {
  usuarioId?: string | null;
};

export type AniversarianteRecord = {
  id: string;
  clienteId: string;
  nome: string;
  dataNascimento: string | null;
  temaPadrao: string | null;
  observacoes: string | null;
  ativo: boolean;
  desativadoEm: string | null;
  criadoPorUsuarioId: string | null;
  atualizadoPorUsuarioId: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type CreateAniversarianteInput = {
  clienteId: string;
  nome: string;
  dataNascimento?: string | null;
  temaPadrao?: string | null;
  observacoes?: string | null;
  usuarioId?: string | null;
};

export type UpdateAniversarianteInput = Partial<
  Pick<CreateAniversarianteInput, "nome" | "dataNascimento" | "temaPadrao" | "observacoes">
> & {
  usuarioId?: string | null;
};

export type ResponsavelRecord = {
  id: string;
  clienteId: string;
  nome: string;
  cpf: string | null;
  telefone: string | null;
  whatsapp: string | null;
  email: string | null;
  relacao: string | null;
  observacoes: string | null;
  ativo: boolean;
  desativadoEm: string | null;
  criadoPorUsuarioId: string | null;
  atualizadoPorUsuarioId: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

export type CreateResponsavelInput = {
  clienteId: string;
  nome: string;
  cpf?: string | null;
  telefone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  relacao?: string | null;
  observacoes?: string | null;
  usuarioId?: string | null;
};

export type UpdateResponsavelInput = Partial<
  Omit<CreateResponsavelInput, "clienteId" | "usuarioId">
> & {
  usuarioId?: string | null;
};

export type HistoricoClienteRecord = {
  id: string;
  clienteId: string;
  clienteOrigemId: string | null;
  tipoEvento: string;
  origem: string;
  entidadeTipo: string | null;
  entidadeId: string | null;
  usuarioId: string | null;
  detalhe: string | null;
  metadata: Record<string, unknown>;
  critico: boolean;
  criadoEm: string;
};

export type AuditoriaRecord = {
  id: string;
  clienteId: string | null;
  atorTipo: "USUARIO" | "CLIENTE" | "SISTEMA";
  usuarioId: string | null;
  acao: string;
  entidadeTipo: string;
  entidadeId: string;
  dadosAntes: Record<string, unknown> | null;
  dadosDepois: Record<string, unknown> | null;
  justificativa: string | null;
  origem: string;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  criadoEm: string;
};

export type DuplicidadeStatus = "PENDENTE" | "DESCARTADA" | "CONFIRMADA" | "MESCLADA";

export type DuplicidadeRecord = {
  id: string;
  clienteAId: string;
  clienteBId: string;
  motivos: string[];
  status: DuplicidadeStatus;
  observacoes: string | null;
  criadoEm: string;
  analisadoPorUsuarioId: string | null;
  analisadoEm: string | null;
  mesclagemId: string | null;
};

export type MesclagemRecord = {
  id: string;
  clientePrincipalId: string;
  clienteSecundarioId: string;
  motivo: string;
  resolucaoCampos: Record<string, unknown>;
  executadoPorUsuarioId: string;
  criadoEm: string;
};
