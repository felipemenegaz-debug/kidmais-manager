import type { DbExecutor } from '../db/contracts';

/**
 * A migration 026 não está aplicada nos ambientes.
 * `to_regclass` nulo significa estrutura ausente: o acesso ao perfil fica fechado
 * e os fluxos de usuário seguem. Qualquer outro erro desta consulta propaga.
 * Um 42P01 posterior não é convertido em "estrutura ausente".
 */
export async function estruturaPerfilInstalada(tx: DbExecutor) {
    const result = await tx.query<{ empresas: string | null; concessoes: string | null }>(
        `SELECT to_regclass('public.perfil_empresas') AS empresas, to_regclass('public.perfil_empresa_concessoes') AS concessoes`,
    );
    const row = result.rows[0];
    if (!row)
        throw new Error('Consulta da estrutura do perfil não retornou linha.');
    return row.empresas != null && row.concessoes != null;
}
