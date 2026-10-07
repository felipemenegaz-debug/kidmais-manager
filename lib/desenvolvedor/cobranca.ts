import { z } from 'zod';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { AsaasFalhou, clienteAsaasDoAmbiente, type ClienteAsaas } from '../assinatura/asaas.ts';
import { sincronizarEmpresa } from '../assinatura/sincronizacao.ts';
import { liberarIntencaoCriacao, pendenciasDaEmpresa } from '../assinatura/liberacao-intencao.ts';
import { exigirDesenvolvedorNaTransacao, exigirReautenticacaoRecente } from './autorizacao.ts';
import { auditarPainel, type ContextoPainel } from './auditoria.ts';
import { painelDepsPadrao, type PainelDeps } from './interessadas.ts';

/**
 * Painel do desenvolvedor (E8): "Sincronizar com o provedor" — reconsulta a assinatura da empresa no Asaas e aplica o
 * estado atual (mesma função do webhook). Exige concessão de desenvolvedor travada na transação e senha confirmada há
 * ≤ 5 min; auditado. Altera SOMENTE a situação comercial da empresa alvo; nenhuma concessão, papel ou vínculo.
 */
export type CobrancaPainelDeps = PainelDeps & { provedor: () => ClienteAsaas | null };
export const cobrancaPainelDepsPadrao = (): CobrancaPainelDeps => ({ ...painelDepsPadrao, provedor: () => clienteAsaasDoAmbiente().cliente });

export async function sincronizarCobrancaEmpresa(sessao: SessaoAdmin, id: string, ctx: ContextoPainel, deps: CobrancaPainelDeps = cobrancaPainelDepsPadrao()) {
    exigirReautenticacaoRecente(sessao);
    const empresaId = z.string().uuid().parse(id);
    const provedor = deps.provedor();
    if (!provedor)
        throw erroAcesso('COBRANCA_NAO_CONFIGURADA', 'A cobrança não está configurada neste ambiente.', 503);
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        if (!(await tx.query<{ ok: boolean }>("SELECT to_regclass('public.cobranca_eventos') IS NOT NULL AS ok")).rows[0]?.ok)
            throw erroAcesso('COBRANCA_NAO_CONFIGURADA', 'A cobrança não está instalada neste banco (migration 068).', 503);
        let r;
        try {
            r = await sincronizarEmpresa(tx, empresaId, { provedor }, { tipo: 'DESENVOLVEDOR', usuarioId: sessao.usuario_id, requestId: ctx.requestId });
        }
        catch (error) {
            if (error instanceof AsaasFalhou)
                throw erroAcesso('COBRANCA_FALHOU', 'O provedor de pagamento não respondeu. Nada foi alterado.', 502);
            throw error;
        }
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: 'COBRANCA_SINCRONIZADA', entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId,
            resultado: r.resultado === 'SINCRONIZADA' ? 'SUCESSO' : 'RECUSADO',
            depois: r.resultado === 'SINCRONIZADA' ? { antes: r.antes, depois: r.depois, mudou: r.mudou, provedorSituacao: r.provedorSituacao } : { resultado: r.resultado }, ctx,
        });
        return r;
    });
}

/** Pendências de cobrança abertas da empresa (painel; sem ids do provedor). */
export async function pendenciasCobrancaEmpresa(sessao: SessaoAdmin, id: string, deps: CobrancaPainelDeps = cobrancaPainelDepsPadrao()) {
    const empresaId = z.string().uuid().parse(id);
    return deps.withTransaction((tx) => pendenciasDaEmpresa(tx, sessao, empresaId));
}

/**
 * Libera, manualmente e com auditoria, uma intenção de criação comprovadamente não executada (ver
 * lib/assinatura/liberacao-intencao.ts). Senha confirmada há ≤ 5 min; nunca por prazo.
 */
export async function liberarIntencaoCobranca(sessao: SessaoAdmin, id: string, raw: unknown, ctx: ContextoPainel, deps: CobrancaPainelDeps = cobrancaPainelDepsPadrao()) {
    exigirReautenticacaoRecente(sessao);
    const empresaId = z.string().uuid().parse(id);
    const provedor = deps.provedor();
    if (!provedor)
        throw erroAcesso('COBRANCA_NAO_CONFIGURADA', 'A cobrança não está configurada neste ambiente.', 503);
    try {
        return await deps.withTransaction((tx) => liberarIntencaoCriacao(tx, sessao, empresaId, raw, provedor, ctx));
    }
    catch (error) {
        if (error instanceof AsaasFalhou)
            throw erroAcesso('COBRANCA_FALHOU', 'O provedor de pagamento não respondeu. Nada foi liberado.', 502);
        throw error;
    }
}
