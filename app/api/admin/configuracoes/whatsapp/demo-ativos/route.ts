import { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api.ts';
import { exigirRequisicaoSemParametros, travaDemoAtivosTeste, verificarAtivosTeste } from '@/lib/whatsapp/demo-ativos-teste.ts';
import { WhatsappOnboardingError } from '@/lib/whatsapp/errors.ts';
import { erroWhatsapp, respostaWhatsapp } from '@/lib/whatsapp/http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Verificação de ativos de teste da Meta (somente leitura). Fora da trava de staging, a rota não existe (404). */
export async function POST(request: NextRequest) {
  try {
    if (!travaDemoAtivosTeste().liberada) throw new WhatsappOnboardingError('NAO_ENCONTRADO', 'Recurso não encontrado.', 404);
    const sessao = await exigirApiAdminCrmDisponivel(request);
    exigirRequisicaoSemParametros(request.nextUrl.search, await request.text());
    return respostaWhatsapp({ ok: true, data: await verificarAtivosTeste(sessao) });
  } catch (error) {
    return erroWhatsapp(error, 'Não foi possível verificar os ativos de teste.');
  }
}
