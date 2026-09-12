import type {
  AniversarianteRecord,
  AuditoriaRecord,
  ClienteRecord,
  DuplicidadeRecord,
  HistoricoClienteRecord,
  MesclagemRecord,
  ResponsavelRecord,
} from "./models";

type ClienteRow = {
  id: string;
  nome_completo: string;
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
  status: ClienteRecord["status"];
  cliente_principal_id: string | null;
  mesclado_em: Date | string | null;
  criado_por_usuario_id: string | null;
  atualizado_por_usuario_id: string | null;
  criado_em: Date | string;
  atualizado_em: Date | string;
};

type AniversarianteRow = {
  id: string;
  cliente_id: string;
  nome: string;
  data_nascimento: Date | string | null;
  tema_padrao: string | null;
  observacoes: string | null;
  ativo: boolean;
  desativado_em: Date | string | null;
  criado_por_usuario_id: string | null;
  atualizado_por_usuario_id: string | null;
  criado_em: Date | string;
  atualizado_em: Date | string;
};

type ResponsavelRow = {
  id: string;
  cliente_id: string;
  nome: string;
  cpf: string | null;
  telefone: string | null;
  whatsapp: string | null;
  email: string | null;
  relacao: string | null;
  observacoes: string | null;
  ativo: boolean;
  desativado_em: Date | string | null;
  criado_por_usuario_id: string | null;
  atualizado_por_usuario_id: string | null;
  criado_em: Date | string;
  atualizado_em: Date | string;
};

type HistoricoRow = {
  id: string;
  cliente_id: string;
  cliente_origem_id: string | null;
  tipo_evento: string;
  origem: string;
  entidade_tipo: string | null;
  entidade_id: string | null;
  usuario_id: string | null;
  detalhe: string | null;
  metadata: Record<string, unknown>;
  critico: boolean;
  criado_em: Date | string;
};

type AuditoriaRow = {
  id: string;
  cliente_id: string | null;
  ator_tipo: AuditoriaRecord["atorTipo"];
  usuario_id: string | null;
  acao: string;
  entidade_tipo: string;
  entidade_id: string;
  dados_antes: Record<string, unknown> | null;
  dados_depois: Record<string, unknown> | null;
  justificativa: string | null;
  origem: string;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  criado_em: Date | string;
};

type DuplicidadeRow = {
  id: string;
  cliente_a_id: string;
  cliente_b_id: string;
  motivos: string[];
  status: DuplicidadeRecord["status"];
  observacoes: string | null;
  criado_em: Date | string;
  analisado_por_usuario_id: string | null;
  analisado_em: Date | string | null;
  mesclagem_id: string | null;
};

type MesclagemRow = {
  id: string;
  cliente_principal_id: string;
  cliente_secundario_id: string;
  motivo: string;
  resolucao_campos: Record<string, unknown>;
  executado_por_usuario_id: string;
  criado_em: Date | string;
};

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function isoNullable(value: Date | string | null) {
  return value == null ? null : iso(value);
}

function dateOnly(value: Date | string | null) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function mapCliente(row: ClienteRow): ClienteRecord {
  return {
    id: row.id,
    nomeCompleto: row.nome_completo,
    cpf: row.cpf,
    rg: row.rg,
    telefone: row.telefone,
    whatsapp: row.whatsapp,
    email: row.email,
    cep: row.cep,
    logradouro: row.logradouro,
    numero: row.numero,
    complemento: row.complemento,
    bairro: row.bairro,
    cidade: row.cidade,
    uf: row.uf,
    observacoes: row.observacoes,
    status: row.status,
    clientePrincipalId: row.cliente_principal_id,
    mescladoEm: isoNullable(row.mesclado_em),
    criadoPorUsuarioId: row.criado_por_usuario_id,
    atualizadoPorUsuarioId: row.atualizado_por_usuario_id,
    criadoEm: iso(row.criado_em),
    atualizadoEm: iso(row.atualizado_em),
  };
}

export function mapAniversariante(row: AniversarianteRow): AniversarianteRecord {
  return {
    id: row.id,
    clienteId: row.cliente_id,
    nome: row.nome,
    dataNascimento: dateOnly(row.data_nascimento),
    temaPadrao: row.tema_padrao,
    observacoes: row.observacoes,
    ativo: row.ativo,
    desativadoEm: isoNullable(row.desativado_em),
    criadoPorUsuarioId: row.criado_por_usuario_id,
    atualizadoPorUsuarioId: row.atualizado_por_usuario_id,
    criadoEm: iso(row.criado_em),
    atualizadoEm: iso(row.atualizado_em),
  };
}

export function mapResponsavel(row: ResponsavelRow): ResponsavelRecord {
  return {
    id: row.id,
    clienteId: row.cliente_id,
    nome: row.nome,
    cpf: row.cpf,
    telefone: row.telefone,
    whatsapp: row.whatsapp,
    email: row.email,
    relacao: row.relacao,
    observacoes: row.observacoes,
    ativo: row.ativo,
    desativadoEm: isoNullable(row.desativado_em),
    criadoPorUsuarioId: row.criado_por_usuario_id,
    atualizadoPorUsuarioId: row.atualizado_por_usuario_id,
    criadoEm: iso(row.criado_em),
    atualizadoEm: iso(row.atualizado_em),
  };
}

export function mapHistorico(row: HistoricoRow): HistoricoClienteRecord {
  return {
    id: row.id,
    clienteId: row.cliente_id,
    clienteOrigemId: row.cliente_origem_id,
    tipoEvento: row.tipo_evento,
    origem: row.origem,
    entidadeTipo: row.entidade_tipo,
    entidadeId: row.entidade_id,
    usuarioId: row.usuario_id,
    detalhe: row.detalhe,
    metadata: row.metadata ?? {},
    critico: row.critico,
    criadoEm: iso(row.criado_em),
  };
}

export function mapAuditoria(row: AuditoriaRow): AuditoriaRecord {
  return {
    id: row.id,
    clienteId: row.cliente_id,
    atorTipo: row.ator_tipo,
    usuarioId: row.usuario_id,
    acao: row.acao,
    entidadeTipo: row.entidade_tipo,
    entidadeId: row.entidade_id,
    dadosAntes: row.dados_antes,
    dadosDepois: row.dados_depois,
    justificativa: row.justificativa,
    origem: row.origem,
    requestId: row.request_id,
    ip: row.ip,
    userAgent: row.user_agent,
    criadoEm: iso(row.criado_em),
  };
}

export function mapDuplicidade(row: DuplicidadeRow): DuplicidadeRecord {
  return {
    id: row.id,
    clienteAId: row.cliente_a_id,
    clienteBId: row.cliente_b_id,
    motivos: row.motivos,
    status: row.status,
    observacoes: row.observacoes,
    criadoEm: iso(row.criado_em),
    analisadoPorUsuarioId: row.analisado_por_usuario_id,
    analisadoEm: isoNullable(row.analisado_em),
    mesclagemId: row.mesclagem_id,
  };
}

export function mapMesclagem(row: MesclagemRow): MesclagemRecord {
  return {
    id: row.id,
    clientePrincipalId: row.cliente_principal_id,
    clienteSecundarioId: row.cliente_secundario_id,
    motivo: row.motivo,
    resolucaoCampos: row.resolucao_campos ?? {},
    executadoPorUsuarioId: row.executado_por_usuario_id,
    criadoEm: iso(row.criado_em),
  };
}

export type {
  ClienteRow,
  AniversarianteRow,
  ResponsavelRow,
  HistoricoRow,
  AuditoriaRow,
  DuplicidadeRow,
  MesclagemRow,
};
