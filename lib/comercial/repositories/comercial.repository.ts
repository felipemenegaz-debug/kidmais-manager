import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import { LIMITES_PIZZA_PARTY } from '../pacotes-v1';
import type {
  AdicionalComPrecoRecord,
  BuscarPrecoPacoteAplicavelInput,
  BuscarPrecosAdicionaisInput,
  BuscarRegraComercialInput,
  CategoriaHorario,
  ListarPacotesElegibilidadeInput,
  PacoteComElegibilidadeRecord,
  PacoteRecord,
  PrecoPacoteRecord,
  RegraCategoriaHorarioRecord,
  RegraDescontoPacoteRecord,
  RegraElegibilidadePacoteRecord,
  TabelaPrecoRecord,
  UnidadeCobrancaAdicional,
} from "./models";

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

type PacoteRow = {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  convidados_minimos: number | null;
  convidados_maximos: number | null;
  duracao_minutos: number | null;
  ordem_exibicao: number;
  ativo: boolean;
};

type TabelaPrecoRow = {
  id: string;
  codigo: string;
  nome: string;
  vigencia_inicio: string;
  vigencia_fim: string | null;
  ativa: boolean;
};

type RegraCategoriaHorarioRow = {
  id: string;
  dia_semana: number;
  configuracao_agenda_id: string;
  categoria_horario: CategoriaHorario;
  vigencia_inicio: string;
  vigencia_fim: string | null;
};

type PrecoPacoteRow = {
  id: string;
  tabela_preco_id: string;
  pacote_id: string;
  convidados_min: number;
  convidados_max: number | null;
  tipo_calculo: "FIXO" | "POR_CONVIDADO";
  valor: string | number;
  categoria_horario: "GERAL" | CategoriaHorario;
  observacoes: string | null;
};

type RegraElegibilidadeRow = {
  id: string;
  pacote_id: string;
  dia_semana: number;
  configuracao_agenda_id: string;
  estado: "DISPONIVEL" | "INDISPONIVEL" | "SOB_CONSULTA";
  vigencia_inicio: string;
  vigencia_fim: string | null;
  observacoes: string | null;
};

type PacoteElegibilidadeRow = PacoteRow & {
  elegibilidade: "DISPONIVEL" | "INDISPONIVEL" | "SOB_CONSULTA" | null;
  regra_elegibilidade_id: string | null;
};

type AdicionalComPrecoRow = {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  categoria: string;
  unidade_cobranca: UnidadeCobrancaAdicional;
  ordem_exibicao: number;
  ativo: boolean;
  preco_id: string | null;
  tabela_preco_id: string | null;
  convidados_min: number | null;
  convidados_max: number | null;
  valor: string | number | null;
  preco_observacoes: string | null;
};

type RegraDescontoRow = {
  id: string;
  pacote_id: string;
  dia_semana: number;
  configuracao_agenda_id: string | null;
  percentual: string | number;
  base_calculo: "PACOTE";
  codigo: string;
  titulo: string | null;
  prioridade: number;
  vigencia_inicio: string;
  vigencia_fim: string | null;
  observacoes: string | null;
};

const pacoteColumns = `
  id,
  codigo,
  nome,
  descricao,
  convidados_minimos,
  convidados_maximos,
  duracao_minutos,
  ordem_exibicao,
  ativo
`;

function mapPacote(row: PacoteRow): PacoteRecord {
  return {
    id: row.id,
    codigo: row.codigo,
    nome: row.nome,
    descricao: row.descricao,
    convidadosMinimos:
      row.codigo === 'PIZZA_PARTY' ? LIMITES_PIZZA_PARTY.minimo : row.convidados_minimos === null ? null : Number(row.convidados_minimos),
    convidadosMaximos:
      row.codigo === 'PIZZA_PARTY' ? LIMITES_PIZZA_PARTY.maximo : row.convidados_maximos === null ? null : Number(row.convidados_maximos),
    duracaoMinutos:
      row.duracao_minutos === null ? null : Number(row.duracao_minutos),
    ordemExibicao: Number(row.ordem_exibicao),
    ativo: row.ativo,
  };
}

function mapTabelaPreco(row: TabelaPrecoRow): TabelaPrecoRecord {
  return {
    id: row.id,
    codigo: row.codigo,
    nome: row.nome,
    vigenciaInicio: row.vigencia_inicio,
    vigenciaFim: row.vigencia_fim,
    ativa: row.ativa,
  };
}

