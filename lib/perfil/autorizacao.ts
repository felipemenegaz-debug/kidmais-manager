import type { DbExecutor } from '../db/contracts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import { CAPACIDADES_PERFIL, capacidadePerfil, type CapacidadePerfil } from './capacidades.ts';
import { estruturaPerfilInstalada } from './estrutura.ts';

// Legado V1: UUID e código EMP-* do perfil são independentes do cadastro SaaS.
// Associação, nesta ordem: mesmo UUID; código do perfil igual ao código da empresa (perfis criados pela
// implantação nascem assim); instalação com UMA empresa e UM perfil; e o perfil legado sem código correspondente
// (o único perfil órfão da instalação) pertence à empresa legada `kidmais` (046), mesmo depois de o painel
// provisionar outras empresas. Mais de um candidato fecha o acesso. Esta associação não concede capacidades.
export const EMPRESA_SAAS_DO_PERFIL = `SELECT id, status, count(*) OVER () AS candidatos FROM empresas
  WHERE id = p.id OR codigo = lower(p.codigo) OR (
    (SELECT count(*) FROM empresas) = 1 AND
    (SELECT count(*) FROM public.perfil_empresas) = 1
  ) OR (
    codigo = 'kidmais'
    AND NOT EXISTS (SELECT 1 FROM empresas x WHERE x.id = p.id OR x.codigo = lower(p.codigo))
    AND (SELECT count(*) FROM public.perfil_empresas q
          WHERE NOT EXISTS (SELECT 1 FROM empresas y WHERE y.id = q.id OR y.codigo = lower(q.codigo))) = 1
  )`;

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
    // O cadastro do perfil (026) e a empresa SaaS (031) têm UUIDs independentes.
    // A membership da empresa associada continua comprovando a Gestão.
    const usuario = (await tx.query<{ id: string; papel: string; ativo: boolean }>(
        `SELECT u.id, m.papel, (u.ativo AND m.status = 'ATIVA') AS ativo
           FROM usuarios_administrativos u
           JOIN public.perfil_empresas p ON p.id = $2::uuid
           JOIN LATERAL (${EMPRESA_SAAS_DO_PERFIL}) e ON e.candidatos = 1 AND e.status = 'ATIVA'
           JOIN memberships m ON m.usuario_id = u.id AND m.empresa_id = e.id
          WHERE u.id = $1`,
        [usuarioId, empresaId],
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
