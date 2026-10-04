'use client';

let contexto: string | null = null;
export function registrarContextoEmpresa(sessaoId: string, empresaId: string | null) {
    const novo = `${sessaoId}:${empresaId ?? ''}`;
    if (contexto !== null && contexto !== novo) {
        reiniciarContextoEmpresa();
        return false;
    }
    contexto = novo;
    return true;
}
export function reiniciarContextoEmpresa() {
    // Navegação completa descarta o Router Cache, estados React, conversas/rascunhos e pedidos da página antiga.
    // Nenhum dado de negócio é guardado no sinal entre abas.
    window.location.replace('/admin/dashboard');
}
