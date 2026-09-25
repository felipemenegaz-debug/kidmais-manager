/**
 * Validação sintática de CNPJ numérico e alfanumérico.
 * O formato e os dígitos seguem o Manual de Cálculo do DV do CNPJ da Receita Federal
 * (módulo 11, pesos 2–9, valor do caractere = ASCII − 48).
 * A rejeição de raiz repetida é política local e fica em `cnpjRaizPlaceholder`.
 * Não consulta cadastro nem titularidade.
 */

const PONTUACAO_PERMITIDA = /[.\-/ \u00a0]/g;

export function normalizarCnpj(valor: string | null | undefined) {
    return (valor ?? '').toUpperCase().replace(PONTUACAO_PERMITIDA, '');
}

function valorParaDv(caractere: string) {
    return caractere.charCodeAt(0) - 48;
}

function digitoVerificador(base: string) {
    let soma = 0;
    let peso = 2;
    for (let i = base.length - 1; i >= 0; i -= 1) {
        soma += valorParaDv(base[i]!) * peso;
        peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    return resto <= 1 ? 0 : 11 - resto;
}

/** Formato oficial e dígitos verificadores. Aceita raiz repetida quando o DV fecha. */
export function cnpjFormatoDvOficial(valor: string | null | undefined) {
    if (valor == null) return false;
    const normalizado = normalizarCnpj(valor);
    if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(normalizado)) return false;

    const raiz = normalizado.slice(0, 12);
    const primeiro = digitoVerificador(raiz);
    const segundo = digitoVerificador(raiz + String(primeiro));
    return primeiro === Number(normalizado[12]) && segundo === Number(normalizado[13]);
}

/** Mesma verificação oficial. Não aplica `cnpjRaizPlaceholder`. */
export function cnpjValido(valor: string | null | undefined) {
    return cnpjFormatoDvOficial(valor);
}

/** Fora do manual: as doze posições da raiz repetem um único caractere, com ou sem DV correto. */
export function cnpjRaizPlaceholder(valor: string | null | undefined) {
    return /^([0-9A-Z])\1{11}$/.test(normalizarCnpj(valor).slice(0, 12));
}
