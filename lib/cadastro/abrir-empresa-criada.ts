/**
 * Depois de criar a empresa, torna-a a empresa ativa da sessão. Falha HTTP, corpo inválido ou exceção de rede dão falso:
 * a empresa já existe, então a tela não pode oferecer repetir o cadastro nem afirmar que a seleção deu certo.
 */
export async function abrirEmpresaCriada(postar: (url: string, corpo: unknown) => Promise<{ status: number; corpo: { ok?: boolean } | null }>, empresaId: string) {
    try {
        const r = await postar('/api/admin/autenticacao', { acao: 'selecionar-empresa', empresaId });
        return r.status >= 200 && r.status < 300 && r.corpo?.ok === true;
    }
    catch {
        return false;
    }
}
