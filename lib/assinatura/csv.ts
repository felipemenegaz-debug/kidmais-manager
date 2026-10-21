/** CSV para planilhas brasileiras (E9): separador ;, BOM UTF-8 e células que não viram fórmula. Sem dependências. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Célula CSV (separador ;) com aspas e neutralização de fórmula (=, +, -, @, tab, CR) para planilhas.
 * `neutralizar = false` só para valores que não são texto livre (números, datas, uuid, booleanos): um número negativo
 * continua número na planilha e o valor exportado fica idêntico ao do banco.
 */
export function celula(valor: unknown, neutralizar = true): string {
    if (valor === null || valor === undefined)
        return '';
    let texto = String(valor);
    if (neutralizar && /^[=+\-@\t\r]/.test(texto))
        texto = `'${texto}`;
    return /[";\r\n]/.test(texto) || texto !== texto.trim() ? `"${texto.replace(/"/g, '""')}"` : texto;
}
/** `neutralizarColuna[i] === false` desliga a neutralização de fórmula na coluna i (padrão: todas neutralizadas). */
export function csv(cabecalho: readonly string[], linhas: readonly unknown[][], neutralizarColuna?: readonly boolean[]): string {
    const corpo = linhas.map((l) => l.map((v, i) => celula(v, neutralizarColuna?.[i] !== false)).join(';'));
    return `${BOM}${[cabecalho.map((c) => celula(c)).join(';'), ...corpo].join('\r\n')}\r\n`;
}
