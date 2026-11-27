import { NextRequest, NextResponse } from 'next/server';
import { isClienteServiceError } from '@/lib/clientes/services/errors';
import { PacoteAdminError } from '@/lib/comercial/pacotes-admin';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { respostaDeErroAtendimento } from '@/lib/whatsapp/atendimento/erros';
import { perguntasSemFonte } from '@/lib/whatsapp/atendimento/sem-fonte';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resposta = (corpo: unknown, status = 200) => NextResponse.json(corpo, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    return resposta({ ok: true, data: await perguntasSemFonte(sessao) });
  } catch (erro) {
    if (isClienteServiceError(erro) || erro instanceof PacoteAdminError) {
      return resposta({ ok: false, erro: erro.message, codigo: erro.code }, erro.httpStatus);
    }
    const r = respostaDeErroAtendimento(erro);
    return resposta(r.corpo, r.status);
  }
}
