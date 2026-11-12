import type { DbExecutor } from "../db/contracts.ts";
import { recursoIncluido } from "../assinatura/recursos-plano.ts";
import { pesquisaLigada } from "./http.ts";

/**
 * Escopo da pesquisa por unidade (PS-4, plano rev. 1 R2; D-PS8). SÓ predicados SQL: o protocolo de travas da conclusão
 * (tarefas.ts) continua o da PS-3 e não mora aqui.
 *
 *   Gestão (memberships.papel = REPRESENTANTE_AUTORIZADO, membership vigente): VER e TRATAR em todas as unidades da
 *   empresa e nas festas sem unidade.
 *   Equipe: VER e TRATAR são concessões SEPARADAS (D-PS4-2: TRATAR não dá VER, VER não dá TRATAR), por unidade, com o
 *   vínculo da unidade ATIVO, não revogado, vigente e com a foto (atualizado_em) igual à da concessão.
 *
 * A membership é SEMPRE relida dentro da instrução que decide (status, vigência e papel contra `agora.i`, um único
 * clock_timestamp() materializado): nenhum papel lido antes, em outra instrução, promove autoridade.
 */
export const GESTAO = "REPRESENTANTE_AUTORIZADO";
export type Capacidade = "SATISFACAO_VER" | "SATISFACAO_TRATAR";

/** Membership `m` vigente no instante `agora.i`. */
export const MEMBRO_VIGENTE = `m.status = 'ATIVA' AND m.vigente_desde <= agora.i AND (m.vigente_ate IS NULL OR m.vigente_ate > agora.i)`;

/** Concessão `c` da capacidade, com o vínculo `v`, vigente no instante `agora.i` (texto usado na leitura e na decisão). */
export function concessaoVigente(capacidade: Capacidade) {
  return `c.capacidade = '${capacidade}' AND c.revogada_em IS NULL
     AND v.membership_id = c.membership_id AND v.empresa_id = c.empresa_id AND v.estabelecimento_id = c.estabelecimento_id
     AND v.status = 'ATIVA' AND v.revogado_em IS NULL AND v.vigente_desde <= agora.i AND (v.vigente_ate IS NULL OR v.vigente_ate > agora.i)
     AND v.atualizado_em = c.vinculo_atualizado_em`;
}

/**
 * CTEs `membro`, `gestao`, `escopo_ver` e `escopo_tratar` (exigem a CTE `agora` antes). `empresa` é o parâmetro da
 * empresa comprovada; `quem` filtra a membership (`m.id = $n` pelo tenant, ou `m.usuario_id = $n` no menu).
 * Equipe: escopos com as unidades concedidas (nunca "sem unidade"). Gestão: escopos vazios aqui; quem consome usa
 * `gestao.sim` para "todas as unidades + sem unidade". Membership ausente, futura ou vencida: tudo vazio e `sim = false`.
 */
export function ctesEscopo(empresa: string, quem: string) {
  const escopo = (capacidade: Capacidade) => `SELECT DISTINCT c.estabelecimento_id AS unidade
    FROM membro, agora, satisfacao_capacidades c JOIN membership_estabelecimentos v ON v.id = c.vinculo_id
   WHERE NOT membro.gestao AND c.empresa_id = ${empresa} AND c.membership_id = membro.id AND ${concessaoVigente(capacidade)}`;
  return `membro AS (
  SELECT m.id, m.papel = '${GESTAO}' AS gestao FROM memberships m, agora
   WHERE m.empresa_id = ${empresa} AND ${quem} AND ${MEMBRO_VIGENTE}
),
gestao AS (SELECT coalesce(bool_or(gestao), false) AS sim FROM membro),
escopo_ver AS (${escopo("SATISFACAO_VER")}),
escopo_tratar AS (${escopo("SATISFACAO_TRATAR")})`;
}

export type MenuSatisfacao = { ver: boolean; tratar: boolean; retornosAbertos: number };

/**
 * Menu "Satisfação" (PS-4 R2/R9): UMA instrução com `agora` materializado relê a membership da empresa selecionada e as
 * concessões/vínculos. Devolve null (grupo oculto) sem flag, sem plano com MARKETING, sem nenhuma das duas permissões
 * ou em qualquer erro. `retornosAbertos` = abertas no escopo TRATAR, sem olhar VER. É indicativo: cada API revalida.
 */
export async function menuSatisfacao(db: DbExecutor, empresaId: string, usuarioId: string,
  opcoes: { instanteDecisao?: string } = {}): Promise<MenuSatisfacao | null> {
  try {
    if (!pesquisaLigada()) return null;
    if (!(await recursoIncluido(db, empresaId, "MARKETING").catch(() => false))) return null;
    const r = (await db.query<{ ver: boolean; tratar: boolean; abertas: string | number }>(
      `/* satisfacao:menu */
       WITH agora AS MATERIALIZED (SELECT COALESCE($3::timestamptz, clock_timestamp()) AS i),
       ${ctesEscopo("$1::uuid", "m.usuario_id = $2::uuid")}
       SELECT gestao.sim OR EXISTS (SELECT 1 FROM escopo_ver) AS ver,
              gestao.sim OR EXISTS (SELECT 1 FROM escopo_tratar) AS tratar,
              (SELECT count(*) FROM satisfacao_tarefas t
                WHERE t.empresa_id = $1::uuid AND t.estado = 'ABERTA'
                  AND (gestao.sim OR t.estabelecimento_id IN (SELECT unidade FROM escopo_tratar))) AS abertas
         FROM gestao`, [empresaId, usuarioId, opcoes.instanteDecisao ?? null])).rows[0];
    if (!r || (!r.ver && !r.tratar)) return null;
    return { ver: r.ver, tratar: r.tratar, retornosAbertos: r.tratar ? Number(r.abertas) : 0 };
  } catch {
    return null;
  }
}
