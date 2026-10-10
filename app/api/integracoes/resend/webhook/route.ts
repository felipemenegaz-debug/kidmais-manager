import { withTransaction } from '@/lib/db/postgres';
import { receberWebhookResend } from '@/lib/assinatura/renovacao-entrega';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Webhook público do Resend (G3): falha de entrega do aviso de renovação Fundador → AVISADA → REVISAO.
 * Desligado (503) sem RESEND_WEBHOOK_SECRET; assinatura Svix obrigatória. Regras em lib/assinatura/renovacao-entrega.ts.
 */
export async function POST(request: Request) {
    try {
        return await receberWebhookResend(request, { env: process.env, withTransaction });
    }
    catch (error) {
        // Sem 2xx o Resend reentrega o mesmo evento: a transição é idempotente.
        console.error('[Resend webhook] falha ao registrar', error instanceof Error ? error.name : typeof error);
        return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
}
