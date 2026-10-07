import type { DbExecutor } from '../db/contracts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import type { AcessoComercial, MotivoAcesso } from './acesso.ts';
import { lerEstadoComercial } from './estado.ts';

/**
 * Paywall no SERVIDOR (E4). Aplicado em exigirApiAdminCrmDisponivel — a guarda por onde passam todas as rotas
 * /api/admin (diretamente, por lib/financeiro/http.ts ou pelas dependências da Inteligência; teste estático garante).
 *
 *   COMPLETO         → tudo liberado.
 *   SOMENTE_LEITURA  → GET/HEAD liberados; qualquer outro método recebe 402 ASSINATURA_NECESSARIA.
 *   BLOQUEADO        → tudo recusado com 402, exceto as rotas sempre permitidas.
 * Sempre permitidas (conta, cobrança e recuperação): autenticação (login, sair, reautenticar, trocar de empresa),
 * troca da própria senha, assinatura/cobrança e exportação. O painel do desenvolvedor (/api/desenvolvedor) é autoridade de
 * plataforma, não dado da empresa: a situação comercial da empresa de quem o opera não se aplica a ele. O cadastro de
 * outra empresa (/api/cadastro) também não depende da situação da empresa atual.
 *
 * Situação comercial NUNCA derruba sessão nem suspende a empresa: empresas.status continua sendo só administrativo.
 * A empresa considerada é a mesma que provarTenant aceitaria: a selecionada na sessão ou, sem seleção, a única
 * empresa ativa da pessoa. Sem empresa determinável não há o que cobrar aqui (provarTenant recusa sozinho).
 * Empresa sem linha de assinatura (Kidmais e todas as atuais) = sem cobrança, nada muda. Sem a 067 instalada, idem.
 */
export const ROTAS_SEMPRE_PERMITIDAS = ['/api/admin/autenticacao', '/api/admin/perfil/senha', '/api/admin/assinatura', '/api/admin/exportacao', '/api/desenvolvedor', '/api/cadastro'] as const;
const LEITURA = new Set(['GET', 'HEAD']);

export function rotaSemprePermitida(caminho: string) {
    const limpo = caminho.replace(/\/+$/, '');
    return ROTAS_SEMPRE_PERMITIDAS.some((r) => limpo === r || limpo.startsWith(`${r}/`));
}

const EXPLICACAO: Partial<Record<MotivoAcesso, string>> = {
    TESTE_ENCERRADO: 'O teste grátis terminou.',
    PAGAMENTO_PENDENTE: 'Há pagamento da assinatura pendente.',
    CANCELADA: 'A assinatura foi cancelada.',
    ENCERRADA: 'A assinatura foi encerrada.',
};

export type DecisaoPaywall =
    | { permitido: true }
    | { permitido: false; status: 402; codigo: 'ASSINATURA_NECESSARIA'; mensagem: string; nivel: AcessoComercial['nivel']; motivo: MotivoAcesso };

export function decidirPaywall(acesso: AcessoComercial, metodo: string, caminho: string): DecisaoPaywall {
    if (acesso.nivel === 'COMPLETO' || rotaSemprePermitida(caminho))
        return { permitido: true };
    if (acesso.nivel === 'SOMENTE_LEITURA' && LEITURA.has(metodo.toUpperCase()))
        return { permitido: true };
    const causa = EXPLICACAO[acesso.motivo] ?? 'A situação da assinatura não permite esta ação.';
    const mensagem = acesso.nivel === 'SOMENTE_LEITURA'
        ? `${causa} A empresa está em modo somente leitura: consulte e exporte seus dados ou assine para voltar a editar.`
        : `${causa} O acesso aos dados está suspenso até a assinatura; seus dados continuam guardados. Acesse Assinatura para regularizar.`;
    return { permitido: false, status: 402, codigo: 'ASSINATURA_NECESSARIA', mensagem, nivel: acesso.nivel, motivo: acesso.motivo };
}

/** A empresa que provarTenant aceitaria para esta sessão (sem travar nada), ou null. */
export async function empresaEfetivaDaSessao(executor: DbExecutor, sessao: { usuario_id: string; empresa_ativa_id?: string | null }) {
    if (sessao.empresa_ativa_id)
        return sessao.empresa_ativa_id;
    const ativas = (await executor.query<{ id: string }>(
        `SELECT m.empresa_id::text AS id FROM memberships m JOIN empresas e ON e.id = m.empresa_id
          WHERE m.usuario_id = $1::uuid AND m.status = 'ATIVA' AND e.status = 'ATIVA' LIMIT 2`, [sessao.usuario_id])).rows;
    return ativas.length === 1 ? ativas[0].id : null;
}

export type PaywallDeps = { lerEstado: typeof lerEstadoComercial };

/** Lança 402 ASSINATURA_NECESSARIA quando a situação comercial da empresa efetiva não permite o pedido. */
export async function exigirAcessoComercial(executor: DbExecutor, sessao: { usuario_id: string; empresa_ativa_id?: string | null }, metodo: string, caminho: string, deps: PaywallDeps = { lerEstado: lerEstadoComercial }) {
    if (rotaSemprePermitida(caminho))
        return;
    const empresa = await empresaEfetivaDaSessao(executor, sessao);
    if (!empresa)
        return;
    const estado = await deps.lerEstado(executor, empresa);
    const decisao = decidirPaywall(estado.acesso, metodo, caminho);
    if (!decisao.permitido)
        throw new ClienteServiceError('ASSINATURA_NECESSARIA', decisao.mensagem, 402, { nivel: decisao.nivel, motivo: decisao.motivo, ate: estado.acesso.ate });
}

/** Resumo para a interface (AdminShell e tela Assinatura). Nada aqui autoriza: a barreira é exigirAcessoComercial. */
export type ResumoComercial = {
    cobrado: boolean;
    situacao: string | null;
    ciclo: 'MENSAL' | 'ANUAL' | null;
    testeFim: string | null;
    periodoAtualFim: string | null;
    nivel: AcessoComercial['nivel'];
    motivo: MotivoAcesso;
    ate: string | null;
    agora: string;
};
export async function resumoComercialDaEmpresa(executor: DbExecutor, empresaId: string, deps: PaywallDeps = { lerEstado: lerEstadoComercial }): Promise<ResumoComercial> {
    const e = await deps.lerEstado(executor, empresaId);
    return {
        cobrado: e.assinatura !== null, situacao: e.assinatura?.situacao ?? null, ciclo: e.assinatura?.ciclo ?? null,
        testeFim: e.assinatura?.testeFim ?? null, periodoAtualFim: e.assinatura?.periodoAtualFim ?? null,
        nivel: e.acesso.nivel, motivo: e.acesso.motivo, ate: e.acesso.ate, agora: e.agora,
    };
}
