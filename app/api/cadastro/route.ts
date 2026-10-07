import { after, type NextRequest } from 'next/server';
import { verificarOrigem } from '@/lib/http/admin-crm-api';
import { contextoDaRequisicao, falhar, lerJson, responder } from '@/lib/acessos/http';
import { exigirCadastroAtivo, MENSAGEM_PEDIDO_CADASTRO, processarPedidoCadastro, situacaoCadastro, validarPedidoCadastro } from '@/lib/cadastro/publico';
import { versaoVigente } from '@/lib/cadastro/documentos-legais';
import { duracaoTesteDias, precoDoCiclo } from '@/lib/assinatura/configuracao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Situação pública do cadastro: aberto ou não, versões vigentes dos documentos, duração do teste e preços configurados. */
export async function GET() {
    try {
        const s = situacaoCadastro();
        let precos: { MENSAL: number | null; ANUAL: number | null } | null = null;
        let testeDias: number | null = null;
        try {
            precos = { MENSAL: precoDoCiclo('MENSAL'), ANUAL: precoDoCiclo('ANUAL') };
            testeDias = duracaoTesteDias();
        }
        catch {
            // Configuração comercial inválida: a página mostra "a definir", nunca um valor inventado.
        }
        return responder({ ok: true, data: { ativo: s.ativo, testeDias, precos, termos: versaoVigente('TERMOS_USO').versao, privacidade: versaoVigente('PRIVACIDADE').versao } });
    }
    catch (error) {
        return falhar(error);
    }
}

/**
 * Pedido de conta. A resposta é a MESMA para qualquer e-mail válido e sai antes do processamento (`after`): nem o
 * conteúdo nem o tempo revelam se a conta já existe.
 */
export async function POST(request: NextRequest) {
    try {
        verificarOrigem(request);
        const input = validarPedidoCadastro(await lerJson(request));
        exigirCadastroAtivo();
        const ctx = contextoDaRequisicao(request);
        after(async () => {
            try {
                await processarPedidoCadastro(input, ctx);
            }
            catch (error) {
                console.error('[cadastro] falha ao processar pedido', error instanceof Error ? error.name : typeof error);
            }
        });
        return responder({ ok: true, data: { mensagem: MENSAGEM_PEDIDO_CADASTRO } }, 202);
    }
    catch (error) {
        return falhar(error);
    }
}
