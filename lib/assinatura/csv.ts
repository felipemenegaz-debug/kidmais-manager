/** CSV para planilhas brasileiras (E9): separador ;, BOM UTF-8 e células que não viram fórmula. Sem dependências. */
export const BOM = String.fromCharCode(0xfeff);

/**
 * Início que uma planilha pode interpretar como fórmula: =, +, -, @ (também nas formas de largura total ＝＋－＠),
 * depois de espaços ou tabulações iniciais, ou tabulação/CR logo no começo.
 */
const FORMULA = /^(?:[\t\r]|[\s　]*[=+\-@＝＋－＠])/;

/**
 * Célula CSV (separador ;) com aspas e neutralização de fórmula para planilhas (apóstrofo na frente).
 * `neutralizar = false` só para valores que não são texto livre (números, datas, uuid, booleanos): um número negativo
 * continua número na planilha e o valor exportado fica idêntico ao do banco.
 */
export function celula(valor: unknown, neutralizar = true): string {
    if (valor === null || valor === undefined)
        return '';
    let texto = String(valor);
    if (neutralizar && FORMULA.test(texto))
        texto = `'${texto}`;
    return /[";\r\n]/.test(texto) || texto !== texto.trim() ? `"${texto.replace(/"/g, '""')}"` : texto;
}
/** Uma linha CSV, sem o fim de linha. `neutralizarColuna[i] === false` desliga a neutralização na coluna i. */
export function linhaCsv(valores: readonly unknown[], neutralizarColuna?: readonly boolean[]): string {
    return valores.map((v, i) => celula(v, neutralizarColuna?.[i] !== false)).join(';');
}
/** Arquivo CSV inteiro: BOM, cabeçalho e linhas separados por CRLF, terminando em CRLF. */
export function csv(cabecalho: readonly string[], linhas: readonly unknown[][], neutralizarColuna?: readonly boolean[]): string {
    return `${BOM}${[linhaCsv(cabecalho), ...linhas.map((l) => linhaCsv(l, neutralizarColuna))].join('\r\n')}\r\n`;
}
