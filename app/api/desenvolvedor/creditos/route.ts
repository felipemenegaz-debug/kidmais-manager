import type { NextRequest } from 'next/server';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { lerJson } from '@/lib/acessos/http';
import { filaCreditos, operarCreditos } from '@/lib/desenvolvedor/creditos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Operador da plataforma: pedidos de créditos em revisão, devoluções abertas e cobranças em disputa/duplicadas. */
export async function GET(request: NextRequest) {
    return rotaDesenvolvedor(request, (sessao) => filaCreditos(sessao));
}

/** Operador da plataforma: cortesia, conclusão manual de devolução, devolução pelo atendimento e simulação de corte (auditado). */
export async function POST(request: NextRequest) {
    return rotaDesenvolvedor(request, async (sessao, ctx) => operarCreditos(sessao, await lerJson(request), ctx));
}
