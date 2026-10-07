import { PRAZOS_PROPOSTOS, type PrazosAcesso } from './acesso.ts';

/**
 * Configuração comercial lida do ambiente. Nenhum preço, desconto ou prazo comercial é decidido no código:
 *   - ASSINATURA_TESTE_DIAS: duração do teste grátis gravada em teste_fim quando a empresa nasce no cadastro público.
 *     PADRÃO PROPOSTO: 15 dias (pedido de 07/10/2026; a proposta de 06/10 citava 30). Não é decisão comercial final. 1–90.
 *   - ASSINATURA_PRECO_MENSAL_CENTAVOS / ASSINATURA_PRECO_ANUAL_CENTAVOS: preço por ciclo, em centavos. Sem preço o
 *     checkout daquele ciclo fica indisponível (nada é cobrado com valor inventado).
 *   - ASSINATURA_REGULARIZACAO_DIAS (0–30, padrão proposto 7) e ASSINATURA_SOMENTE_LEITURA_DIAS (0–365, padrão proposto 60):
 *     prazos do acesso depois de falha de pagamento e depois do fim do acesso completo. HIPÓTESES, não políticas aprovadas.
 * Valor inválido é erro de configuração visível (não cai silenciosamente no padrão).
 */
export const TESTE_DIAS_PADRAO = 15;
export const TESTE_DIAS_MAXIMO = 90;
/** Teto de uma extensão de teste concedida pelo painel (cada extensão é uma exceção auditada). */
export const EXTENSAO_TESTE_MAXIMA_DIAS = 60;

export type Ciclo = 'MENSAL' | 'ANUAL';
export const REGULARIZACAO_DIAS_MAXIMO = 30;
export const SOMENTE_LEITURA_DIAS_MAXIMO = 365;
type Ambiente = Record<string, string | undefined>;

export class ConfiguracaoComercialInvalida extends Error {
    readonly variavel: string;
    constructor(variavel: string) {
        super(`Configuração comercial inválida: ${variavel}.`);
        this.name = 'ConfiguracaoComercialInvalida';
        this.variavel = variavel;
    }
}

function inteiro(env: Ambiente, nome: string, min: number, max: number): number | null {
    const bruto = env[nome]?.trim();
    if (!bruto)
        return null;
    if (!/^\d+$/.test(bruto))
        throw new ConfiguracaoComercialInvalida(nome);
    const n = Number(bruto);
    if (!Number.isSafeInteger(n) || n < min || n > max)
        throw new ConfiguracaoComercialInvalida(nome);
    return n;
}

export function duracaoTesteDias(env: Ambiente = process.env): number {
    return inteiro(env, 'ASSINATURA_TESTE_DIAS', 1, TESTE_DIAS_MAXIMO) ?? TESTE_DIAS_PADRAO;
}

/** Prazos do acesso comercial (regularização e somente leitura). Sem variável, os valores propostos de acesso.ts. */
export function prazosDeAcesso(env: Ambiente = process.env): PrazosAcesso {
    return {
        regularizacaoDias: inteiro(env, 'ASSINATURA_REGULARIZACAO_DIAS', 0, REGULARIZACAO_DIAS_MAXIMO) ?? PRAZOS_PROPOSTOS.regularizacaoDias,
        somenteLeituraDias: inteiro(env, 'ASSINATURA_SOMENTE_LEITURA_DIAS', 0, SOMENTE_LEITURA_DIAS_MAXIMO) ?? PRAZOS_PROPOSTOS.somenteLeituraDias,
    };
}

/** Preço do ciclo em centavos, ou null quando não configurado. Limite de sanidade: R$ 100.000,00. */
export function precoDoCiclo(ciclo: Ciclo, env: Ambiente = process.env): number | null {
    return inteiro(env, ciclo === 'MENSAL' ? 'ASSINATURA_PRECO_MENSAL_CENTAVOS' : 'ASSINATURA_PRECO_ANUAL_CENTAVOS', 100, 10_000_000);
}
