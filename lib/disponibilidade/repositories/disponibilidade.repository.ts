import type { DbExecutor } from "../../db/contracts.ts";
import { db, withTransaction } from "../../db/postgres.ts";
import { agendaPorEscopoInstalada, type EscopoAgenda } from "../escopo.ts";
import { AvailabilityServiceError } from "../services/errors.ts";
import type {
  AlcanceBloqueio,
  BloqueioAgendaRecord,
  ConfiguracaoAgendaRecord,
  CriarBloqueioAgendaInput,
  OcupacaoConfirmadaRecord,
} from "./models.ts";

// Escopo (062): toda função abaixo aceita um EscopoAgenda opcional. Sem a 062 instalada as consultas são as
// anteriores (agenda global) e o escopo é ignorado; com a 062, a comparação passa a ser por recurso
// (kidmais062_mesmo_recurso / kidmais062_bloqueio_aplica), com as mesmas regras dos gatilhos do banco.
// Escopo ausente = global = conservador (nunca libera horário que outro recurso ocupa).

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
  empresa_id?: string | null;
  estabelecimento_id?: string | null;
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

function alcance(row: BloqueioAgendaRow): AlcanceBloqueio {
  if (row.estabelecimento_id) return "UNIDADE";
  return row.empresa_id ? "EMPRESA" : "GLOBAL";
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
    empresaId: row.empresa_id ?? null,
    estabelecimentoId: row.estabelecimento_id ?? null,
    alcance: alcance(row),
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
const bloqueioColumns062 = `${bloqueioColumns}, empresa_id::text AS empresa_id, estabelecimento_id::text AS estabelecimento_id`;

const configuracaoColumns = `
       id,
       codigo,
       nome,
       horario_inicio_padrao::text AS horario_inicio_padrao,
       horario_fim_padrao::text AS horario_fim_padrao,
       tolerancia_inicio_minutos,
       passo_inicio_minutos,
       ordem_exibicao,
       ativo`;

const parametrosEscopo = (escopo?: EscopoAgenda) => [escopo?.empresaId ?? null, escopo?.estabelecimentoId ?? null];

/**
 * Turnos ativos do escopo (D5): os da unidade; se ela não tiver, os da empresa; se nem a empresa tiver, os modelos
 * globais (todas as linhas anteriores à 062, preservando os horários já contratados). Os níveis não se misturam.
 */
export async function listarConfiguracoesAgendaAtivas(
  customDb?: DbExecutor,
  escopo?: EscopoAgenda,
): Promise<ConfiguracaoAgendaRecord[]> {
  const ex = executor(customDb);
  if (!(await agendaPorEscopoInstalada(ex))) {
    const result = await ex.query<ConfiguracaoAgendaRow>(
      `SELECT ${configuracaoColumns}
     FROM configuracao_agenda
     WHERE ativo = true
     ORDER BY ordem_exibicao ASC, codigo ASC`,
    );
    return result.rows.map(mapConfiguracao);
  }
  const result = await ex.query<ConfiguracaoAgendaRow>(
    `WITH candidatas AS (
       SELECT ${configuracaoColumns},
              CASE WHEN estabelecimento_id IS NOT NULL THEN 2 WHEN empresa_id IS NOT NULL THEN 1 ELSE 0 END AS nivel
         FROM configuracao_agenda
        WHERE ativo = true
          AND (empresa_id IS NULL
               OR (empresa_id = $1::uuid AND (estabelecimento_id IS NULL OR estabelecimento_id = $2::uuid)))
     )
     SELECT id, codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos,
            passo_inicio_minutos, ordem_exibicao, ativo
       FROM candidatas
      WHERE nivel = (SELECT max(nivel) FROM candidatas)
      ORDER BY ordem_exibicao ASC, codigo ASC`,
    parametrosEscopo(escopo),
  );
  return result.rows.map(mapConfiguracao);
}

export async function listarBloqueiosAtivosPorPeriodo(
  inicio: string,
  fim: string,
  customDb?: DbExecutor,
  escopo?: EscopoAgenda,
): Promise<BloqueioAgendaRecord[]> {
  const ex = executor(customDb);
  const v062 = await agendaPorEscopoInstalada(ex);
  const result = await ex.query<BloqueioAgendaRow>(
    `SELECT ${v062 ? bloqueioColumns062 : bloqueioColumns}
       FROM bloqueios_agenda
      WHERE ativo = true
        AND data BETWEEN $1::date AND $2::date
        ${v062 ? "AND kidmais062_bloqueio_aplica(empresa_id, estabelecimento_id, $3::uuid, $4::uuid)" : ""}
      ORDER BY data ASC, dia_inteiro DESC, horario_inicio ASC NULLS FIRST, criado_em ASC`,
    v062 ? [inicio, fim, ...parametrosEscopo(escopo)] : [inicio, fim],
  );

  return result.rows.map(mapBloqueio);
}

export async function listarTodosBloqueiosAtivos(
  customDb?: DbExecutor,
  escopo?: EscopoAgenda,
): Promise<BloqueioAgendaRecord[]> {
  const ex = executor(customDb);
  const v062 = await agendaPorEscopoInstalada(ex);
  const result = await ex.query<BloqueioAgendaRow>(
    `SELECT ${v062 ? bloqueioColumns062 : bloqueioColumns}
       FROM bloqueios_agenda
      WHERE ativo = true
        ${v062 ? "AND kidmais062_bloqueio_aplica(empresa_id, estabelecimento_id, $1::uuid, $2::uuid)" : ""}
      ORDER BY data ASC, dia_inteiro DESC, horario_inicio ASC NULLS FIRST, criado_em ASC`,
    v062 ? parametrosEscopo(escopo) : [],
  );

  return result.rows.map(mapBloqueio);
}

/**
 * Sem a 062 o bloqueio continua global (como sempre foi) e entra no levantamento D3 depois da migration; com a 062,
 * nasce com a empresa (e a unidade, se houver) do escopo comprovado.
 */
export async function criarBloqueioAgenda(
  input: CriarBloqueioAgendaInput,
  customDb?: DbExecutor,
): Promise<BloqueioAgendaRecord> {
  if (!customDb) return withTransaction((tx) => criarBloqueioAgenda(input, tx));
  // Bloqueios administrativos participam da mesma serialização das reservas.
  await adquirirLockConfirmacaoAgenda(input.data, customDb);
  const comEscopo = Boolean(input.empresaId) && (await agendaPorEscopoInstalada(customDb));
  const result = await executor(customDb).query<BloqueioAgendaRow>(
    `INSERT INTO bloqueios_agenda (
       data,
       dia_inteiro,
       horario_inicio,
       horario_fim,
       motivo,
       observacoes,
       criado_por_usuario_id${comEscopo ? ",\n       empresa_id,\n       estabelecimento_id" : ""}
     ) VALUES (
       $1::date,
       $2,
       $3::time,
       $4::time,
       $5,
       $6,
       $7::uuid${comEscopo ? ",\n       $8::uuid,\n       $9::uuid" : ""}
     )
     RETURNING ${comEscopo ? bloqueioColumns062 : bloqueioColumns}`,
    [
      input.data,
      input.diaInteiro ?? false,
      input.horarioInicio ?? null,
      input.horarioFim ?? null,
      input.motivo.trim(),
      input.observacoes?.trim() || null,
      input.usuarioId ?? null,
      ...(comEscopo ? [input.empresaId, input.estabelecimentoId ?? null] : []),
    ],
  );

  return mapBloqueio(result.rows[0]);
}

/** Com a 062 e escopo de empresa, só desativa bloqueios exatamente do mesmo escopo (nunca os globais/de outra). */
export async function desativarBloqueiosExatos(
  input: {
    data: string;
    horarioInicio: string;
    horarioFim: string;
  },
  customDb?: DbExecutor,
  escopo?: EscopoAgenda,
): Promise<number> {
  if (!customDb) return withTransaction(tx => desativarBloqueiosExatos(input, tx, escopo));
  const doEscopo = Boolean(escopo?.empresaId) && (await agendaPorEscopoInstalada(customDb));
  const filtro = doEscopo ? " AND empresa_id = $4::uuid AND estabelecimento_id IS NOT DISTINCT FROM $5::uuid" : "";
  const params = doEscopo
    ? [input.data, input.horarioInicio, input.horarioFim, escopo!.empresaId, escopo!.estabelecimentoId ?? null]
    : [input.data, input.horarioInicio, input.horarioFim];
  await customDb.query(`SELECT id FROM bloqueios_agenda WHERE ativo AND NOT dia_inteiro AND data=$1 AND horario_inicio=$2 AND horario_fim=$3${filtro} ORDER BY id FOR UPDATE`, params);
  await adquirirLockConfirmacaoAgenda(input.data, customDb);
  const result = await executor(customDb).query(
    `UPDATE bloqueios_agenda
        SET ativo = false
      WHERE ativo = true
        AND dia_inteiro = false
        AND data = $1::date
        AND horario_inicio = $2::time
        AND horario_fim = $3::time${filtro}`,
    params,
  );

  return result.rowCount ?? 0;
}

/**
 * Com a 062 e escopo de empresa: bloqueio de outra empresa = não encontrado (sem vazar existência); bloqueio global
 * anterior à 062 = recusado até a resolução explícita de dono (D3), porque desativá-lo liberaria todas as empresas.
 */
export async function desativarBloqueioAgendaPorId(
  bloqueioId: string,
  customDb?: DbExecutor,
  escopo?: EscopoAgenda,
): Promise<boolean> {
  if (!customDb) return withTransaction(tx => desativarBloqueioAgendaPorId(bloqueioId, tx, escopo));
  const doEscopo = Boolean(escopo?.empresaId) && (await agendaPorEscopoInstalada(customDb));
  const current = (await customDb.query<{ data: string; empresa_id?: string | null }>(
    doEscopo
      ? 'SELECT data::text, empresa_id::text FROM bloqueios_agenda WHERE id=$1 FOR UPDATE'
      : 'SELECT data::text FROM bloqueios_agenda WHERE id=$1 FOR UPDATE',
    [bloqueioId],
  )).rows[0];
  if (!current) return false;
  if (doEscopo) {
    if (current.empresa_id == null) {
      throw new AvailabilityServiceError(
        "BLOQUEIO_SEM_DONO",
        "Este bloqueio é anterior à separação da agenda por empresa e vale para todas. Ele só pode ser alterado depois da atribuição do dono.",
        409,
      );
    }
    if (current.empresa_id !== escopo!.empresaId) return false;
  }
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

/** Duplicidade no MESMO escopo (com a 062); sem a 062, em toda a agenda, como antes. */
export async function existeBloqueioAgendaAtivoExato(
  input: {
    data: string;
    diaInteiro: boolean;
    horarioInicio?: string | null;
    horarioFim?: string | null;
  },
  customDb?: DbExecutor,
  escopo?: EscopoAgenda,
): Promise<boolean> {
  const ex = executor(customDb);
  const v062 = await agendaPorEscopoInstalada(ex);
  const result = await ex.query<{ existe: boolean }>(
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
          ${v062 ? "AND empresa_id IS NOT DISTINCT FROM $5::uuid AND estabelecimento_id IS NOT DISTINCT FROM $6::uuid" : ""}
     ) AS existe`,
    [
      input.data,
      input.diaInteiro,
      input.horarioInicio ?? null,
      input.horarioFim ?? null,
      ...(v062 ? parametrosEscopo(escopo) : []),
    ],
  );

  return result.rows[0]?.existe === true;
}

export async function listarFechamentosConfirmadosPorPeriodo(
  inicio: string,
  fim: string,
  customDb?: DbExecutor,
  escopo?: EscopoAgenda,
): Promise<OcupacaoConfirmadaRecord[]> {
  const ex = executor(customDb);
  const v062 = await agendaPorEscopoInstalada(ex);
  const result = await ex.query<{
    fechamento_id: string;
    data: string;
    horario_inicio: string;
    horario_fim: string;
  }>(
    v062
      ? `SELECT
       fechamento_id,
       data::text AS data,
       horario_inicio::text AS horario_inicio,
       horario_fim::text AS horario_fim
     FROM kidmais062_ocupacoes_escopo($1::date,$2::date) o
     WHERE kidmais062_mesmo_recurso($3::uuid, $4::uuid, o.empresa_id, o.estabelecimento_id)
     ORDER BY data ASC, horario_inicio ASC`
      : `SELECT
       fechamento_id,
       data::text AS data,
       horario_inicio::text AS horario_inicio,
       horario_fim::text AS horario_fim
     FROM kidmais_ocupacoes_operacionais($1::date,$2::date)
     ORDER BY data ASC, horario_inicio ASC`,
    v062 ? [inicio, fim, ...parametrosEscopo(escopo)] : [inicio, fim],
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
 * A 062 mantém o namespace por data (mais grosso que o recurso): serializa empresas diferentes na mesma data, o que
 * só custa espera e vale para qualquer combinação de código e schema.
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

/**
 * Conflito para confirmar a contratação. Com a 062 o escopo vem da PRÓPRIA contratação no banco (nunca do
 * chamador); contratação não encontrada = escopo global (conservador).
 */
export async function verificarConflitoAgendaParaConfirmacao(
  input: {
    fechamentoId: string;
    data: string;
    horarioInicio: string;
    horarioFim: string;
  },
  customDb: DbExecutor,
): Promise<{ bloqueioAgenda: boolean; fechamentoConfirmado: boolean }> {
  const ex = executor(customDb);
  const v062 = await agendaPorEscopoInstalada(ex);
  const result = await ex.query<{
    bloqueio_agenda: boolean;
    fechamento_confirmado: boolean;
  }>(
    v062
      ? `WITH alvo AS (
         SELECT (SELECT empresa_id FROM fechamentos WHERE id = $1::uuid) AS e,
                (SELECT estabelecimento_id FROM fechamentos WHERE id = $1::uuid) AS u
       )
       SELECT
       EXISTS (
         SELECT 1
           FROM bloqueios_agenda b, alvo
          WHERE b.ativo = true
            AND b.data = $2::date
            AND kidmais062_bloqueio_aplica(b.empresa_id, b.estabelecimento_id, alvo.e, alvo.u)
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
           FROM kidmais062_ocupacoes_escopo($2::date,$2::date) f, alvo
          WHERE f.fechamento_id <> $1::uuid
            AND f.horario_inicio < $4::time
            AND f.horario_fim > $3::time
            AND kidmais062_mesmo_recurso(alvo.e, alvo.u, f.empresa_id, f.estabelecimento_id)
       ) AS fechamento_confirmado`
      : `SELECT
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
