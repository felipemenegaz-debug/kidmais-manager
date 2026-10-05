import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { arquivarPronta, favoritarPronta, listarProntas, prepararRascunho, salvarPronta } from '@/lib/whatsapp/atendimento/prontas-servico';
import { respostaDeErroAtendimento } from '@/lib/whatsapp/atendimento/erros';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mensagens prontas da equipe. Nenhuma ação aqui envia mensagem: "rascunho" só devolve o texto para revisão.
const pedidoSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('salvar'), pronta: z.unknown() }).strict(),
  z.object({ acao: z.literal('arquivar'), id: z.uuid(), versao: z.number().int().nonnegative() }).strict(),
  z.object({ acao: z.literal('favoritar'), id: z.uuid(), favorita: z.boolean() }).strict(),
  z.object({ acao: z.literal('rascunho'), id: z.uuid(), conversaId: z.uuid() }).strict(),
]);
const resposta = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function erro(error: unknown) { const r = respostaDeErroAtendimento(error); return resposta(r.corpo, r.status); }

export async function GET(request: NextRequest) {
  try { const sessao = await exigirApiAdminCrmDisponivel(request); return resposta({ ok: true, data: await listarProntas(sessao) }); } catch (e) { return erro(e); }
}
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const pedido = pedidoSchema.safeParse(await request.json());
    if (!pedido.success) return resposta({ ok: false, erro: 'Confira os campos.', codigo: 'DADOS_INVALIDOS' }, 400);
    const p = pedido.data;
    if (p.acao === 'salvar') return resposta({ ok: true, data: await salvarPronta(sessao, p.pronta) });
    if (p.acao === 'arquivar') { await arquivarPronta(sessao, p); return resposta({ ok: true }); }
    if (p.acao === 'favoritar') { await favoritarPronta(sessao, p); return resposta({ ok: true }); }
    return resposta({ ok: true, data: await prepararRascunho(sessao, p) });
  } catch (e) { return erro(e); }
}
