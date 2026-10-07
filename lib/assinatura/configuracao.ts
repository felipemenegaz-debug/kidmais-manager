/**
 * Configuração comercial lida do ambiente. Nenhum preço, desconto ou prazo comercial é decidido no código:
 *   - ASSINATURA_TESTE_DIAS: duração do teste grátis gravada em teste_fim quando a empresa nasce no cadastro público.
 *     Padrão 15 (pedido de 07/10/2026; a proposta de 06/10 registrou 30 — decisão comercial final pendente). 1–90.
 *   - ASSINATURA_PRECO_MENSAL_CENTAVOS / ASSINATURA_PRECO_ANUAL_CENTAVOS: preço por ciclo, em centavos. Sem preço o
 *     checkout daquele ciclo fica indisponível (nada é cobrado com valor inventado).
 * Valor inválido é erro de configuração visível (não cai silenciosamente no padrão).
 */
export const TESTE_DIAS_PADRAO = 15;
export const TESTE_DIAS_MAXIMO = 90;
/** Teto de uma extensão de teste concedida pelo painel (cada extensão é uma exceção auditada). */
export const EXTENSAO_TESTE_MAXIMA_DIAS = 60;

export type Ciclo = 'MENSAL' | 'ANUAL';
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

/** Preço do ciclo em centavos, ou null quando não configurado. Limite de sanidade: R$ 100.000,00. */
export function precoDoCiclo(ciclo: Ciclo, env: Ambiente = process.env): number | null {
    return inteiro(env, ciclo === 'MENSAL' ? 'ASSINATURA_PRECO_MENSAL_CENTAVOS' : 'ASSINATURA_PRECO_ANUAL_CENTAVOS', 100, 10_000_000);
}
