import type { NextRequest } from 'next/server';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { renovacoesEmRevisaoPainel } from '@/lib/desenvolvedor/cobranca';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Desenvolvedor: renovações Fundador em REVISAO ou paradas (somente leitura, sem dado pessoal). */
export async function GET(request: NextRequest) {
    return rotaDesenvolvedor(request, (sessao) => renovacoesEmRevisaoPainel(sessao));
}