function mapRegraCategoriaHorario(
  row: RegraCategoriaHorarioRow,
): RegraCategoriaHorarioRecord {
  return {
    id: row.id,
    diaSemana: Number(row.dia_semana),
    configuracaoAgendaId: row.configuracao_agenda_id,
    categoriaHorario: row.categoria_horario,
    vigenciaInicio: row.vigencia_inicio,
    vigenciaFim: row.vigencia_fim,
  };
}

function mapPrecoPacote(row: PrecoPacoteRow): PrecoPacoteRecord {
  return {
    id: row.id,
    tabelaPrecoId: row.tabela_preco_id,
    pacoteId: row.pacote_id,
    convidadosMin: Number(row.convidados_min),
    convidadosMax:
      row.convidados_max === null ? null : Number(row.convidados_max),
    tipoCalculo: row.tipo_calculo,
    valor: Number(row.valor),
    categoriaHorario: row.categoria_horario,
    observacoes: row.observacoes,
  };
}

function mapRegraElegibilidade(
  row: RegraElegibilidadeRow,
): RegraElegibilidadePacoteRecord {
  return {
    id: row.id,
    pacoteId: row.pacote_id,
    diaSemana: Number(row.dia_semana),
    configuracaoAgendaId: row.configuracao_agenda_id,
    estado: row.estado,
    vigenciaInicio: row.vigencia_inicio,
    vigenciaFim: row.vigencia_fim,
    observacoes: row.observacoes,
  };
}

function mapPacoteElegibilidade(
  row: PacoteElegibilidadeRow,
): PacoteComElegibilidadeRecord {
  return {
    ...mapPacote(row),
    elegibilidade: row.elegibilidade,
    regraElegibilidadeId: row.regra_elegibilidade_id,
  };
}

function mapAdicionalComPreco(row: AdicionalComPrecoRow): AdicionalComPrecoRecord {
  return {
    id: row.id,
    codigo: row.codigo,
    nome: row.nome,
    descricao: row.descricao,
    categoria: row.categoria,
    unidadeCobranca: row.unidade_cobranca,
    ordemExibicao: Number(row.ordem_exibicao),
    ativo: row.ativo,
    preco:
      row.preco_id && row.tabela_preco_id && row.convidados_min !== null && row.valor !== null
        ? {
            id: row.preco_id,
            tabelaPrecoId: row.tabela_preco_id,
            adicionalId: row.id,
            convidadosMin: Number(row.convidados_min),
            convidadosMax:
              row.convidados_max === null ? null : Number(row.convidados_max),
            valor: Number(row.valor),
            observacoes: row.preco_observacoes,
          }
        : null,
  };
}

function mapRegraDesconto(row: RegraDescontoRow): RegraDescontoPacoteRecord {
  return {
    id: row.id,
    pacoteId: row.pacote_id,
    diaSemana: Number(row.dia_semana),
    configuracaoAgendaId: row.configuracao_agenda_id,
    percentual: Number(row.percentual),
    baseCalculo: row.base_calculo,
    codigo: row.codigo,
    titulo: row.titulo,
    prioridade: Number(row.prioridade),
    vigenciaInicio: row.vigencia_inicio,
    vigenciaFim: row.vigencia_fim,
    observacoes: row.observacoes,
  };
}

export async function listarPacotesAtivos(
  customDb?: DbExecutor,
): Promise<PacoteRecord[]> {
  const result = await executor(customDb).query<PacoteRow>(
    `SELECT ${pacoteColumns}
       FROM pacotes
      WHERE ativo = true
      ORDER BY ordem_exibicao ASC, nome ASC`,
  );

  return result.rows.map(mapPacote);
}

export async function buscarPacoteAtivoPorId(
  pacoteId: string,
  customDb?: DbExecutor,
): Promise<PacoteRecord | null> {
  const result = await executor(customDb).query<PacoteRow>(
    `SELECT ${pacoteColumns}
       FROM pacotes
      WHERE id = $1::uuid
        AND ativo = true
      LIMIT 1`,
    [pacoteId],
  );

  return result.rows[0] ? mapPacote(result.rows[0]) : null;
}

export async function buscarPacoteAtivoPorCodigo(
  codigo: string,
  customDb?: DbExecutor,
): Promise<PacoteRecord | null> {
  const result = await executor(customDb).query<PacoteRow>(
    `SELECT ${pacoteColumns}
       FROM pacotes
      WHERE codigo = $1
        AND ativo = true
      LIMIT 1`,
    [codigo.trim().toUpperCase()],
  );

  return result.rows[0] ? mapPacote(result.rows[0]) : null;
}

/**
 * Retorna a tabela ativa aplicável à data informada.
 * Caso futuramente exista mais de uma tabela ativa por erro/configuração,
 * a de vigência mais recente prevalece de forma determinística.
 */
