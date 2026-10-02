import { after } from 'next/server';
import { receiveGupshupWebhook } from '@/lib/integracoes/gupshup/webhook';
import { entradaGupshup } from '@/lib/whatsapp/atendimento/core';
import { receberEntrada, receberStatus } from '@/lib/whatsapp/atendimento/service';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    return receiveGupshupWebhook(request, {
        GUPSHUP_WEBHOOK_SECRET: process.env.GUPSHUP_WEBHOOK_SECRET,
        KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV,
        RENDER: process.env.RENDER,
    }, (event) => {
        after(() => { console.info('[Gupshup webhook]', JSON.stringify(event)); });
    }, process.env.WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED === 'true' ? async (raw, event) => {
        // Formato fora do contrato (outro app, versão ou campos): retry não corrige; confirma sem persistir.
        if (event.eventType === 'message') { const entrada = entradaGupshup(raw); if (entrada) await receberEntrada(entrada); }
        else await receberStatus(raw);
    } : undefined);
}
