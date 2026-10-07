import { apiErrorResponse } from '../http/api-response.ts';
import { falhar } from '../acessos/http.ts';
import { isAcessoServiceError } from '../acessos/erros.ts';
import { withTransaction } from '../db/postgres.ts';
import { withTenantTransaction } from '../saas/provar-tenant.ts';
import { clienteAsaasDoAmbiente } from './asaas.ts';
import { travaPorEmpresa, type DepsCobranca } from './cobranca.ts';
import { processarEvento } from './sincronizacao.ts';

/** Dependências reais das rotas de cobrança (banco do serviço e provedor do ambiente). */
export function depsCobrancaPadrao(env: Record<string, string | undefined> = process.env): DepsCobranca {
    return { withTenantTransaction, withTransaction, travarContratacao: travaPorEmpresa(withTransaction), provedor: () => clienteAsaasDoAmbiente(env).cliente, env };
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
        const r = await withTransaction((tx) => processarEvento(tx, eventoInternoId, { provedor }));
        if (r.situacao === 'FALHOU')
            console.warn('[Asaas webhook] evento não processado agora; fica FALHOU para nova tentativa.');
    }
    catch (error) {
        console.error('[Asaas webhook] falha ao processar evento', error instanceof Error ? error.name : typeof error);
    }
}
