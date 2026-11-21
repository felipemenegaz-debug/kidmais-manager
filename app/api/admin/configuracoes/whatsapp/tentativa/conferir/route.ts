import { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel, tokenAdmin } from '@/lib/http/admin-crm-api.ts';
import { conferirTentativaWhatsapp, contextoWhatsapp } from '@/lib/whatsapp/onboarding.service.ts';
import { erroWhatsapp, respostaWhatsapp } from '@/lib/whatsapp/http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Confere o resultado de uma conclusão sem resposta legível (fecha a tentativa vencida; nunca toca na credencial). */
export async function POST(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const body = await request.json().catch(() => null);
    const data = await conferirTentativaWhatsapp(body, tokenAdmin(request), contextoWhatsapp(request.headers.get('user-agent')));
    return respostaWhatsapp({ ok: true, data });
  } catch (error) {
    return erroWhatsapp(error, 'Não foi possível conferir o resultado.');
  }
}
