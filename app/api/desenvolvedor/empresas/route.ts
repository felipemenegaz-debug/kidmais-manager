import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { lerJson } from '@/lib/acessos/http';
import { listarEmpresas, previaProvisionamento, provisionarContratante } from '@/lib/desenvolvedor/empresas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const p = request.nextUrl.searchParams;
    return rotaDesenvolvedor(request, (sessao) => listarEmpresas(sessao, {
        busca: p.get('busca') ?? undefined, situacao: p.get('situacao') ?? undefined, pagina: p.get('pagina') ?? undefined,
    }));
}

const corpoSchema = z.object({ acao: z.enum(['previa', 'provisionar']), dados: z.unknown() }).strict();

/** `previa` não escreve nada; `provisionar` exige `dados.confirmar = true` e reautenticação recente. */
export async function POST(request: NextRequest) {
    return rotaDesenvolvedor(request, async (sessao, ctx) => {
        const corpo = corpoSchema.parse(await lerJson(request));
        return corpo.acao === 'previa' ? previaProvisionamento(sessao, corpo.dados) : provisionarContratante(sessao, corpo.dados, ctx);
    });
}
