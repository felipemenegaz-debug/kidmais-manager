import type { DbExecutor } from '../db/contracts';
import { temAutoridadeDePlataforma } from './plataforma.ts';

/**
 * Contexto da sessão para a interface (D7): em qual empresa a pessoa está e com que papel NAQUELA empresa.
 *
 * A empresa selecionada segue exatamente a regra de provarTenant: `empresaId` pedido (se for uma membership ATIVA
 * em empresa ATIVA da pessoa) ou, sem pedido, a única membership ativa. Com mais de uma e nenhum pedido não há
 * empresa selecionada (o servidor também recusa operar sem escolha) — o menu não mostra configurações de empresa.
 * O papel exibido é o da membership (o mesmo que exigirGestaoNoTenant confere); a autoridade de plataforma é a
 * da identidade (temAutoridadeDePlataforma, F1). Nada aqui autoriza: só espelha o que as APIs exigem.
 */
export type EmpresaDoUsuario = { id: string; nome: string; papel: string };
export type ContextoSessao = {
    empresas: EmpresaDoUsuario[];
    empresaAtual: EmpresaDoUsuario | null;
    gestaoNaEmpresa: boolean;
    plataforma: boolean;
    desenvolvedor: boolean;
    selecaoNecessaria: boolean;
};

export async function contextoDaSessao(tx: DbExecutor, sessao: { usuario_id: string; papel: string }, empresaSolicitada?: string | null): Promise<ContextoSessao> {
    const empresas = (await tx.query<EmpresaDoUsuario>(
        `SELECT e.id::text AS id, e.nome, m.papel FROM memberships m JOIN empresas e ON e.id = m.empresa_id
          WHERE m.usuario_id = $1::uuid AND m.status = 'ATIVA' AND e.status = 'ATIVA' ORDER BY e.nome, e.id`, [sessao.usuario_id])).rows;
    const pedida = empresaSolicitada ? empresas.find((e) => e.id === empresaSolicitada.toLowerCase()) ?? null : null;
    const empresaAtual = pedida ?? (!empresaSolicitada && empresas.length === 1 ? empresas[0] : null);
    let desenvolvedor = false;
    try {
        desenvolvedor = (await tx.query(`SELECT 1 FROM plataforma_desenvolvedores d JOIN usuarios_administrativos u ON u.id = d.usuario_id
            WHERE d.usuario_id = $1::uuid AND d.revogado_em IS NULL AND u.ativo`, [sessao.usuario_id])).rows.length > 0;
    }
    catch (error) {
        // 063 ainda não aplicada: sem painel do desenvolvedor.
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01'))
            throw error;
    }
    return {
        empresas,
        empresaAtual,
        gestaoNaEmpresa: empresaAtual?.papel === 'REPRESENTANTE_AUTORIZADO',
        plataforma: temAutoridadeDePlataforma(sessao),
        desenvolvedor,
        selecaoNecessaria: !empresaAtual && empresas.length > 1,
    };
}
