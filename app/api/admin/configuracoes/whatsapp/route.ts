import { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api.ts';
import { consultarConfiguracaoWhatsapp } from '@/lib/whatsapp/onboarding.service.ts';
import { erroWhatsapp, respostaWhatsapp } from '@/lib/whatsapp/http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    return respostaWhatsapp({ ok: true, data: await consultarConfiguracaoWhatsapp(sessao) });
  } catch (error) {
    return erroWhatsapp(error, 'Não foi possível consultar a configuração do WhatsApp.');
  }
}
