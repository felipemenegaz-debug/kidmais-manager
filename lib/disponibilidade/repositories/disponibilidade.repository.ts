import type { DbExecutor } from "../../db/contracts";
import { db, withTransaction } from "../../db/postgres";
import type {
  BloqueioAgendaRecord,
  ConfiguracaoAgendaRecord,
  CriarBloqueioAgendaInput,
} from "./models";

type ConfiguracaoAgendaRow = {
  id: string;
  codigo: string;
  nome: string;
  horario_inicio_padrao: string;
  horario_fim_padrao: string;
  tolerancia_inicio_minutos: number;
  passo_inicio_minutos: number;
  ordem_exibicao: number;
  ativo: boolean;
};

type BloqueioAgendaRow = {
  id: string;
  data: string;
  dia_inteiro: boolean;
  horario_inicio: string | null;
  horario_fim: string | null;
  motivo: string;
  observacoes: string | null;
  criado_por_usuario_id: string | null;
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
};

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

function mapConfiguracao(row: ConfiguracaoAgendaRow): ConfiguracaoAgendaRecord {
  return {
    id: row.id,
    codigo: row.codigo,
    nome: row.nome,
    horarioInicioPadrao: row.horario_inicio_padrao,
    horarioFimPadrao: row.horario_fim_padrao,
    toleranciaInicioMinutos: Number(row.tolerancia_inicio_minutos),
    passoInicioMinutos: Number(row.passo_inicio_minutos),
    ordemExibicao: Number(row.ordem_exibicao),
    ativo: row.ativo,
  };
}

