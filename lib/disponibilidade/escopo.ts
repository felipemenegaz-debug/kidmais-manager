import type { DbExecutor } from "../db/contracts.ts";
import { AvailabilityServiceError } from "./services/errors.ts";

/**
 * Recurso de agenda (062, D1): cada unidade é um recurso exclusivo. `null` mantém o alcance anterior à 062:
 * sem empresa = toda a agenda (global); com empresa e sem unidade = todas as unidades da empresa. Escopo ausente é
 * sempre CONSERVADOR (enxerga mais ocupações, nunca menos); a palavra final é dos gatilhos do banco.
 */
export type EscopoAgenda = { empresaId: string | null; estabelecimentoId: string | null };

export const ESCOPO_GLOBAL: EscopoAgenda = Object.freeze({ empresaId: null, estabelecimentoId: null });

export type UnidadeAgenda = { id: string; codigo: string; nome: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A 062 está instalada? Lido do catálogo a cada consulta (sem cache): o mesmo código roda antes e depois da
 * migration, e nada muda de alcance enquanto ela não estiver aplicada.
 */
export async function agendaPorEscopoInstalada(db: DbExecutor): Promise<boolean> {
  const r = await db.query<{ instalada: boolean }>(
    "SELECT to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL AS instalada",
  );
  return r.rows[0]?.instalada === true;
}

/**
 * Unidades ELEGÍVEIS para agenda (D6): regra única no banco, kidmais062_unidade_agendavel. Hoje só ATIVO, que a 043
 * ainda não permite (toda unidade nasce e fica SUSPENSO, sem distinguir suspensão administrativa): lista vazia e
 * agenda separada por empresa. Só chamada com a 062 instalada.
 */
export async function unidadesDaEmpresa(db: DbExecutor, empresaId: string): Promise<UnidadeAgenda[]> {
  const r = await db.query<UnidadeAgenda>(
    `SELECT id::text AS id, codigo, nome FROM public.estabelecimentos
      WHERE empresa_id = $1::uuid AND public.kidmais062_unidade_agendavel(empresa_id, id) ORDER BY nome, id`,
    [empresaId],
  );
  return r.rows;
}

/**
 * Escopo da empresa COMPROVADA (Tenant Context). Unidade pedida precisa ser dela e não desativada; sem unidade:
 * a única, se houver só uma; senão a empresa inteira (consulta) ou recusa (gravação com `exigirUnidade`).
 * Sem a 062 a unidade é ignorada: não há onde gravá-la e a agenda continua global.
 */
export async function escopoDaEmpresa(
  db: DbExecutor,
  empresaId: string,
  estabelecimentoId?: string | null,
  opcoes: { exigirUnidade?: boolean } = {},
): Promise<EscopoAgenda> {
  if (!(await agendaPorEscopoInstalada(db))) return { empresaId, estabelecimentoId: null };
  const unidades = await unidadesDaEmpresa(db, empresaId);
  if (estabelecimentoId) {
    if (!unidades.some((u) => u.id === estabelecimentoId)) {
      throw new AvailabilityServiceError("UNIDADE_INVALIDA", "Escolha uma unidade ativa desta empresa.", 409);
    }
    return { empresaId, estabelecimentoId };
  }
  if (unidades.length === 1) return { empresaId, estabelecimentoId: unidades[0].id };
  if (unidades.length > 1 && opcoes.exigirUnidade) {
    throw new AvailabilityServiceError("UNIDADE_OBRIGATORIA", "Escolha a unidade da festa.", 409);
  }
  return { empresaId, estabelecimentoId: null };
}

/** Escopo gravado na contratação (a remarcação herda a unidade). Sem a 062: global, como antes. */
export async function escopoDoFechamento(db: DbExecutor, fechamentoId: string): Promise<EscopoAgenda> {
  if (!(await agendaPorEscopoInstalada(db))) return ESCOPO_GLOBAL;
  const r = await db.query<{ empresa_id: string | null; estabelecimento_id: string | null }>(
    "SELECT empresa_id::text, estabelecimento_id::text FROM public.fechamentos WHERE id = $1::uuid",
    [fechamentoId],
  );
  const f = r.rows[0];
  return f ? { empresaId: f.empresa_id, estabelecimentoId: f.estabelecimento_id } : ESCOPO_GLOBAL;
}

export type AmbienteAgendaPublica = { AGENDA_PUBLICA_EMPRESA_ID?: string; AGENDA_PUBLICA_UNIDADE_ID?: string };

/**
 * Contexto da agenda pública (D4): SOMENTE configuração do servidor; nenhum identificador vindo do navegador é lido
 * aqui. Com a 062 instalada, a consulta pública exige empresa ATIVA configurada (e, se configurada, unidade elegível):
 * sem contexto ou com contexto inválido ela fica INDISPONÍVEL (503) — nunca cai na agenda de todas as empresas.
 * Sem a 062 a agenda inteira ainda é global e nada muda em relação ao comportamento anterior.
 */
export async function escopoPublico(
  conexao: () => DbExecutor,
  env: AmbienteAgendaPublica = process.env as AmbienteAgendaPublica,
): Promise<EscopoAgenda> {
  const empresaId = env.AGENDA_PUBLICA_EMPRESA_ID?.trim() || null;
  const unidadeId = env.AGENDA_PUBLICA_UNIDADE_ID?.trim() || null;
  const malConfigurada = () =>
    new AvailabilityServiceError("AGENDA_PUBLICA_INDISPONIVEL", "A agenda pública está indisponível no momento.", 503);
  if ((!empresaId && unidadeId) || (empresaId && !UUID.test(empresaId)) || (unidadeId && !UUID.test(unidadeId))) throw malConfigurada();
  const db = conexao();
  if (!(await agendaPorEscopoInstalada(db))) return ESCOPO_GLOBAL;
  if (!empresaId) {
    throw new AvailabilityServiceError(
      "AGENDA_PUBLICA_NAO_CONFIGURADA",
      "A consulta pública de datas está indisponível. Fale com a equipe para verificar a disponibilidade.",
      503,
    );
  }
  const ativa = await db.query<{ ok: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM public.empresas WHERE id = $1::uuid AND status = 'ATIVA') AS ok",
    [empresaId],
  );
  if (ativa.rows[0]?.ok !== true) throw malConfigurada();
  try {
    return await escopoDaEmpresa(db, empresaId, unidadeId);
  } catch {
    throw malConfigurada();
  }
}

/** Mesmo recurso (espelho de kidmais062_mesmo_recurso, para testes e montagem de tela). */
export function mesmoRecurso(a: EscopoAgenda, b: EscopoAgenda): boolean {
  return (a.empresaId === null || b.empresaId === null || a.empresaId === b.empresaId)
    && (a.estabelecimentoId === null || b.estabelecimentoId === null || a.estabelecimentoId === b.estabelecimentoId);
}

/** Bloqueio alcança o escopo? (espelho de kidmais062_bloqueio_aplica). */
export function bloqueioAplica(bloqueio: EscopoAgenda, alvo: EscopoAgenda): boolean {
  return bloqueio.empresaId === null || alvo.empresaId === null
    || (bloqueio.empresaId === alvo.empresaId
      && (bloqueio.estabelecimentoId === null || alvo.estabelecimentoId === null || bloqueio.estabelecimentoId === alvo.estabelecimentoId));
}
