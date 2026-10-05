'use client';
import { useSyncExternalStore } from 'react';

/**
 * O token chega no fragmento (#t=...), que não vai ao servidor nem ao Referer. Lido uma vez e removido da barra
 * de endereço para não ficar no histórico visível nem ser copiado por engano.
 */
let lido: string | null | undefined;

export function lerTokenDoFragmento(): string | null {
    if (lido !== undefined)
        return lido;
    const hash = window.location.hash.replace(/^#/, '');
    const token = new URLSearchParams(hash).get('t');
    if (hash)
        window.history.replaceState(null, '', window.location.pathname);
    lido = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
    return lido;
}

const semInscricao = () => () => undefined;
/** Hook: undefined no servidor/hidratação; depois o token (ou null). */
export function useTokenDoFragmento() {
    return useSyncExternalStore(semInscricao, lerTokenDoFragmento, () => undefined);
}

export async function postarPublico<T>(url: string, corpo: unknown): Promise<{ ok: true; data: T } | { ok: false; erro: string; status: number }> {
    try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), cache: 'no-store' });
        const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; erro?: string } | null;
        if (res.ok && json?.ok)
            return { ok: true, data: json.data as T };
        return { ok: false, erro: json?.erro ?? 'Não foi possível concluir.', status: res.status };
    }
    catch {
        return { ok: false, erro: 'Falha de conexão. Tente novamente.', status: 0 };
    }
}
