import { NextRequest, NextResponse } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api.ts';
import { consultarConfiguracaoWhatsapp } from '@/lib/whatsapp/onboarding.service.ts';
import { isWhatsappOnboardingError } from '@/lib/whatsapp/errors.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function resposta(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    return resposta({ ok: true, data: await consultarConfiguracaoWhatsapp(sessao) });
  } catch (error) {
    if (isWhatsappOnboardingError(error)) return resposta({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus);
    return resposta({ ok: false, erro: 'Não foi possível consultar a configuração do WhatsApp.' }, 500);
  }
}
