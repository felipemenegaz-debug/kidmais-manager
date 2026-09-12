export type ClienteStatus = "ATIVO" | "INATIVO" | "MESCLADO";

export type ClienteRecord = {
  id: string;
  nomeCompleto: string;
  cpf: string | null;
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
  nomeCompleto: string;
  cpf?: string | null;
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
  Omit<CreateClienteInput, "usuarioId">
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
