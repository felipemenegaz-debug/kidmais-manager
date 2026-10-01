import type { DbExecutor } from "../db/contracts.ts";
import type { RepositorioSkills } from "../inteligencia/skills/catalogo.ts";

/**
 * Skills de empresa/unidade em PostgreSQL (`ia_skills`, migration 058 — NÃO aplicada). Somente leitura.
 *
 * Devolve as versões ATIVAS da empresa comprovada (camada EMPRESA e das suas unidades). O catálogo da IA revalida
 * cada definição (schema, hash, revisão, varredura de conteúdo, base da plataforma, escopo e unidade comprovada):
 * o banco não é autoridade de conteúdo. Sem a tabela ⇒ lista vazia (a IA segue só com a plataforma).
 */
export function criarRepositorioSkillsPostgres(banco: { executor(): DbExecutor }): RepositorioSkills {
  let existe: { valor: boolean; em: number } | null = null;
  async function tabelaExiste(db: DbExecutor) {
    const agora = Date.now();
    if (existe && agora - existe.em < 60_000) return existe.valor;
    const r = await db.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_skills') IS NOT NULL AS ok`);
    existe = { valor: r.rows[0]?.ok === true, em: agora };
    return existe.valor;
  }
  return {
    async listar(empresaId) {
      const db = banco.executor();
      if (!await tabelaExiste(db)) return [];
      const r = await db.query<{ definicao: unknown }>(
        `SELECT definicao
           FROM ia_skills
          WHERE empresa_id = $1::uuid AND status = 'ATIVA'
          ORDER BY nivel, skill_id, versao
          LIMIT 200`,
        [empresaId],
      );
      return r.rows.map((l) => l.definicao);
    },
  };
}
