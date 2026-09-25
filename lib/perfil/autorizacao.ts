import type { DbExecutor } from '../db/contracts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import { CAPACIDADES_PERFIL, capacidadePerfil, type CapacidadePerfil } from './capacidades.ts';
import { estruturaPerfilInstalada } from './estrutura.ts';

export type ConsultaCapacidadesPerfil = {
    estruturaInstalada: boolean;
    gestaoAtiva: boolean;
    capacidades: Record<CapacidadePerfil, boolean>;
};

function mapaVazio(): Record<CapacidadePerfil, boolean> {
    return {
        PERFIL_CONSULTAR: false,
        PERFIL_EDITAR_RASCUNHO: false,
        PERFIL_APLICAR: false,
        PERFIL_ADMINISTRAR_CONCESSOES: false,
    };
}

export async function consultarCapacidadesPerfil(tx: DbExecutor, empresaId: string, usuarioId: string): Promise<ConsultaCapacidadesPerfil> {
    const estruturaInstalada = await estruturaPerfilInstalada(tx);
    const vazio = mapaVazio();
    if (!estruturaInstalada)
        return { estruturaInstalada: false, gestaoAtiva: false, capacidades: vazio };
    const usuario = (await tx.query<{ id: string; papel: string; ativo: boolean }>(
        'SELECT id, papel, ativo FROM usuarios_administrativos WHERE id=$1',
        [usuarioId],
    )).rows[0];
    if (!usuario || !usuario.ativo || usuario.papel !== 'REPRESENTANTE_AUTORIZADO')
        return { estruturaInstalada: true, gestaoAtiva: false, capacidades: vazio };
    const concessoes = await tx.query<{ capacidade: string }>(
        `SELECT capacidade FROM public.perfil_empresa_concessoes
         WHERE empresa_id=$1 AND usuario_id=$2 AND revogado_em IS NULL`,
        [empresaId, usuarioId],
    );
    const capacidades = mapaVazio();
    for (const linha of concessoes.rows) {
        const capacidade = capacidadePerfil(linha.capacidade);
        if (capacidade)
            capacidades[capacidade] = true;
    }
    return { estruturaInstalada: true, gestaoAtiva: true, capacidades };
}

export async function exigirCapacidadePerfil(tx: DbExecutor, empresaId: string, usuarioId: string, capacidade: CapacidadePerfil) {
    const consulta = await consultarCapacidadesPerfil(tx, empresaId, usuarioId);
    if (!consulta.capacidades[capacidade]) {
        throw new ClienteServiceError(
            'PERFIL_SEM_CONCESSAO',
            'Sem concessão ativa para esta capacidade do perfil.',
            403,
        );
    }
    return consulta;
}

export function capacidadesConcedidas(consulta: ConsultaCapacidadesPerfil) {
    return CAPACIDADES_PERFIL.filter((capacidade) => consulta.capacidades[capacidade]);
}
