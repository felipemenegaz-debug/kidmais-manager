import type { NextRequest } from 'next/server';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { lerJson } from '@/lib/acessos/http';
import { criarInteressada, listarInteressadas } from '@/lib/desenvolvedor/interessadas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const p = request.nextUrl.searchParams;
    return rotaDesenvolvedor(request, (sessao) => listarInteressadas(sessao, {
        busca: p.get('busca') ?? undefined, status: p.get('status') ?? undefined, pagina: p.get('pagina') ?? undefined,
    }));
}

export async function POST(request: NextRequest) {
    return rotaDesenvolvedor(request, async (sessao, ctx) => criarInteressada(sessao, await lerJson(request), ctx), 201);
}
