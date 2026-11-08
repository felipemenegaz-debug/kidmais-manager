import { erroAcesso, type AcessoErroCodigo } from '../acessos/erros.ts';
import type { DbExecutor } from '../db/contracts.ts';

/**
 * B-25, L2 do ramo G-VAZIO (§9.2.4 e §9.2.5 do plano de promoção; D-VZ-5): trava comercial em código.
 *
 * Nesta entrega ela é PERMANENTEMENTE FECHADA em production. Não há variável, constante nem manifesto que a abra: a
 * abertura é entrega futura própria, dentro da D-COBRANCA-LIVE. Por isso esta decisão não lê nenhuma flag comercial e não
 * consulta linhas do domínio: a recusa em production é incondicional.
 *
 * Fecha se QUALQUER sinal indicar production ou se o ambiente não for reconhecido; sinais contraditórios fecham. Abre só
 * com staging declarado, banco e serviço que não sejam de production, ou em execução local (nenhum sinal de deploy).
 *
 * A leitura do banco acontece na transação do iniciador, como primeiro passo, antes de qualquer efeito. Erro na leitura
 * sobe e desfaz a transação: nunca vira "aberta".
 */
type Ambiente = Record<string, string | undefined>;

/**
 * Código da recusa. Fica fora de `AcessoErroCodigo` de propósito: `lib/acessos/erros.ts` tem o hash fixado pelo executor de
 * e-mail de production (`scripts/email-producao-20261020.cjs`, TRANSPORTE), e mudar aquele arquivo exigiria novo pacote de
 * e-mail. Em execução é um `AcessoServiceError` comum, com `code` = 'COBRANCA_TRAVADA' e HTTP 503.
 */
export const COBRANCA_TRAVADA = 'COBRANCA_TRAVADA' as unknown as AcessoErroCodigo;

/** Serviço web de production no Render, conforme `docs/OPERACAO_AGENTES.md`. */
const SERVICO_PRODUCTION = 'srv-dak77m2d0e5s73b8rkkg';

export type MotivoTravaFechada = 'BANCO_DESCONHECIDO' | 'BANCO_PRODUCTION' | 'SERVICO_PRODUCTION' | 'DEPLOY_PRODUCTION' | 'AMBIENTE_NAO_RECONHECIDO';
export type DecisaoTrava = { aberta: true; via: 'STAGING' | 'LOCAL' } | { aberta: false; motivo: MotivoTravaFechada };

const sinal = (valor: string | null | undefined) => (valor ?? '').trim();

/** Decisão pura, sobre o ambiente do processo e o `current_database()` lido na transação. */
export function decidirTravaCobranca(env: Ambiente, banco: string | null | undefined): DecisaoTrava {
    const nomeBanco = sinal(banco).toLowerCase();
    const servico = sinal(env.RENDER_SERVICE_ID);
    const deploy = sinal(env.KIDMAIS_DEPLOY_ENV);
    const render = sinal(env.RENDER);
    if (!nomeBanco)
        return { aberta: false, motivo: 'BANCO_DESCONHECIDO' };
    // Mais largo que o nome exato `kidmais_production`, de propósito: errar aqui só fecha.
    if (nomeBanco.includes('production'))
        return { aberta: false, motivo: 'BANCO_PRODUCTION' };
    if (servico === SERVICO_PRODUCTION)
        return { aberta: false, motivo: 'SERVICO_PRODUCTION' };
    if (deploy === 'production')
        return { aberta: false, motivo: 'DEPLOY_PRODUCTION' };
    if (deploy === 'staging')
        // No Render o serviço sempre se identifica; staging declarado sem essa identidade é contraditório.
        return render && !servico ? { aberta: false, motivo: 'AMBIENTE_NAO_RECONHECIDO' } : { aberta: true, via: 'STAGING' };
    if (deploy || render || servico)
        return { aberta: false, motivo: 'AMBIENTE_NAO_RECONHECIDO' };
    return { aberta: true, via: 'LOCAL' };
}

/** Lê o banco na transação e decide. A recusa fica no log só com o ponto e o motivo, sem dado do pedido. */
export async function cobrancaDestravada(tx: Pick<DbExecutor, 'query'>, ponto: string, env: Ambiente = process.env): Promise<boolean> {
    const banco = (await tx.query<{ banco: string | null }>('SELECT current_database() AS banco')).rows[0]?.banco;
    const decisao = decidirTravaCobranca(env, banco);
    if (decisao.aberta)
        return true;
    console.warn(`[trava cobrança] recusa em ${ponto}: ${decisao.motivo}.`);
    return false;
}

/** Para os pontos que respondem por erro de serviço: recusa com 503, sem efeito e sem auditoria. */
export async function exigirCobrancaDestravada(tx: Pick<DbExecutor, 'query'>, ponto: string, env: Ambiente = process.env): Promise<void> {
    if (!await cobrancaDestravada(tx, ponto, env))
        throw erroAcesso(COBRANCA_TRAVADA, 'Esta operação comercial não está disponível neste ambiente.', 503);
}
