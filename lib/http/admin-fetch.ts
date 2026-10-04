'use client';
import {
    cancelarRenovacaoDeSessao, concluirRenovacaoDeSessao, contextoMudou, guardarAvisoDeContexto, iniciarRenovacaoDeSessao,
    registrarContextoEmpresa, reiniciarContextoEmpresa,
} from './contexto-empresa-cliente';

type InfoSessao = { ok?: boolean; data?: { usuarioId?: string | null; sessaoId?: string; csrf?: string; contexto?: { empresaAtual?: { id: string } | null } } };

export const AVISO_RESULTADO_INCERTO = 'Resultado incerto: a operação pode ou não ter sido concluída. Confira antes de repetir — nada é reenviado automaticamente.';

async function lerSessao(): Promise<InfoSessao> {
    return (await fetch('/api/admin/autenticacao', { cache: 'no-store' })).json();
}
const empresaDe = (info: InfoSessao) => info.data?.contexto?.empresaAtual?.id ?? null;

/**
 * fetch das telas administrativas: CSRF + sessão da página (x-kidmais-sessao). Nunca repete uma requisição.
 * Se a empresa/sessão mudar no meio do caminho, descarta a página e deixa um aviso com o resultado REAL:
 *   - mudou antes do envio, ou o servidor recusou pelo contexto antigo → nada foi alterado;
 *   - escrita respondida com sucesso, contexto mudou depois → concluída (dados antigos descartados);
 *   - escrita sem resposta (conexão) ou erro 5xx → resultado incerto.
 */
export async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const escrita = !['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());
    const info = await lerSessao();
    if (!info.ok || !info.data?.usuarioId) {
        if (escrita) guardarAvisoDeContexto('Sua sessão terminou antes do envio. Nada foi enviado.');
        // Limpa a página administrativa em memória quando a sessão expira; helper fora de React.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign('/admin/login');
        throw Error('Faça login para continuar.');
    }
    if (!registrarContextoEmpresa(info.data.sessaoId!, empresaDe(info), escrita ? 'A empresa ativa ou a sessão mudou antes do envio. Nada foi enviado.' : undefined))
        throw Error('A empresa ou a sessão mudou. Atualizando a página.');
    const headers = new Headers(init.headers);
    headers.set('x-kidmais-sessao', info.data.sessaoId!);
    headers.set('x-csrf-token', info.data.csrf ?? '');
    let resposta: Response;
    try {
        resposta = await fetch(input, { ...init, headers, cache: 'no-store' });
    }
    catch (erro) {
        if (escrita) throw Error(AVISO_RESULTADO_INCERTO);
        throw erro;
    }
    if (resposta.status === 409) {
        const corpo = await resposta.clone().json().catch(() => null) as { codigo?: string } | null;
        if (corpo?.codigo === 'AUTENTICACAO_ADMINISTRATIVA') {
            // O servidor recusou ANTES de executar: a página usava uma sessão/empresa que já não é a atual.
            reiniciarContextoEmpresa('A empresa ativa ou a sessão mudou antes de a operação ser processada. Nada foi alterado.');
            throw Error('A empresa ou a sessão mudou. Nada foi alterado.');
        }
    }
    // Reautenticação e troca de senha renovam a sessão e são confirmadas por quem as chamou.
    const url = String(input);
    if (url.includes('/api/admin/autenticacao') || url.includes('/api/admin/perfil/senha'))
        return resposta;
    let atual: InfoSessao | null = null;
    try {
        atual = await lerSessao();
    }
    catch {
        return resposta;
    }
    const encerrada = !atual?.ok || !atual.data?.usuarioId;
    if (encerrada || contextoMudou(atual.data!.sessaoId!, empresaDe(atual))) {
        const aviso = !escrita
            ? 'A empresa ativa ou a sessão mudou. Os dados da tela anterior foram descartados.'
            : resposta.ok
                ? 'A operação foi concluída antes da mudança de empresa ou de sessão. Os dados da tela anterior foram descartados; confira o resultado.'
                : resposta.status >= 500 ? AVISO_RESULTADO_INCERTO
                    : 'A operação não foi concluída: o servidor recusou. Os dados da tela anterior foram descartados.';
        reiniciarContextoEmpresa(aviso, encerrada ? '/admin/login' : undefined);
        throw Error(aviso);
    }
    return resposta;
}

export type ResultadoReautenticacao = { ok: true } | { ok: false; erro: string; senhaIncorreta: boolean };

/**
 * Reautenticação da própria página: confirma a senha, recebe do servidor a renovação (sessão anterior → nova) e só
 * então aceita a sessão nova. Senha incorreta mantém sessão, contexto e formulário intactos.
 */
export async function reautenticarSessao(senha: string): Promise<ResultadoReautenticacao> {
    const inicial = await lerSessao();
    if (!inicial.ok || !inicial.data?.usuarioId)
        return { ok: false, erro: 'Sua sessão terminou. Entre novamente.', senhaIncorreta: false };
    if (!registrarContextoEmpresa(inicial.data.sessaoId!, empresaDe(inicial)))
        return { ok: false, erro: 'A empresa ou a sessão mudou. Atualizando a página.', senhaIncorreta: false };
    iniciarRenovacaoDeSessao();
    let res: Response;
    try {
        res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'reautenticar', senha }) });
    }
    catch (erro) {
        cancelarRenovacaoDeSessao();
        return { ok: false, erro: erro instanceof Error ? erro.message : 'Falha de conexão. Tente novamente.', senhaIncorreta: false };
    }
    const corpo = await res.json().catch(() => null) as { ok?: boolean; erro?: string; data?: { renovacao?: { anterior: string; atual: string } | null } } | null;
    if (!res.ok || !corpo?.ok) {
        cancelarRenovacaoDeSessao();
        return { ok: false, erro: res.status === 401 ? 'Senha incorreta.' : (corpo?.erro ?? `Não foi possível confirmar a senha (HTTP ${res.status}).`), senhaIncorreta: res.status === 401 };
    }
    return confirmarRenovacao(corpo.data?.renovacao);
}

/** Conclui uma renovação devolvida pelo servidor (reautenticação ou troca de senha). */
export async function confirmarRenovacao(renovacao: { anterior: string; atual: string } | null | undefined): Promise<ResultadoReautenticacao> {
    const depois = await lerSessao().catch(() => null);
    if (!concluirRenovacaoDeSessao(renovacao, depois?.data?.sessaoId ?? null, depois ? empresaDe(depois) : null))
        return { ok: false, erro: 'A sessão mudou de forma inesperada. Atualizando a página.', senhaIncorreta: false };
    return { ok: true };
}

export { iniciarRenovacaoDeSessao, cancelarRenovacaoDeSessao };
