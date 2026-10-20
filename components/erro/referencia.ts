/**
 * Código que a pessoa informa ao suporte para achar o erro nos logs. Erro de Server Component chega ao cliente só com
 * o `digest` (a mensagem original não sai do servidor em produção); erro do próprio navegador não tem digest e fica
 * sem código, em vez de inventar um que não existe em log nenhum.
 */
export function referenciaDoErro(erro: { digest?: unknown } | null | undefined): string | null {
    const digest = erro?.digest;
    if (typeof digest !== 'string') return null;
    const limpo = digest.trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(limpo) ? limpo : null;
}
