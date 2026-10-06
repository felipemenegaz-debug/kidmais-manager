'use client';
import { adminFetch } from '@/lib/http/admin-fetch';
import { guardarAvisoDeContexto } from '@/lib/http/contexto-empresa-cliente';

export const AVISO_SAIDA_NAO_CONFIRMADA = 'Não foi possível confirmar o encerramento da sessão no servidor. Se este dispositivo é compartilhado, entre de novo e saia novamente.';

/**
 * Saída a partir de qualquer tela: Admin, painel do desenvolvedor, perfil, seleção vazia ou estado de erro.
 * Tenta encerrar a sessão no servidor; se a confirmação falhar (rede, CSRF, sessão já encerrada por outro motivo),
 * ainda assim leva ao login com navegação completa — ninguém fica preso numa tela sem saída — e deixa o aviso do
 * resultado real para a tela de login. Nunca repete o pedido.
 */
export async function sairDaSessao(): Promise<boolean> {
    let encerrada = false;
    try {
        const res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'logout' }) });
        encerrada = res.ok;
        if (!res.ok)
            guardarAvisoDeContexto(AVISO_SAIDA_NAO_CONFIRMADA);
    }
    catch (erro) {
        // Sessão já encerrada: o helper já mandou ao login e nada precisa ser avisado. Qualquer outra falha avisa.
        if (!(erro instanceof Error && /login para continuar/i.test(erro.message)))
            guardarAvisoDeContexto(AVISO_SAIDA_NAO_CONFIRMADA);
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/admin/login');
    return encerrada;
}
