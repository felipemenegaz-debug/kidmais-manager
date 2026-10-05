import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { isClienteServiceError } from '@/lib/clientes/services/errors';
import { PacoteAdminError } from '@/lib/comercial/pacotes-admin';
import { listarAtendimento, controlarAtendimento, salvarConfiguracao } from '@/lib/whatsapp/atendimento/service';
import { respostaDeErroAtendimento } from '@/lib/whatsapp/atendimento/erros';
import { estadoIaAtendimento } from '@/app/api/admin/inteligencia/whatsapp/modelo';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const controle = z.object({ acao: z.enum(['assumir','retomar','encerrar','enviar']), conversaId: z.uuid(), versao: z.number().int().nonnegative(), texto: z.string().trim().min(1).max(4000).optional() }).strict();
const resposta = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function erro(error: unknown) {
  if (isClienteServiceError(error) || error instanceof PacoteAdminError) return resposta({ok:false,erro:error.message,codigo:error.code},error.httpStatus);
  const r = respostaDeErroAtendimento(error);
  return resposta(r.corpo, r.status);
}
export async function GET(request: NextRequest) {
  try { const sessao = await exigirApiAdminCrmDisponivel(request); const id = request.nextUrl.searchParams.get('conversaId'); if (id && !z.uuid().safeParse(id).success) return resposta({ ok: false, erro: 'Conversa inválida.' }, 400); return resposta({ ok: true, data: { ...await listarAtendimento(sessao, id ?? undefined), ia: estadoIaAtendimento() } }); } catch (e) { return erro(e); }
}
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request); const json: unknown = await request.json();
    const config = z.object({ acao: z.literal('configurar'), configuracao: z.unknown() }).strict().safeParse(json);
    if (config.success) { await salvarConfiguracao(sessao, config.data.configuracao); return resposta({ ok: true }); }
    const pedido = controle.safeParse(json); if (!pedido.success) return resposta({ ok: false, erro: 'Confira os campos.' }, 400);
    if ((pedido.data.acao === 'enviar' || pedido.data.acao === 'retomar') && !estadoIaAtendimento().ia) throw new Error('ATENDIMENTO_IA_DESLIGADA');
    // Encerrar devolve quantas respostas pendentes foram canceladas na mesma transação (a tela informa).
    return resposta({ ok: true, data: await controlarAtendimento(sessao, pedido.data) });
  } catch (e) { return erro(e); }
}
