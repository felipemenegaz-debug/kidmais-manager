import { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel, tokenAdmin } from '@/lib/http/admin-crm-api.ts';
import { concluirOnboardingWhatsapp, contextoWhatsapp } from '@/lib/whatsapp/onboarding.service.ts';
import { erroWhatsapp, respostaWhatsapp } from '@/lib/whatsapp/http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const body = await request.json().catch(() => null);
    const data = await concluirOnboardingWhatsapp(body, tokenAdmin(request), contextoWhatsapp(request.headers.get('user-agent')));
    return respostaWhatsapp({ ok: true, data });
  } catch (error) {
    return erroWhatsapp(error, 'Não foi possível concluir a conexão com a Meta.');
  }
}