export async function buscarTabelaPrecoVigente(
  data: string,
  customDb?: DbExecutor,
): Promise<TabelaPrecoRecord | null> {
  const result = await executor(customDb).query<TabelaPrecoRow>(
    `SELECT
       id,
       codigo,
       nome,
       vigencia_inicio::text AS vigencia_inicio,
       vigencia_fim::text AS vigencia_fim,
       ativa
     FROM tabelas_preco
     WHERE ativa = true
       AND vigencia_inicio <= $1::date
       AND (vigencia_fim IS NULL OR vigencia_fim >= $1::date)
     ORDER BY vigencia_inicio DESC, criado_em DESC
     LIMIT 1`,
    [data],
  );

  return result.rows[0] ? mapTabelaPreco(result.rows[0]) : null;
}

export async function buscarCategoriaHorarioAplicavel(
  data: string,
  configuracaoAgendaId: string,
  customDb?: DbExecutor,
): Promise<RegraCategoriaHorarioRecord | null> {
  const result = await executor(customDb).query<RegraCategoriaHorarioRow>(
    `SELECT
       id,
       dia_semana,
       configuracao_agenda_id,
       categoria_horario,
       vigencia_inicio::text AS vigencia_inicio,
       vigencia_fim::text AS vigencia_fim
     FROM regras_categoria_horario
     WHERE ativo = true
       AND dia_semana = EXTRACT(ISODOW FROM $1::date)::smallint
       AND configuracao_agenda_id = $2::uuid
       AND vigencia_inicio <= $1::date
       AND (vigencia_fim IS NULL OR vigencia_fim >= $1::date)
     ORDER BY vigencia_inicio DESC
     LIMIT 1`,
    [data, configuracaoAgendaId],
  );

  return result.rows[0] ? mapRegraCategoriaHorario(result.rows[0]) : null;
}

export async function buscarElegibilidadePacoteAplicavel(
  input: BuscarRegraComercialInput,
  customDb?: DbExecutor,
): Promise<RegraElegibilidadePacoteRecord | null> {
  const result = await executor(customDb).query<RegraElegibilidadeRow>(
    `SELECT
       id,
       pacote_id,
       dia_semana,
       configuracao_agenda_id,
       estado,
       vigencia_inicio::text AS vigencia_inicio,
       vigencia_fim::text AS vigencia_fim,
       observacoes
     FROM regras_disponibilidade_pacote
     WHERE ativo = true
       AND pacote_id = $1::uuid
       AND dia_semana = EXTRACT(ISODOW FROM $2::date)::smallint
       AND configuracao_agenda_id = $3::uuid
       AND vigencia_inicio <= $2::date
       AND (vigencia_fim IS NULL OR vigencia_fim >= $2::date)
     ORDER BY vigencia_inicio DESC
     LIMIT 1`,
    [input.pacoteId, input.data, input.configuracaoAgendaId],
  );

  return result.rows[0] ? mapRegraElegibilidade(result.rows[0]) : null;
}

/**
 * Lista os pacotes ativos já acompanhados do estado comercial para a data/turno.
 * `null` significa ausência de regra persistida e NÃO deve ser interpretado como
 * DISPONIVEL pelo Service.
 */
export async function listarPacotesAtivosComElegibilidade(
  input: ListarPacotesElegibilidadeInput,
  customDb?: DbExecutor,
): Promise<PacoteComElegibilidadeRecord[]> {
  const result = await executor(customDb).query<PacoteElegibilidadeRow>(
    `SELECT
       p.id,
       p.codigo,
       p.nome,
       p.descricao,
       p.convidados_minimos,
       p.convidados_maximos,
       p.duracao_minutos,
       p.ordem_exibicao,
       p.ativo,
       r.estado AS elegibilidade,
       r.id AS regra_elegibilidade_id
     FROM pacotes p
     LEFT JOIN LATERAL (
       SELECT regra.id, regra.estado
       FROM regras_disponibilidade_pacote regra
       WHERE regra.ativo = true
         AND regra.pacote_id = p.id
         AND regra.dia_semana = EXTRACT(ISODOW FROM $1::date)::smallint
         AND regra.configuracao_agenda_id = $2::uuid
         AND regra.vigencia_inicio <= $1::date
         AND (regra.vigencia_fim IS NULL OR regra.vigencia_fim >= $1::date)
       ORDER BY regra.vigencia_inicio DESC
       LIMIT 1
     ) r ON true
     WHERE p.ativo = true
     ORDER BY p.ordem_exibicao ASC, p.nome ASC`,
    [input.data, input.configuracaoAgendaId],
  );

  return result.rows.map(mapPacoteElegibilidade);
}

