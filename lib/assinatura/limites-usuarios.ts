import type { DbExecutor } from '../db/contracts';
import { erroAcesso } from '../acessos/erros.ts';
import { empresaIsenta, schemaPlanosInstalado } from './ofertas.ts';
import { planosComerciais, planoComercialValido } from './planos-comerciais.ts';

/**
 * Plano do contrato confirmado atual, ou null quando nada limita: sem schema 074, empresa isenta, teste ou legado.
 * Plano desconhecido falha fechado (503); nunca vira um plano por inferência.
 */
export async function planoConfirmado(tx: DbExecutor, empresaId: string, falha = 'Não foi possível conferir o plano contratado.') {
    if (!await schemaPlanosInstalado(tx) || await empresaIsenta(tx, empresaId)) return null;
    const contrato = (await tx.query<{ plano: string }>(`SELECT c.plano FROM empresa_assinaturas a
        JOIN assinatura_contratacoes c ON c.id=a.contratacao_atual_id AND c.empresa_id=a.empresa_id AND c.estado='CONFIRMADA'
        WHERE a.empresa_id=$1::uuid`, [empresaId])).rows[0];
    if (!contrato) return null;
    const plano = contrato.plano.toLowerCase();
    if (!planoComercialValido(plano)) throw erroAcesso('PLANOS_NAO_DISPONIVEIS', falha, 503);
    return plano;
}

/** Só contratos confirmados limitam vagas. Trial, legado e isenção preservam acesso. */
export async function consultarVagas(tx: DbExecutor, empresaId: string) {
    const plano = await planoConfirmado(tx, empresaId, 'Não foi possível conferir as vagas do plano.');
    if (!plano) return null;
    // Convites vencidos/cancelados/aceitos não reservam vaga. Pessoas já ativas não contam duas vezes.
    const contagem = (await tx.query<{ ativos: number; pendentes: number }>(`SELECT
        (SELECT count(*)::int FROM memberships m JOIN usuarios_administrativos u ON u.id=m.usuario_id
          WHERE m.empresa_id=$1::uuid AND m.status='ATIVA' AND u.ativo) AS ativos,
        (SELECT count(*)::int FROM convites_acesso c WHERE c.empresa_id=$1::uuid AND c.status='PENDENTE' AND c.expira_em>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM memberships m JOIN usuarios_administrativos u ON u.id=m.usuario_id
            WHERE m.empresa_id=c.empresa_id AND m.status='ATIVA' AND u.ativo AND u.email=c.email)) AS pendentes`, [empresaId])).rows[0];
    if (!contagem || !Number.isSafeInteger(contagem.ativos) || !Number.isSafeInteger(contagem.pendentes) || contagem.ativos<0 || contagem.pendentes<0)
        throw erroAcesso('PLANOS_NAO_DISPONIVEIS', 'Não foi possível conferir as vagas do plano.', 503);
    const limite = planosComerciais[plano].limiteUsuarios;
    const ocupadas = contagem.ativos + contagem.pendentes;
    return { plano, limite, ativos:contagem.ativos, convitesPendentes:contagem.pendentes, ocupadas,
        disponiveis:limite===null?null:Math.max(0,limite-ocupadas), excedido:limite!==null&&ocupadas>limite };
}

/** Na mesma transação da adição de acesso, a trava da empresa serializa reservas. */
export async function exigirVaga(tx: DbExecutor, empresaId: string, adicional: 0 | 1 = 1) {
    await tx.query('SELECT id FROM empresas WHERE id=$1::uuid FOR UPDATE', [empresaId]);
    const vagas = await consultarVagas(tx, empresaId);
    if (adicional === 1 && vagas?.limite!==null && vagas?.limite!==undefined && vagas.ocupadas+adicional>vagas.limite)
        throw erroAcesso('LIMITE_USUARIOS_PLANO', 'O plano atingiu o limite de pessoas. Cancele um convite pendente ou libere uma vaga para adicionar alguém. Os acessos existentes são preservados.', 409,
            { limite:vagas.limite, ocupadas:vagas.ocupadas });
    return vagas;
}
