import type { DbExecutor } from '../db/contracts.ts';
import { estruturaPerfilInstalada } from './estrutura.ts';
import { perfilDoTenantOuNulo } from './tenant.ts';
import { ClienteServiceError } from '../clientes/services/errors.ts';

/**
 * Nome exibido no endereço público da empresa: o nome comercial APLICADO no perfil (nunca o rascunho);
 * sem perfil, perfil ambíguo, nome vazio ou estrutura ausente → `empresas.nome`. Só leitura; não exige capacidade
 * porque o nome comercial é, por definição, o que os clientes veem.
 * `propagarErroDeBanco`: para quem está em transação. Depois de uma falha de SQL a transação está abortada, então cair no
 * nome da empresa só trocaria a causa real por 25P02; o perfil ambíguo (erro de negócio, sem SQL falho) segue caindo nele.
 */
export async function nomePublicoDaEmpresa(tx: DbExecutor, empresaId: string, opcoes: { propagarErroDeBanco?: boolean } = {}): Promise<string | null> {
    try {
        if (await estruturaPerfilInstalada(tx)) {
            const perfil = await perfilDoTenantOuNulo(tx, empresaId);
            if (perfil) {
                const nome = (await tx.query<{ nome: string | null }>(
                    'SELECT nome_comercial AS nome FROM public.perfil_empresas WHERE id = $1::uuid', [perfil])).rows[0]?.nome?.trim();
                if (nome) return nome;
            }
        }
    } catch (erro) {
        if (opcoes.propagarErroDeBanco && !(erro instanceof ClienteServiceError)) throw erro;
        // Perfil ambíguo ou ilegível: segue para o nome da empresa, sem expor o motivo.
    }
    const empresa = (await tx.query<{ nome: string }>('SELECT nome FROM public.empresas WHERE id = $1::uuid', [empresaId])).rows[0];
    return empresa?.nome?.trim() || null;
}
