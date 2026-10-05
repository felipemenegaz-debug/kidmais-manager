import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { politicaAdmin } from '../http/admin-crm-api.ts';
import { consultarSessao } from '../autenticacao/service.ts';
import { db } from '../db/postgres.ts';
import { tabelaAusente } from '../acessos/erros.ts';
import { temConcessaoDesenvolvedor } from './autorizacao.ts';

/**
 * Guarda de servidor de CADA página de /desenvolvedor (chamada no próprio page.tsx: layout não roda de novo na
 * navegação do cliente). Sem sessão → login; sessão sem concessão de desenvolvedor → 404 (a área não é revelada).
 * Os dados vêm das APIs /api/desenvolvedor/*, que repetem a verificação.
 */
export async function exigirDesenvolvedorNaPagina(caminho: string) {
    const h = await headers();
    const host = h.get('host') ?? 'localhost';
    const proto = h.get('x-forwarded-proto') ?? (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https');
    const requisicao = { headers: h, nextUrl: { origin: `${proto}://${host}` } } as unknown as NextRequest;
    let politica: ReturnType<typeof politicaAdmin>;
    try {
        politica = politicaAdmin(requisicao);
    }
    catch {
        notFound();
    }
    const token = (await cookies()).get(politica.cookie)?.value ?? '';
    let sessao: Awaited<ReturnType<typeof consultarSessao>>;
    try {
        sessao = await consultarSessao(token);
    }
    catch {
        redirect(`/admin/login?voltar=${encodeURIComponent(caminho)}`);
    }
    try {
        if (!await temConcessaoDesenvolvedor(db(), sessao.usuario_id))
            notFound();
    }
    catch (error) {
        if (tabelaAusente(error))
            notFound();
        throw error;
    }
    return { usuarioId: sessao.usuario_id, nome: sessao.nome };
}
