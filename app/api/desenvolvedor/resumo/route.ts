import type { NextRequest } from 'next/server';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { resumoPainel } from '@/lib/desenvolvedor/resumo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    return rotaDesenvolvedor(request, (sessao) => resumoPainel(sessao));
}
