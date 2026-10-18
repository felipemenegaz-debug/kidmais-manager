import type { NextRequest } from 'next/server';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { lerJson } from '@/lib/acessos/http';
import { filaGeracoesConvites, resolverGeracaoConvite } from '@/lib/desenvolvedor/convites-geracoes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Operador da plataforma: gerações de IA de convites em verificação, tratadas automaticamente e decisões anteriores. */
export async function GET(request: NextRequest) {
    return rotaDesenvolvedor(request, (sessao) => filaGeracoesConvites(sessao));
}

/** Operador da plataforma: decide uma geração INCERTA (senha recente, auditado). Buffet e cliente não têm esta ação. */
export async function POST(request: NextRequest) {
    return rotaDesenvolvedor(request, async (sessao, ctx) => resolverGeracaoConvite(sessao, await lerJson(request), ctx));
}
