import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { EMPRESA_SAAS_DO_PERFIL } from '../perfil/autorizacao.ts';
import { exigirDesenvolvedorNaTransacao } from './autorizacao.ts';
import { sanitizarAuditoria } from './auditoria.ts';
import { painelDepsPadrao, type PainelDeps } from './interessadas.ts';

/**
 * Auditoria ADMINISTRATIVA consultável pelo painel do desenvolvedor: por empresa, ação e período, paginada.
 *
 * Só as origens administrativas da plataforma entram (painel, convites, recuperação, senha, ciclo de empresa e de
 * vínculo, Usuários e acessos da empresa, CLI de provisionamento e Perfil da empresa). Nenhuma origem operacional
 * (clientes, contratos, documentos, festas, pagamentos, IA) é consultável por aqui. Cada linha sai pela mesma
 * sanitização da escrita (sanitizarAuditoria): nunca senha, token, hash ou link.
 */
export const ORIGENS_ADMINISTRATIVAS = [
    'PAINEL_DESENVOLVEDOR', 'CONVITE_PUBLICO', 'RECUPERACAO_PUBLICA', 'PERFIL_SENHA', 'HG8_CICLO_EMPRESA', 'HG8_CICLO_MEMBERSHIP',
    'ADMIN_USUARIOS', 'CLI_PROVISIONAMENTO', 'PERFIL_EMPRESA',
] as const;
export const POR_PAGINA_AUDITORIA = 25;

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const filtrosSchema = z.object({
    empresaId: z.string().uuid().optional().nullable().transform((v) => (v ? v.toLowerCase() : null)),
    acao: z.string().regex(/^[A-Z0-9_]{1,80}$/).optional().nullable().transform((v) => v || null),
    de: data.optional().nullable().transform((v) => v || null),
    ate: data.optional().nullable().transform((v) => v || null),
    pagina: z.coerce.number().int().min(1).max(10000).optional().default(1),
}).strict();

export type RegistroAuditoria = {
    id: string; acao: string; origem: string; criadoEm: string; ator: string | null; atorId: string | null;
    empresaId: string | null; empresa: string | null; entidadeTipo: string; entidadeId: string; resultado: string | null;
    justificativa: string | null; antes: Record<string, unknown> | null; depois: Record<string, unknown> | null;
};

/** Empresa de cada registro: a entidade, o `empresaId` dos dados ou a empresa do vínculo/perfil referenciado. */
const EMPRESA_DO_REGISTRO = `COALESCE(
    CASE WHEN a.entidade_tipo = 'EMPRESA' THEN a.entidade_id END,
    CASE WHEN (a.dados_depois->>'empresaId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (a.dados_depois->>'empresaId')::uuid END,
    CASE WHEN a.entidade_tipo = 'MEMBERSHIP' THEN (SELECT m.empresa_id FROM memberships m WHERE m.id = a.entidade_id) END
  )`;

function filtroEmpresa(perfilInstalado: boolean) {
    // O id da empresa é sempre $1 nas consultas filtradas.
    const porPerfil = perfilInstalado
        ? ` OR (a.entidade_tipo = 'PERFIL_EMPRESA' AND a.entidade_id IN (SELECT p.id FROM public.perfil_empresas p JOIN LATERAL (${EMPRESA_SAAS_DO_PERFIL}) e ON e.candidatos = 1 WHERE e.id = $1::uuid))`
        : '';
    return `((a.entidade_tipo = 'EMPRESA' AND a.entidade_id = $1::uuid)
        OR (a.dados_depois->>'empresaId') = $1::text
        OR (a.entidade_tipo = 'MEMBERSHIP' AND a.entidade_id IN (SELECT id FROM memberships WHERE empresa_id = $1::uuid))${porPerfil})`;
}

