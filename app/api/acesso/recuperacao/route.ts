import { after, type NextRequest } from 'next/server';
import { verificarOrigem } from '@/lib/http/admin-crm-api';
import { contextoDaRequisicao, falhar, lerJson, responder } from '@/lib/acessos/http';
import { MENSAGEM_PEDIDO_PUBLICO, processarPedidoPublico, validarPedidoPublico } from '@/lib/acessos/recuperacao';
import { exigirRecuperacaoPublicaAtiva } from '@/lib/acessos/disponibilidade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pedido público de recuperação. A resposta é a MESMA para qualquer e-mail válido e sai antes do processamento
 * (`after`): nem o conteúdo nem o tempo de resposta revelam se a conta existe.
 */
export async function POST(request: NextRequest) {
    try {
        verificarOrigem(request);
        const input = validarPedidoPublico(await lerJson(request));
        exigirRecuperacaoPublicaAtiva();
        const ctx = contextoDaRequisicao(request);
        after(async () => {
            try {
                await processarPedidoPublico(input, ctx);
            }
            catch (error) {
                console.error('[acessos] falha ao processar pedido de recuperação', error instanceof Error ? error.name : typeof error);
            }
        });
        return responder({ ok: true, data: { mensagem: MENSAGEM_PEDIDO_PUBLICO } }, 202);
    }
    catch (error) {
        return falhar(error);
    }
}
