import {escolhasDisponiveis} from './escolhas-buffet';
import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import type {
  AprovacaoNegociacaoRecord,
  CreateAprovacaoNegociacaoInput,
  CreateFechamentoAdicionalInput,
  CreateFechamentoInput,
  FechamentoAdicionalRecord,
  FechamentoRecord,
} from "./models";

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

type FechamentoRow = {
  condicao_pagamento: FechamentoRecord["condicaoPagamento"];
  id: string;
  cliente_id: string | null;
  aniversariante_id: string | null;
  data_evento: string;
  horario_inicio: string;
  horario_fim: string;
  configuracao_agenda_id: string;
  pacote_id: string;
  tabela_preco_id: string;
  preco_pacote_id: string;
  regra_desconto_pacote_id: string | null;
  categoria_horario: FechamentoRecord["categoriaHorario"];
  categoria_preco_aplicada: FechamentoRecord["categoriaPrecoAplicada"];
  convidados: number;
  convidados_faturados: number;
  valor_pacote_base: string | number;
  desconto_percentual: string | number;
  valor_desconto_pacote: string | number;
  valor_pacote_aplicado: string | number;
  valor_adicionais: string | number;
  valor_tabela: string | number;
  valor_negociado: string | number | null;
  valor_aprovado: string | number | null;
  motivo_negociacao: string | null;
  observacoes_negociacao: string | null;
  status: FechamentoRecord["status"];
  origem_fechamento: FechamentoRecord["origemFechamento"];
  iniciado_por_usuario_id: string | null;
  iniciado_em: string;
  usuario_responsavel_id: string | null;
  responsavel_adicional_id: string | null;
  idade_aniversariante_evento: number | null;
  tema_festa: string | null;
  forma_pagamento_pretendida: FechamentoRecord["formaPagamentoPretendida"];
  alteracoes_pacote: string | null;
  observacoes_cliente: string | null;
  observacoes_equipe: string | null;
  buffet_status: FechamentoRecord["buffetStatus"];
  buffet_salgados: string | null;
  buffet_bebidas: string | null;
  buffet_doces: string | null;
  buffet_bolo: string | null;
  buffet_outros: string | null;
buffet_lembrancinha?: string | null;
buffet_empratado?: string | null;
buffet_bombom?: string | null;
  criado_em: string;
  atualizado_em: string;
};

type FechamentoAdicionalRow = {
  id: string;
  fechamento_id: string;
  adicional_id: string;
  preco_adicional_id: string;
  nome_aplicado: string;
  unidade_cobranca_aplicada: FechamentoAdicionalRecord["unidadeCobrancaAplicada"];
  quantidade: string | number;
  valor_unitario_aplicado: string | number;
  valor_total: string | number;
  observacoes: string | null;
  criado_em: string;
  atualizado_em: string;
};

type AprovacaoNegociacaoRow = {
  condicao_pagamento: AprovacaoNegociacaoRecord["condicaoPagamento"];
  id: string;
  fechamento_id: string;
  valor_informado: string | number;
  valor_aprovado: string | number | null;
  status: AprovacaoNegociacaoRecord["status"];
  motivo: string | null;
  aprovado_por_usuario_id: string | null;
  observacoes: string | null;
  criado_em: string;
};

const fechamentoColumns = `
  condicao_pagamento,
  id,
  cliente_id,
  aniversariante_id,
  data_evento::text AS data_evento,
  horario_inicio::text AS horario_inicio,
  horario_fim::text AS horario_fim,
  configuracao_agenda_id,
  pacote_id,
  tabela_preco_id,
  preco_pacote_id,
  regra_desconto_pacote_id,
  categoria_horario,
  categoria_preco_aplicada,
  convidados,
  convidados_faturados,
  valor_pacote_base,
  desconto_percentual,
  valor_desconto_pacote,
  valor_pacote_aplicado,
  valor_adicionais,
  valor_tabela,
  valor_negociado,
  valor_aprovado,
  motivo_negociacao,
  observacoes_negociacao,
  status,
  origem_fechamento,
  iniciado_por_usuario_id,
  iniciado_em::text AS iniciado_em,
  usuario_responsavel_id,
  responsavel_adicional_id,
  idade_aniversariante_evento,
  tema_festa,
  forma_pagamento_pretendida,
  alteracoes_pacote,
  observacoes_cliente,
  observacoes_equipe,
  buffet_status,
  buffet_salgados,
  buffet_bebidas,
  buffet_doces,
  buffet_bolo,
  buffet_outros,
  to_jsonb(fechamentos)->>'buffet_lembrancinha' AS buffet_lembrancinha,
  to_jsonb(fechamentos)->>'buffet_empratado' AS buffet_empratado,
  to_jsonb(fechamentos)->>'buffet_bombom' AS buffet_bombom,
  criado_em::text AS criado_em,
  atualizado_em::text AS atualizado_em
`;