export async function consultarAuditoria(sessao: SessaoAdmin, raw: unknown, deps: PainelDeps = painelDepsPadrao) {
    const f = filtrosSchema.parse(raw);
    if (f.de && f.ate && f.de > f.ate)
        return { itens: [] as RegistroAuditoria[], total: 0, pagina: f.pagina, porPagina: POR_PAGINA_AUDITORIA, acoes: [] as string[], empresas: [] as Array<{ id: string; nome: string }>, filtros: f };
    return deps.withTransaction(async (tx: DbExecutor) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const perfilInstalado = (await tx.query<{ t: string | null }>("SELECT to_regclass('public.perfil_empresas') AS t")).rows[0]?.t != null;
        const condicoes: string[] = ['a.origem = ANY($2::text[])'];
        const params: unknown[] = [f.empresaId, [...ORIGENS_ADMINISTRATIVAS]];
        // $1 (empresa) é sempre referenciado com tipo explícito, mesmo sem filtro (o PostgreSQL exige inferir o tipo).
        condicoes.push(f.empresaId ? filtroEmpresa(perfilInstalado) : '$1::uuid IS NULL');
        if (f.acao) {
            params.push(f.acao);
            condicoes.push(`a.acao = $${params.length}`);
        }
        if (f.de) {
            params.push(f.de);
            condicoes.push(`a.criado_em >= $${params.length}::date`);
        }
        if (f.ate) {
            params.push(f.ate);
            condicoes.push(`a.criado_em < ($${params.length}::date + interval '1 day')`);
        }
        const where = condicoes.join(' AND ');
        const total = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM auditoria a WHERE ${where}`, params)).rows[0]?.n ?? 0;
        params.push((f.pagina - 1) * POR_PAGINA_AUDITORIA);
        const linhas = (await tx.query<{
            id: string; acao: string; origem: string; criado_em: string; ator: string | null; ator_id: string | null; empresa_id: string | null; empresa: string | null;
            entidade_tipo: string; entidade_id: string; resultado: string | null; justificativa: string | null; dados_antes: Record<string, unknown> | null; dados_depois: Record<string, unknown> | null;
        }>(
            `SELECT a.id, a.acao, a.origem, a.criado_em::text, u.nome AS ator, a.usuario_id::text AS ator_id, emp.id::text AS empresa_id, emp.nome AS empresa,
                    a.entidade_tipo, a.entidade_id::text, a.dados_depois->>'resultado' AS resultado, a.justificativa, a.dados_antes, a.dados_depois
               FROM auditoria a
               LEFT JOIN usuarios_administrativos u ON u.id = a.usuario_id
               LEFT JOIN empresas emp ON emp.id = ${EMPRESA_DO_REGISTRO}
              WHERE ${where}
              ORDER BY a.criado_em DESC, a.id DESC LIMIT ${POR_PAGINA_AUDITORIA} OFFSET $${params.length}`, params)).rows;
        const acoes = (await tx.query<{ acao: string }>('SELECT DISTINCT acao FROM auditoria a WHERE a.origem = ANY($1::text[]) ORDER BY acao', [[...ORIGENS_ADMINISTRATIVAS]])).rows.map((r) => r.acao);
        const empresas = (await tx.query<{ id: string; nome: string }>('SELECT id::text AS id, nome FROM empresas ORDER BY nome, id LIMIT 500')).rows;
        const itens: RegistroAuditoria[] = linhas.map((l) => ({
            id: l.id, acao: l.acao, origem: l.origem, criadoEm: l.criado_em, ator: l.ator, atorId: l.ator_id, empresaId: l.empresa_id, empresa: l.empresa,
            entidadeTipo: l.entidade_tipo, entidadeId: l.entidade_id, resultado: l.resultado, justificativa: l.justificativa,
            antes: l.dados_antes ? sanitizarAuditoria(l.dados_antes) as Record<string, unknown> : null,
            depois: l.dados_depois ? sanitizarAuditoria(l.dados_depois) as Record<string, unknown> : null,
        }));
        return { itens, total, pagina: f.pagina, porPagina: POR_PAGINA_AUDITORIA, acoes, empresas, filtros: f };
    });
}
