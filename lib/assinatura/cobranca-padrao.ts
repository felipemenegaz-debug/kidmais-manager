import { apiErrorResponse } from '../http/api-response.ts';
import { falhar } from '../acessos/http.ts';
import { isAcessoServiceError } from '../acessos/erros.ts';
import { conexaoDescartavelDoPool, withTransaction } from '../db/postgres.ts';
import { transacaoComPrazo } from '../db/transacao-com-prazo.ts';
import { withTenantTransaction } from '../saas/provar-tenant.ts';
import { clienteAsaasDoAmbiente } from './asaas.ts';
import { travaPorEmpresa, type DepsCobranca } from './cobranca.ts';
import { processarEvento } from './sincronizacao.ts';
import { PRAZO_TRANSACAO_INDEPENDENTE_MS } from './reconciliacao-contratacao.ts';

/**
 * Transação independente da aplicação (marcador de exclusão e resultado do DELETE): outra conexão do pool, com prazo do
 * lado da aplicação; vencido → conexão descartada, nunca devolvida ao pool. O pool e withTransaction não mudam.
 */
export const transacaoIndependenteDaAplicacao = transacaoComPrazo(conexaoDescartavelDoPool, PRAZO_TRANSACAO_INDEPENDENTE_MS);

/** Dependências reais das rotas de cobrança (banco do serviço e provedor do ambiente). */
export function depsCobrancaPadrao(env: Record<string, string | undefined> = process.env): DepsCobranca {
    return { withTenantTransaction, withTransaction, transacaoIndependente: transacaoIndependenteDaAplicacao, travarContratacao: travaPorEmpresa(withTransaction), provedor: () => clienteAsaasDoAmbiente(env).cliente, env };
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
        const r = await withTransaction((tx) => processarEvento(tx, eventoInternoId, { provedor, transacaoIndependente: transacaoIndependenteDaAplicacao }));
        if (r.situacao === 'FALHOU')
            console.warn('[Asaas webhook] evento não processado agora; fica FALHOU para nova tentativa.');
    }
    catch (error) {
        console.error('[Asaas webhook] falha ao processar evento', error instanceof Error ? error.name : typeof error);
    }
}
