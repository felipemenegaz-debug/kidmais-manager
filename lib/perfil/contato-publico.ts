import type { DbExecutor } from '../db/contracts.ts';
import { contatoPublicoDe, type ContatoPublico } from '../fechamentos/marca-publica.ts';
import { estruturaPerfilInstalada } from './estrutura.ts';
import { perfilDoTenantOuNulo } from './tenant.ts';

/**
 * Contatos exibidos no endereço público da empresa: os do cadastro APLICADO da unidade dela (nunca o rascunho).
 * Sem perfil, perfil ambíguo, mais de uma unidade, estrutura ausente ou erro → null: a tela fica sem contato,
 * nunca com o de outra empresa. Só leitura; como o nome comercial, é o que o próprio buffet publica aos clientes.
 */
export async function contatoPublicoDaEmpresa(tx: DbExecutor, empresaId: string): Promise<ContatoPublico | null> {
    try {
        if (!await estruturaPerfilInstalada(tx)) return null;
        const unidades = (await tx.query<{ existe: string | null }>(`SELECT to_regclass('public.perfil_unidades') AS existe`)).rows[0];
        if (!unidades?.existe) return null;
        const perfil = await perfilDoTenantOuNulo(tx, empresaId);
        if (!perfil) return null;
        const linhas = (await tx.query<{ telefone: string | null; whatsapp: string | null; email: string | null; site: string | null; instagram: string | null }>(
            `SELECT telefone, whatsapp, email_comercial AS email, site, instagram
             FROM public.perfil_unidades WHERE empresa_id = $1::uuid ORDER BY id LIMIT 2`, [perfil])).rows;
        return linhas.length === 1 ? contatoPublicoDe(linhas[0]!) : null;
    } catch {
        return null;
    }
}
