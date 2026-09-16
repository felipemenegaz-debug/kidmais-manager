import { after } from 'next/server';
import { receiveGupshupWebhook } from '@/lib/integracoes/gupshup/webhook';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    return receiveGupshupWebhook(request, {
        GUPSHUP_WEBHOOK_SECRET: process.env.GUPSHUP_WEBHOOK_SECRET,
        KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV,
        RENDER: process.env.RENDER,
    }, (event) => {
        after(() => { console.info('[Gupshup webhook]', JSON.stringify(event)); });
    });
}
