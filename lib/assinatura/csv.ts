/** CSV para planilhas brasileiras (E9): separador ;, BOM UTF-8 e células que não viram fórmula. Sem dependências. */
const BOM = String.fromCharCode(0xfeff);

/** Célula CSV (separador ;) com aspas e neutralização de fórmula (=, +, -, @, tab, CR) para planilhas. */
export function celula(valor: unknown): string {
    if (valor === null || valor === undefined)
        return '';
    let texto = String(valor);
    if (/^[=+\-@\t\r]/.test(texto))
        texto = `'${texto}`;
    return /[";\r\n]/.test(texto) || texto !== texto.trim() ? `"${texto.replace(/"/g, '""')}"` : texto;
}
export function csv(cabecalho: readonly string[], linhas: readonly unknown[][]): string {
    return `${BOM}${[cabecalho, ...linhas].map((l) => l.map(celula).join(';')).join('\r\n')}\r\n`;
}
