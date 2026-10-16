import { after } from 'next/server';
import { receberWebhookMeta, verificarWebhookMeta } from '@/lib/integracoes/meta/webhook';
import { receberEventosMeta } from '@/lib/whatsapp/atendimento/meta';
import { recepcaoAtiva } from '@/lib/whatsapp/atendimento/configuracao';
import { opcoesRecepcaoAtendimento } from '@/app/api/admin/inteligencia/whatsapp/automacao';

export const runtime = 'nodejs';

const ambiente = () => ({
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_WEBHOOK_VERIFY_TOKEN: process.env.META_WEBHOOK_VERIFY_TOKEN,
  KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV,
  RENDER: process.env.RENDER,
});

/** Verificação do webhook no painel da Meta (token deste ambiente). */
export async function GET(request: Request) {
  return verificarWebhookMeta(request, ambiente());
}

/**
 * Eventos assinados da Cloud API. Recepção desligada: confirma sem gravar (só a contagem vai ao log). Ligada: grava na
 * empresa dona do número conectado (só a piloto, por enquanto); a chave global da IA vem da composition root, como no
 * webhook do Gupshup.
 */
export async function POST(request: Request) {
  return receberWebhookMeta(request, ambiente(), (resumo) => {
    after(() => { console.info('[Meta webhook]', JSON.stringify(resumo)); });
  }, recepcaoAtiva() ? (eventos) => receberEventosMeta(eventos, opcoesRecepcaoAtendimento()) : undefined);
}