/**
 * Resolve a faixa de preço do pacote. A categoria exata (PADRAO/NOBRE) tem
 * prioridade; GERAL é fallback apenas para pacotes sem variação de horário.
 */
export async function buscarPrecoPacoteAplicavel(
  input: BuscarPrecoPacoteAplicavelInput,
  customDb?: DbExecutor,
): Promise<PrecoPacoteRecord | null> {
  const result = await executor(customDb).query<PrecoPacoteRow>(
    `SELECT
       id,
       tabela_preco_id,
       pacote_id,
       convidados_min,
       convidados_max,
       tipo_calculo,
       valor,
       categoria_horario,
       observacoes
     FROM precos_pacote
     WHERE ativo = true
       AND tabela_preco_id = $1::uuid
       AND pacote_id = $2::uuid
       AND convidados_min <= $3::smallint
       AND (convidados_max IS NULL OR convidados_max >= $3::smallint)
       AND categoria_horario IN ($4, 'GERAL')
     ORDER BY
       CASE WHEN categoria_horario = $4 THEN 0 ELSE 1 END,
       convidados_min DESC
     LIMIT 1`,
    [
      input.tabelaPrecoId,
      input.pacoteId,
      input.convidados,
      input.categoriaHorario,
    ],
  );

  return result.rows[0] ? mapPrecoPacote(result.rows[0]) : null;
}

/**
 * Retorna adicionais ativos e, quando existente, a faixa de preço aplicável ao
 * número de convidados. Sem preço aplicável, `preco` será null.
 */
export async function listarAdicionaisAtivosComPreco(
  input: BuscarPrecosAdicionaisInput,
  customDb?: DbExecutor,
): Promise<AdicionalComPrecoRecord[]> {
  const codigos = input.codigos?.map((codigo) => codigo.trim().toUpperCase()) ?? [];

  const result = await executor(customDb).query<AdicionalComPrecoRow>(
    `SELECT
       a.id,
       a.codigo,
       a.nome,
       a.descricao,
       a.categoria,
       a.unidade_cobranca,
       a.ordem_exibicao,
       a.ativo,
       pa.id AS preco_id,
       pa.tabela_preco_id,
       pa.convidados_min,
       pa.convidados_max,
       pa.valor,
       pa.observacoes AS preco_observacoes
     FROM adicionais a
     LEFT JOIN LATERAL (
       SELECT preco.*
       FROM precos_adicional preco
       WHERE preco.ativo = true
         AND preco.tabela_preco_id = $1::uuid
         AND preco.adicional_id = a.id
         AND preco.convidados_min <= $2::smallint
         AND (preco.convidados_max IS NULL OR preco.convidados_max >= $2::smallint)
       ORDER BY preco.convidados_min DESC
       LIMIT 1
     ) pa ON true
     WHERE a.ativo = true
       AND (
         cardinality($3::text[]) = 0
         OR a.codigo = ANY($3::text[])
       )
     ORDER BY a.categoria ASC, a.ordem_exibicao ASC, a.nome ASC`,
    [input.tabelaPrecoId, input.convidados, codigos],
  );

  return result.rows.map(mapAdicionalComPreco);
}

/**
 * Retorna todas as regras de desconto válidas para o pacote/data.
 * Regras específicas do turno vêm antes das genéricas (configuração nula),
 * respeitando também a prioridade configurada.
 */
export async function listarDescontosPacoteAplicaveis(
  input: BuscarRegraComercialInput,
  customDb?: DbExecutor,
): Promise<RegraDescontoPacoteRecord[]> {
  const result = await executor(customDb).query<RegraDescontoRow>(
    `SELECT
       id,
       pacote_id,
       dia_semana,
       configuracao_agenda_id,
       percentual,
       base_calculo,
       codigo,
       titulo,
       prioridade,
       vigencia_inicio::text AS vigencia_inicio,
       vigencia_fim::text AS vigencia_fim,
       observacoes
     FROM regras_desconto_pacote
     WHERE ativo = true
       AND pacote_id = $1::uuid
       AND dia_semana = EXTRACT(ISODOW FROM $2::date)::smallint
       AND (
         configuracao_agenda_id = $3::uuid
         OR configuracao_agenda_id IS NULL
       )
       AND vigencia_inicio <= $2::date
       AND (vigencia_fim IS NULL OR vigencia_fim >= $2::date)
     ORDER BY
       CASE WHEN configuracao_agenda_id = $3::uuid THEN 0 ELSE 1 END,
       prioridade ASC,
       vigencia_inicio DESC`,
    [input.pacoteId, input.data, input.configuracaoAgendaId],
  );

  return result.rows.map(mapRegraDesconto);
}
