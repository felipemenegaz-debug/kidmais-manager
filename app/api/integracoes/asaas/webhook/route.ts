import { after } from 'next/server';
import { withTransaction } from '@/lib/db/postgres';
import { consumirLimite } from '@/lib/autenticacao/service';
import { ipDaRequisicao } from '@/lib/acessos/http';
import { receberWebhookAsaas } from '@/lib/assinatura/webhook-asaas';
import { processarEventoAgendado } from '@/lib/assinatura/cobranca-padrao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Webhook público do Asaas (sandbox). Token em tempo constante, corpo ≤ 64 KB, só ids gravados, 200 rápido. */
export async function POST(request: Request) {
    try {
        return await receberWebhookAsaas(request, {
            env: process.env,
            ip: ipDaRequisicao(request),
            withTransaction,
            consumirLimite,
            agendar: (id) => after(() => processarEventoAgendado(id)),
        });
    }
    catch (error) {
        // Sem 200 o provedor reentrega o mesmo evento (mesmo id): nada se perde.
        console.error('[Asaas webhook] falha ao registrar', error instanceof Error ? error.name : typeof error);
        return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
}
