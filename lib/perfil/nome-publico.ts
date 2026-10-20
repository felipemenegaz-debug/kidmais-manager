import type { DbExecutor } from '../db/contracts.ts';
import { estruturaPerfilInstalada } from './estrutura.ts';
import { perfilDoTenantOuNulo } from './tenant.ts';

/**
 * Nome exibido no endereço público da empresa: o nome comercial APLICADO no perfil (nunca o rascunho);
 * sem perfil, perfil ambíguo, nome vazio ou estrutura ausente → `empresas.nome`. Só leitura; não exige capacidade
 * porque o nome comercial é, por definição, o que os clientes veem.
 */
export async function nomePublicoDaEmpresa(tx: DbExecutor, empresaId: string): Promise<string | null> {
    try {
        if (await estruturaPerfilInstalada(tx)) {
            const perfil = await perfilDoTenantOuNulo(tx, empresaId);
            if (perfil) {
                const nome = (await tx.query<{ nome: string | null }>(
                    'SELECT nome_comercial AS nome FROM public.perfil_empresas WHERE id = $1::uuid', [perfil])).rows[0]?.nome?.trim();
                if (nome) return nome;
            }
        }
    } catch {
        // Perfil ambíguo ou ilegível: segue para o nome da empresa, sem expor o motivo.
    }
    const empresa = (await tx.query<{ nome: string }>('SELECT nome FROM public.empresas WHERE id = $1::uuid', [empresaId])).rows[0];
    return empresa?.nome?.trim() || null;
}