const adicionalColumns = `
  id,
  fechamento_id,
  adicional_id,
  preco_adicional_id,
  nome_aplicado,
  unidade_cobranca_aplicada,
  quantidade,
  valor_unitario_aplicado,
  valor_total,
  observacoes,
  criado_em::text AS criado_em,
  atualizado_em::text AS atualizado_em
`;

const aprovacaoColumns = `
  condicao_pagamento,
  id,
  fechamento_id,
  valor_informado,
  valor_aprovado,
  status,
  motivo,
  aprovado_por_usuario_id,
  observacoes,
  criado_em::text AS criado_em
`;

function mapFechamento(row: FechamentoRow): FechamentoRecord {
  return {
    condicaoPagamento: row.condicao_pagamento,
    id: row.id,
    clienteId: row.cliente_id,
    aniversarianteId: row.aniversariante_id,
    dataEvento: row.data_evento,
    horarioInicio: row.horario_inicio,
    horarioFim: row.horario_fim,
    configuracaoAgendaId: row.configuracao_agenda_id,
    pacoteId: row.pacote_id,
    tabelaPrecoId: row.tabela_preco_id,
    precoPacoteId: row.preco_pacote_id,
    regraDescontoPacoteId: row.regra_desconto_pacote_id,
    categoriaHorario: row.categoria_horario,
    categoriaPrecoAplicada: row.categoria_preco_aplicada,
    convidados: Number(row.convidados),
    convidadosFaturados: Number(row.convidados_faturados),
    valorPacoteBase: Number(row.valor_pacote_base),
    descontoPercentual: Number(row.desconto_percentual),
    valorDescontoPacote: Number(row.valor_desconto_pacote),
    valorPacoteAplicado: Number(row.valor_pacote_aplicado),
    valorAdicionais: Number(row.valor_adicionais),
    valorTabela: Number(row.valor_tabela),
    valorNegociado:
      row.valor_negociado === null ? null : Number(row.valor_negociado),
    valorAprovado:
      row.valor_aprovado === null ? null : Number(row.valor_aprovado),
    motivoNegociacao: row.motivo_negociacao,
    observacoesNegociacao: row.observacoes_negociacao,
    status: row.status,
    origemFechamento: row.origem_fechamento,
    iniciadoPorUsuarioId: row.iniciado_por_usuario_id,
    iniciadoEm: row.iniciado_em,
    usuarioResponsavelId: row.usuario_responsavel_id,
    responsavelAdicionalId: row.responsavel_adicional_id,
    idadeAniversarianteEvento:
      row.idade_aniversariante_evento === null ? null : Number(row.idade_aniversariante_evento),
    temaFesta: row.tema_festa,
    formaPagamentoPretendida: row.forma_pagamento_pretendida,
    alteracoesPacote: row.alteracoes_pacote,
    observacoesCliente: row.observacoes_cliente,
    observacoesEquipe: row.observacoes_equipe,
    buffetStatus: row.buffet_status,
    buffetSalgados: row.buffet_salgados,
    buffetBebidas: row.buffet_bebidas,
    buffetDoces: row.buffet_doces,
    buffetBolo: row.buffet_bolo,
    buffetOutros: row.buffet_outros,
buffetLembrancinha: row.buffet_lembrancinha ?? null,
buffetEmpratado: row.buffet_empratado ?? null,
buffetBombom: row.buffet_bombom ?? null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

function mapAdicional(row: FechamentoAdicionalRow): FechamentoAdicionalRecord {
  return {
    id: row.id,
    fechamentoId: row.fechamento_id,
    adicionalId: row.adicional_id,
    precoAdicionalId: row.preco_adicional_id,
    nomeAplicado: row.nome_aplicado,
    unidadeCobrancaAplicada: row.unidade_cobranca_aplicada,
    quantidade: Number(row.quantidade),
    valorUnitarioAplicado: Number(row.valor_unitario_aplicado),
    valorTotal: Number(row.valor_total),
    observacoes: row.observacoes,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

function mapAprovacao(row: AprovacaoNegociacaoRow): AprovacaoNegociacaoRecord {
  return {
    condicaoPagamento: row.condicao_pagamento,
    id: row.id,
    fechamentoId: row.fechamento_id,
    valorInformado: Number(row.valor_informado),
    valorAprovado:
      row.valor_aprovado === null ? null : Number(row.valor_aprovado),
    status: row.status,
    motivo: row.motivo,
    aprovadoPorUsuarioId: row.aprovado_por_usuario_id,
    observacoes: row.observacoes,
    criadoEm: row.criado_em,
  };
}

export async function criarFechamento(
  input: CreateFechamentoInput,
  customDb?: DbExecutor,
): Promise<FechamentoRecord> {
  const escolhas = await escolhasDisponiveis(executor(customDb));
  if(!escolhas && [input.buffetLembrancinha,input.buffetEmpratado,input.buffetBombom].some(v=>!!v))throw new Error("Escolhas adicionais ainda indisponíveis neste ambiente.");
  const result = await executor(customDb).query<FechamentoRow>(
    `INSERT INTO fechamentos (
       cliente_id,
       aniversariante_id,
       data_evento,
       horario_inicio,
       horario_fim,
       configuracao_agenda_id,
       pacote_id,
       tabela_preco_id,
       preco_pacote_id,
       regra_desconto_pacote_id,
       categoria_horario,
       categoria_preco_aplicada,
       convidados,
       convidados_faturados,
       valor_pacote_base,
       desconto_percentual,
       valor_desconto_pacote,
       valor_pacote_aplicado,
       valor_adicionais,
       valor_tabela,
       valor_negociado,
       valor_aprovado,
       motivo_negociacao,
       observacoes_negociacao,
       status,
       origem_fechamento,
       iniciado_por_usuario_id,
       usuario_responsavel_id,
       responsavel_adicional_id,
       idade_aniversariante_evento,
       tema_festa,
       forma_pagamento_pretendida,
       alteracoes_pacote,
       observacoes_cliente,
       observacoes_equipe,
       buffet_status,
       buffet_salgados,
       buffet_bebidas,
       buffet_doces,
       buffet_bolo,
       buffet_outros,
       condicao_pagamento ${escolhas ? ",buffet_lembrancinha,buffet_empratado,buffet_bombom" : ""}
     ) VALUES (
       $1::uuid,
       $2::uuid,
       $3::date,
       $4::time,
       $5::time,
       $6::uuid,
       $7::uuid,
       $8::uuid,
       $9::uuid,
       $10::uuid,
       $11,
       $12,
       $13,
       $14,
       $15,
       $16,
       $17,
       $18,
       $19,
       $20,
       $21,
       $22,
       $23,
       $24,
       $25,
       $26,
       $27::uuid,
       $28::uuid,
       $29::uuid,
       $30,
       $31,
       $32,
       $33,
       $34,
       $35,
       $36,
       $37,
       $38,
       $39,
       $40,
       $41,
       $42::jsonb ${escolhas ? ",$43,$44,$45" : ""}
     )
     RETURNING ${fechamentoColumns}`,
    [
      input.clienteId ?? null,
      input.aniversarianteId ?? null,
      input.dataEvento,
      input.horarioInicio,
      input.horarioFim,
      input.configuracaoAgendaId,
      input.pacoteId,
      input.tabelaPrecoId,
      input.precoPacoteId,
      input.regraDescontoPacoteId ?? null,
      input.categoriaHorario,
      input.categoriaPrecoAplicada,
      input.convidados,
      input.convidadosFaturados,
      input.valorPacoteBase,
      input.descontoPercentual ?? 0,
      input.valorDescontoPacote ?? 0,
      input.valorPacoteAplicado,
      input.valorAdicionais ?? 0,
      input.valorTabela,
      input.valorNegociado ?? null,
      input.valorAprovado ?? null,
      input.motivoNegociacao ?? null,
      input.observacoesNegociacao ?? null,
      input.status,
      input.origemFechamento,
      input.iniciadoPorUsuarioId ?? null,
      input.usuarioResponsavelId ?? null,
      input.responsavelAdicionalId ?? null,
      input.idadeAniversarianteEvento ?? null,
      input.temaFesta ?? null,
      input.formaPagamentoPretendida ?? null,
      input.alteracoesPacote ?? null,
      input.observacoesCliente ?? null,
      input.observacoesEquipe ?? null,
      input.buffetStatus ?? "PENDENTE",
      input.buffetSalgados ?? null,
      input.buffetBebidas ?? null,
      input.buffetDoces ?? null,
      input.buffetBolo ?? null,
      input.buffetOutros ?? null,
      input.condicaoPagamento ? JSON.stringify(input.condicaoPagamento) : null,
      ...(escolhas ? [input.buffetLembrancinha ?? null,input.buffetEmpratado ?? null,input.buffetBombom ?? null] : []),
    ],
  );

  return mapFechamento(result.rows[0]);
}

export async function buscarFechamentoPorId(
  fechamentoId: string,
  customDb?: DbExecutor,
): Promise<FechamentoRecord | null> {
  const result = await executor(customDb).query<FechamentoRow>(
    `SELECT ${fechamentoColumns}
       FROM fechamentos
      WHERE id = $1::uuid
      LIMIT 1`,
    [fechamentoId],
  );

  return result.rows[0] ? mapFechamento(result.rows[0]) : null;
}

export async function buscarFechamentoPorIdParaAtualizacao(
  fechamentoId: string,
  customDb: DbExecutor,
): Promise<FechamentoRecord | null> {
  const result = await executor(customDb).query<FechamentoRow>(
    `SELECT ${fechamentoColumns}
       FROM fechamentos
      WHERE id = $1::uuid
      LIMIT 1
      FOR UPDATE`,
    [fechamentoId],
  );

  return result.rows[0] ? mapFechamento(result.rows[0]) : null;
}

export async function marcarFechamentoContratoAssinado(
  fechamentoId: string,
  customDb?: DbExecutor,
): Promise<FechamentoRecord | null> {
  const result = await executor(customDb).query<FechamentoRow>(
    `UPDATE fechamentos
        SET status = 'CONTRATO_ASSINADO'
      WHERE id = $1::uuid
        AND status = 'AGUARDANDO_CONTRATO'
      RETURNING ${fechamentoColumns}`,
    [fechamentoId],
  );

  return result.rows[0] ? mapFechamento(result.rows[0]) : null;
}

export async function marcarFechamentoAguardandoPagamento(
  fechamentoId: string,
  customDb?: DbExecutor,
): Promise<FechamentoRecord | null> {
  const result = await executor(customDb).query<FechamentoRow>(
    `UPDATE fechamentos
        SET status = 'AGUARDANDO_PAGAMENTO'
      WHERE id = $1::uuid
        AND status = 'CONTRATO_ASSINADO'
      RETURNING ${fechamentoColumns}`,
    [fechamentoId],
  );

  return result.rows[0] ? mapFechamento(result.rows[0]) : null;
}

export async function marcarFechamentoConfirmado(
  fechamentoId: string,
  customDb?: DbExecutor,
): Promise<FechamentoRecord | null> {
  const result = await executor(customDb).query<FechamentoRow>(
    `UPDATE fechamentos
        SET status = 'CONFIRMADO'
      WHERE id = $1::uuid
        AND status = 'AGUARDANDO_PAGAMENTO'
      RETURNING ${fechamentoColumns}`,
    [fechamentoId],
  );

  return result.rows[0] ? mapFechamento(result.rows[0]) : null;
}

export async function criarFechamentoAdicional(
  input: CreateFechamentoAdicionalInput,
  customDb?: DbExecutor,
): Promise<FechamentoAdicionalRecord> {
  const result = await executor(customDb).query<FechamentoAdicionalRow>(
    `INSERT INTO fechamento_adicionais (
       fechamento_id,
       adicional_id,
       preco_adicional_id,
       nome_aplicado,
       unidade_cobranca_aplicada,
       quantidade,
       valor_unitario_aplicado,
       valor_total,
       observacoes
     ) VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9
     )
     RETURNING ${adicionalColumns}`,
    [
      input.fechamentoId,
      input.adicionalId,
      input.precoAdicionalId,
      input.nomeAplicado.trim(),
      input.unidadeCobrancaAplicada,
      input.quantidade,
      input.valorUnitarioAplicado,
      input.valorTotal,
      input.observacoes ?? null,
    ],
  );

  return mapAdicional(result.rows[0]);
}

export async function listarAdicionaisDoFechamento(
  fechamentoId: string,
  customDb?: DbExecutor,
): Promise<FechamentoAdicionalRecord[]> {
  const result = await executor(customDb).query<FechamentoAdicionalRow>(
    `SELECT ${adicionalColumns}
       FROM fechamento_adicionais
      WHERE fechamento_id = $1::uuid
      ORDER BY criado_em ASC, id ASC`,
    [fechamentoId],
  );

  return result.rows.map(mapAdicional);
}

export async function criarAprovacaoNegociacao(
  input: CreateAprovacaoNegociacaoInput,
  customDb?: DbExecutor,
): Promise<AprovacaoNegociacaoRecord> {
  const result = await executor(customDb).query<AprovacaoNegociacaoRow>(
    `INSERT INTO aprovacoes_negociacao (
       fechamento_id,
       valor_informado,
       valor_aprovado,
       status,
       motivo,
       aprovado_por_usuario_id,
       observacoes,
       condicao_pagamento
     ) VALUES (
       $1::uuid,
       $2,
       $3,
       $4,
       $5,
       $6::uuid,
       $7,
       $8::jsonb
     )
     RETURNING ${aprovacaoColumns}`,
    [
      input.fechamentoId,
      input.valorInformado,
      input.valorAprovado ?? null,
      input.status,
      input.motivo ?? null,
      input.aprovadoPorUsuarioId ?? null,
      input.observacoes ?? null,
      input.condicaoPagamento ? JSON.stringify(input.condicaoPagamento) : null,
    ],
  );

  return mapAprovacao(result.rows[0]);
}

export async function listarAprovacoesDoFechamento(
  fechamentoId: string,
  customDb?: DbExecutor,
): Promise<AprovacaoNegociacaoRecord[]> {
  const result = await executor(customDb).query<AprovacaoNegociacaoRow>(
    `SELECT ${aprovacaoColumns}
       FROM aprovacoes_negociacao
      WHERE fechamento_id = $1::uuid
      ORDER BY criado_em ASC, id ASC`,
    [fechamentoId],
  );

  return result.rows.map(mapAprovacao);
}

export async function registrarDecisaoNoFechamento(
  fechamento: FechamentoRecord,
  decisao: { aprovada: boolean; valorBase: number | null; condicao: NonNullable<FechamentoRecord["condicaoPagamento"]> },
  tx: DbExecutor,
) {
  // Aprovação de condição sem negociação de valor não inventa valor_negociado/valor_aprovado.
  await tx.query(`UPDATE fechamentos SET status=$2, valor_aprovado=$3, condicao_pagamento=$4::jsonb
    WHERE id=$1::uuid`, [fechamento.id, decisao.aprovada ? "AGUARDANDO_CONTRATO" : "RECUSADO",
    fechamento.valorNegociado !== null && decisao.aprovada ? decisao.valorBase : null,
    JSON.stringify(decisao.condicao)]);
  return (await buscarFechamentoPorId(fechamento.id, tx))!;
}