function mapBloqueio(row: BloqueioAgendaRow): BloqueioAgendaRecord {
  return {
    id: row.id,
    data: row.data,
    diaInteiro: row.dia_inteiro,
    horarioInicio: row.horario_inicio,
    horarioFim: row.horario_fim,
    motivo: row.motivo,
    observacoes: row.observacoes,
    criadoPorUsuarioId: row.criado_por_usuario_id,
    ativo: row.ativo,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

const bloqueioColumns = `
  id,
  data::text AS data,
  dia_inteiro,
  horario_inicio::text AS horario_inicio,
  horario_fim::text AS horario_fim,
  motivo,
  observacoes,
  criado_por_usuario_id,
  ativo,
  criado_em::text AS criado_em,
  atualizado_em::text AS atualizado_em
`;

export async function listarConfiguracoesAgendaAtivas(
  customDb?: DbExecutor,
): Promise<ConfiguracaoAgendaRecord[]> {
  const result = await executor(customDb).query<ConfiguracaoAgendaRow>(
    `SELECT
       id,
       codigo,
       nome,
       horario_inicio_padrao::text AS horario_inicio_padrao,
       horario_fim_padrao::text AS horario_fim_padrao,
       tolerancia_inicio_minutos,
       passo_inicio_minutos,
       ordem_exibicao,
       ativo
     FROM configuracao_agenda
     WHERE ativo = true
     ORDER BY ordem_exibicao ASC, codigo ASC`,
  );

  return result.rows.map(mapConfiguracao);
}

export async function listarBloqueiosAtivosPorPeriodo(
  inicio: string,
  fim: string,
  customDb?: DbExecutor,
): Promise<BloqueioAgendaRecord[]> {
  const result = await executor(customDb).query<BloqueioAgendaRow>(
    `SELECT ${bloqueioColumns}
       FROM bloqueios_agenda
      WHERE ativo = true
        AND data BETWEEN $1::date AND $2::date
      ORDER BY data ASC, dia_inteiro DESC, horario_inicio ASC NULLS FIRST, criado_em ASC`,
    [inicio, fim],
  );

  return result.rows.map(mapBloqueio);
}

export async function listarTodosBloqueiosAtivos(
  customDb?: DbExecutor,
): Promise<BloqueioAgendaRecord[]> {
  const result = await executor(customDb).query<BloqueioAgendaRow>(
    `SELECT ${bloqueioColumns}
       FROM bloqueios_agenda
      WHERE ativo = true
      ORDER BY data ASC, dia_inteiro DESC, horario_inicio ASC NULLS FIRST, criado_em ASC`,
  );

  return result.rows.map(mapBloqueio);
}

export async function criarBloqueioAgenda(
  input: CriarBloqueioAgendaInput,
  customDb?: DbExecutor,
): Promise<BloqueioAgendaRecord> {
  if (!customDb) return withTransaction((tx) => criarBloqueioAgenda(input, tx));
  // Bloqueios administrativos participam da mesma serialização das reservas.
  await adquirirLockConfirmacaoAgenda(input.data, customDb);
  const result = await executor(customDb).query<BloqueioAgendaRow>(
    `INSERT INTO bloqueios_agenda (
       data,
       dia_inteiro,
       horario_inicio,
       horario_fim,
       motivo,
       observacoes,
       criado_por_usuario_id
     ) VALUES (
       $1::date,
       $2,
       $3::time,
       $4::time,
       $5,
       $6,
       $7::uuid
     )
     RETURNING ${bloqueioColumns}`,
    [
      input.data,
      input.diaInteiro ?? false,
      input.horarioInicio ?? null,
      input.horarioFim ?? null,
      input.motivo.trim(),
      input.observacoes?.trim() || null,
      input.usuarioId ?? null,
    ],
  );

  return mapBloqueio(result.rows[0]);
}

export async function desativarBloqueiosExatos(
  input: {
    data: string;
    horarioInicio: string;
    horarioFim: string;
  },
  customDb?: DbExecutor,
): Promise<number> {
  if (!customDb) return withTransaction(tx => desativarBloqueiosExatos(input, tx));
  await customDb.query('SELECT id FROM bloqueios_agenda WHERE ativo AND NOT dia_inteiro AND data=$1 AND horario_inicio=$2 AND horario_fim=$3 ORDER BY id FOR UPDATE',[input.data,input.horarioInicio,input.horarioFim]);
  await adquirirLockConfirmacaoAgenda(input.data, customDb);
  const result = await executor(customDb).query(
    `UPDATE bloqueios_agenda
        SET ativo = false
      WHERE ativo = true
        AND dia_inteiro = false
        AND data = $1::date
        AND horario_inicio = $2::time
        AND horario_fim = $3::time`,
    [input.data, input.horarioInicio, input.horarioFim],
  );

  return result.rowCount ?? 0;
}

export async function desativarBloqueioAgendaPorId(
  bloqueioId: string,
  customDb?: DbExecutor,
): Promise<boolean> {
  if (!customDb) return withTransaction(tx => desativarBloqueioAgendaPorId(bloqueioId, tx));
  const current = (await customDb.query<{data:string}>(
    'SELECT data::text FROM bloqueios_agenda WHERE id=$1 FOR UPDATE', [bloqueioId],
  )).rows[0];
  if (!current) return false;
  await adquirirLockConfirmacaoAgenda(current.data, customDb);
  const result = await executor(customDb).query(
    `UPDATE bloqueios_agenda
        SET ativo = false
      WHERE id = $1::uuid
        AND ativo = true`,
    [bloqueioId],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function existeBloqueioAgendaAtivoExato(
  input: {
    data: string;
    diaInteiro: boolean;
    horarioInicio?: string | null;
    horarioFim?: string | null;
  },
  customDb?: DbExecutor,
): Promise<boolean> {
  const result = await executor(customDb).query<{ existe: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM bloqueios_agenda
        WHERE ativo = true
          AND data = $1::date
          AND dia_inteiro = $2
          AND (
            ($2 = true AND horario_inicio IS NULL AND horario_fim IS NULL)
            OR
            ($2 = false AND horario_inicio = $3::time AND horario_fim = $4::time)
          )
     ) AS existe`,
    [
      input.data,
      input.diaInteiro,
      input.horarioInicio ?? null,
      input.horarioFim ?? null,
    ],
  );

  return result.rows[0]?.existe === true;
}

export async function listarFechamentosConfirmadosPorPeriodo(
  inicio: string,
  fim: string,
  customDb?: DbExecutor,
): Promise<import("./models").OcupacaoConfirmadaRecord[]> {
  const result = await executor(customDb).query<{
    fechamento_id: string;
    data: string;
    horario_inicio: string;
    horario_fim: string;
  }>(
    `SELECT
       fechamento_id,
       data::text AS data,
       horario_inicio::text AS horario_inicio,
       horario_fim::text AS horario_fim
     FROM kidmais_ocupacoes_operacionais($1::date,$2::date)
     ORDER BY data ASC, horario_inicio ASC`,
    [inicio, fim],
  );

  return result.rows.map((row) => ({
    fechamentoId: row.fechamento_id,
    data: row.data,
    horarioInicio: row.horario_inicio,
    horarioFim: row.horario_fim,
  }));
}

/**
 * Serializa a confirmação de reserva por data dentro da transação corrente.
 * O lock é transacional e desaparece automaticamente em COMMIT/ROLLBACK.
 */
export async function adquirirLockConfirmacaoAgenda(
  data: string,
  customDb: DbExecutor,
): Promise<void> {
  await executor(customDb).query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('kidmais:agenda:' || $1::text, 0)
     )`,
    [data],
  );
}

export async function verificarConflitoAgendaParaConfirmacao(
  input: {
    fechamentoId: string;
    data: string;
    horarioInicio: string;
    horarioFim: string;
  },
  customDb: DbExecutor,
): Promise<{ bloqueioAgenda: boolean; fechamentoConfirmado: boolean }> {
  const result = await executor(customDb).query<{
    bloqueio_agenda: boolean;
    fechamento_confirmado: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1
           FROM bloqueios_agenda b
          WHERE b.ativo = true
            AND b.data = $2::date
            AND (
              b.dia_inteiro = true
              OR b.horario_inicio IS NULL
              OR b.horario_fim IS NULL
              OR (
                b.horario_inicio < $4::time
                AND b.horario_fim > $3::time
              )
            )
       ) AS bloqueio_agenda,
       EXISTS (
         SELECT 1
           FROM kidmais_ocupacoes_operacionais($2::date,$2::date) f
          WHERE f.fechamento_id <> $1::uuid
            AND f.horario_inicio < $4::time
            AND f.horario_fim > $3::time
       ) AS fechamento_confirmado`,
    [input.fechamentoId, input.data, input.horarioInicio, input.horarioFim],
  );

  return {
    bloqueioAgenda: result.rows[0]?.bloqueio_agenda === true,
    fechamentoConfirmado: result.rows[0]?.fechamento_confirmado === true,
  };
}
