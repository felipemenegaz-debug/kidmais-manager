import { apiErrorResponse } from '../http/api-response.ts';
import { falhar } from '../acessos/http.ts';
import { isAcessoServiceError } from '../acessos/erros.ts';
import { conexaoDescartavelDoPool, withTransaction } from '../db/postgres.ts';
import { transacaoComPrazo } from '../db/transacao-com-prazo.ts';
import { withTenantTransaction } from '../saas/provar-tenant.ts';
import { clienteAsaasDoAmbiente } from './asaas.ts';
import { criarEnviarEmail } from '../acessos/email.ts';
import { travaPorEmpresa, type DepsCobranca } from './cobranca.ts';
import type { DepsDevolucao } from './devolucao.ts';
import { processarEvento } from './sincronizacao.ts';
import { PRAZO_TRANSACAO_INDEPENDENTE_MS } from './reconciliacao-contratacao.ts';
import { contaProvedor, contaValida } from '../creditos/config.ts';
import type { DepsCreditos } from '../creditos/compra.ts';
import { consumirLimite } from '../autenticacao/service.ts';
import { drenarNotificacoes } from '../creditos/notificacoes.ts';

/**
 * Transação independente da aplicação (marcador de exclusão e resultado do DELETE): outra conexão do pool, com prazo do
 * lado da aplicação; vencido → conexão descartada, nunca devolvida ao pool. O pool e withTransaction não mudam.
 */
export const transacaoIndependenteDaAplicacao = transacaoComPrazo(conexaoDescartavelDoPool, PRAZO_TRANSACAO_INDEPENDENTE_MS);

/** Dependências reais das rotas de cobrança (banco do serviço e provedor do ambiente). */
export function depsCobrancaPadrao(env: Record<string, string | undefined> = process.env): DepsCobranca {
    return { withTenantTransaction, withTransaction, transacaoIndependente: transacaoIndependenteDaAplicacao, travarContratacao: travaPorEmpresa(withTransaction), provedor: () => clienteAsaasDoAmbiente(env).cliente, env,
        enviarEmail: criarEnviarEmail() };
}

/** Erros do serviço de cobrança (AcessoServiceError) e das guardas administrativas, sem detalhe interno. */
export function responderErroCobranca(error: unknown) {
    return isAcessoServiceError(error) ? falhar(error) : apiErrorResponse(error);
}

/**
 * Processamento depois da resposta do webhook (`after`). Falha não volta ao provedor (o 200 já saiu): o evento fica
 * FALHOU e é reprocessado pela reentrega do mesmo evento, pela sincronização do painel ou pela reconciliação.
 * Nenhum log leva corpo, token, chave ou dado do pagador.
 */
export async function processarEventoAgendado(eventoInternoId: string) {
    const p = clienteAsaasDoAmbiente();
    if (!p.cliente)
        return;
    const provedor = p.cliente;
    try {
        // O marcador de exclusão usa OUTRA conexão do pool (COMMIT próprio, antes do DELETE), com prazo do lado da aplicação.
        // R4-P2-2: conta de créditos inválida não impede a assinatura; o evento de créditos fica FALHOU (CREDITOS_SEM_PROVEDOR).
        const creditos = contaValida() ? { ambiente: p.config.ambiente, conta: contaProvedor() } : undefined;
        if (!creditos) console.error('[creditos] CREDITOS_ASAAS_CONTA inválida: eventos de créditos não processados.');
        const r = await withTransaction((tx) => processarEvento(tx, eventoInternoId, { provedor, transacaoIndependente: transacaoIndependenteDaAplicacao,
            ...(creditos ? { creditos } : {}) }));
        if (r.situacao === 'FALHOU')
            console.warn('[Asaas webhook] evento não processado agora; fica FALHOU para nova tentativa.');
    }
    catch (error) {
        console.error('[Asaas webhook] falha ao processar evento', error instanceof Error ? error.name : typeof error);
    }
}

/** Dependências reais dos créditos de IA (095): banco do serviço, provedor do ambiente e limites persistentes. */
export function depsCreditosPadrao(env: Record<string, string | undefined> = process.env): DepsCreditos {
    return { withTenantTransaction, withTransaction, consumirLimite, env, provedor: () => {
        const p = clienteAsaasDoAmbiente(env);
        return p.cliente ? { cliente: p.cliente, ambiente: p.config.ambiente } : null;
    } };
}

/** E-mails pendentes dos créditos (outbox), depois da resposta; falha só reagenda. */
export async function drenarNotificacoesCreditos() {
    try {
        await drenarNotificacoes({ withTransaction, enviarEmail: criarEnviarEmail() });
    }
    catch (error) {
        console.warn('[creditos] envio de notificações adiado', error instanceof Error ? error.name : typeof error);
    }
}

/** Dependências reais do encerramento com devolução (089): banco do serviço, provedor do ambiente e e-mail do app. */
export function depsDevolucaoPadrao(env: Record<string, string | undefined> = process.env): DepsDevolucao {
    return { withTenantTransaction, withTransaction, provedor: () => clienteAsaasDoAmbiente(env).cliente, env, enviarEmail: criarEnviarEmail() };
}
