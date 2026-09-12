import { NextRequest, NextResponse } from 'next/server';
import { exigirApiAdminCrmDisponivel, tokenAdmin } from '@/lib/http/admin-crm-api.ts';
import { concluirOnboardingWhatsapp, contextoWhatsapp } from '@/lib/whatsapp/onboarding.service.ts';
import { isWhatsappOnboardingError } from '@/lib/whatsapp/errors.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function resposta(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }

export async function POST(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const body = await request.json().catch(() => null);
    const data = await concluirOnboardingWhatsapp(body, tokenAdmin(request), contextoWhatsapp(request.headers.get('user-agent')));
    return resposta({ ok: true, data });
  } catch (error) {
    if (isWhatsappOnboardingError(error)) return resposta({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus);
    return resposta({ ok: false, erro: 'Não foi possível concluir a conexão com a Meta.' }, 500);
  }
}
