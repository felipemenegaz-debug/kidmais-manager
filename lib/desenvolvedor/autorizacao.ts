import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { reautenticacaoPerfilRecente } from '../perfil/reautenticacao.ts';
import { erroAcesso } from '../acessos/erros.ts';

/**
 * Autoridade do PAINEL DO DESENVOLVEDOR (063, plataforma_desenvolvedores).
 *
 * Única fonte: concessão ativa da identidade, concedida/revogada só fora da aplicação
 * (scripts/admin-provision.cjs desenvolvedor). Não decorre do papel global (`REPRESENTANTE_AUTORIZADO`, legado da
 * Gestão), nem do papel de qualquer membership, nem de ser proprietário de uma empresa. Conferida no banco a cada
 * requisição e de novo dentro da transação de cada operação.
 *
 * Recusa = 404 genérico: quem não tem a concessão não fica sabendo que o painel existe.
 */
export const RECUSA_PAINEL = 'Recurso não encontrado.';

const CONCESSAO_SQL = `SELECT d.id FROM plataforma_desenvolvedores d JOIN usuarios_administrativos u ON u.id = d.usuario_id
  WHERE d.usuario_id = $1::uuid AND d.revogado_em IS NULL AND u.ativo`;

export async function temConcessaoDesenvolvedor(tx: DbExecutor, usuarioId: string, travar = false) {
    return (await tx.query<{ id: string }>(`${CONCESSAO_SQL}${travar ? ' FOR SHARE OF d' : ''}`, [usuarioId])).rows.length > 0;
}

/** Dentro da transação da operação: a concessão fica travada (FOR SHARE) até o commit; revogação concorrente espera. */
export async function exigirDesenvolvedorNaTransacao(tx: DbExecutor, sessao: Pick<SessaoAdmin, 'usuario_id'>) {
    if (!await temConcessaoDesenvolvedor(tx, sessao.usuario_id, true))
        throw erroAcesso('NAO_ENCONTRADO', RECUSA_PAINEL, 404);
}

/**
 * Operações de efeito (provisionar, suspender/reativar, papel, vínculo) exigem senha confirmada há no máximo 5 min.
 * Ambos os horários vêm de consultarSessao/PostgreSQL. Carimbos futuros são recusados.
 */
export function exigirReautenticacaoRecente(sessao: Pick<SessaoAdmin, 'autenticado_em' | 'consultado_em'>, agora = Date.parse(sessao.consultado_em ?? '')) {
    if (!reautenticacaoPerfilRecente(sessao.autenticado_em, agora))
        throw erroAcesso('REAUTENTICACAO', 'Confirme sua senha para concluir esta operação.', 403);
}

/**
 * Política de sessões ao perder acesso (D4): quem fica sem nenhuma membership ATIVA em empresa ATIVA (e não é
 * desenvolvedor) tem as sessões encerradas. Quem ainda tem outra empresa continua logado — a empresa suspensa ou o
 * vínculo desativado já é recusado por provarTenant em toda requisição.
 */
export async function encerrarSessoesSemAcesso(tx: DbExecutor, usuarioIds: readonly string[]) {
    let usuarios = 0, sessoes = 0;
    for (const usuarioId of [...new Set(usuarioIds)].sort()) {
        const acesso = (await tx.query<{ tem: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM memberships m JOIN empresas e ON e.id = m.empresa_id WHERE m.usuario_id = $1::uuid AND m.status = 'ATIVA' AND e.status = 'ATIVA')
                 OR EXISTS (${CONCESSAO_SQL}) AS tem`, [usuarioId])).rows[0];
        if (acesso?.tem)
            continue;
        const n = (await tx.query<{ id: string }>('UPDATE sessoes_administrativas SET revogado_em = clock_timestamp() WHERE usuario_id = $1 AND revogado_em IS NULL RETURNING id', [usuarioId])).rows.length;
        if (n > 0) {
            usuarios += 1;
            sessoes += n;
        }
    }
    return { usuarios, sessoes };
}
