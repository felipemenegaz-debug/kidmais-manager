import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { isClienteServiceError } from '@/lib/clientes/services/errors';
import { respostaDeErroAtendimento } from '@/lib/whatsapp/atendimento/erros';
import {
  configurarRetencao, definirExpiracaoArquivo, excluirConversaAPedido, reativarArquivo, revogarArquivo, situacaoPrivacidade, trocarLinkArquivo,
} from '@/lib/whatsapp/atendimento/privacidade';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Privacidade do atendimento (12/10/2026): leitura e ações da Gestão da empresa ATIVA da sessão — não depende de ela ser
 * a piloto do bot. Escritas exigem senha confirmada há no máximo 5 minutos (a tela pede antes) e confirmação digitada nas
 * irreversíveis (excluir, revogar).
 */
const data = z.iso.datetime({ offset: true });
const acao = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('excluir_conversa'), conversaId: z.uuid(), motivo: z.enum(['PEDIDO_DO_TITULAR', 'DECISAO_DA_EMPRESA']), confirmacao: z.literal('EXCLUIR') }).strict(),
  z.object({ acao: z.literal('retencao'), prazoDias: z.number().int().min(1).max(3650).nullable() }).strict(),
  z.object({ acao: z.literal('revogar'), arquivoId: z.uuid(), confirmacao: z.literal('REVOGAR') }).strict(),
  z.object({ acao: z.literal('trocar_link'), arquivoId: z.uuid() }).strict(),
  z.object({ acao: z.literal('expiracao'), arquivoId: z.uuid(), expiraEm: z.union([z.literal('agora'), data]) }).strict(),
  z.object({ acao: z.literal('reativar'), arquivoId: z.uuid(), expiraEm: data.nullable() }).strict(),
]);
const resposta = (corpo: unknown, status = 200) => NextResponse.json(corpo, { status, headers: { 'Cache-Control': 'no-store' } });
function erro(e: unknown) {
  if (isClienteServiceError(e)) return resposta({ ok: false, erro: e.message, codigo: e.code }, e.httpStatus);
  // Sem vínculo comprovado com a empresa ativa: acesso negado (nunca 503).
  if ((e as { code?: unknown })?.code === 'TENANT_NAO_COMPROVADO') return resposta({ ok: false, erro: 'Seu acesso não inclui esta empresa.', codigo: 'ATENDIMENTO_SEM_ACESSO' }, 403);
  const r = respostaDeErroAtendimento(e);
  return resposta(r.corpo, r.status);
}
export async function GET(request: NextRequest) {
  try { const sessao = await exigirApiAdminCrmDisponivel(request); return resposta({ ok: true, data: await situacaoPrivacidade(sessao) }); }
  catch (e) { return erro(e); }
}
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const pedido = acao.safeParse(await request.json());
    if (!pedido.success) return resposta({ ok: false, erro: 'Confira os campos.', codigo: 'DADOS_INVALIDOS' }, 400);
    const p = pedido.data;
    switch (p.acao) {
      case 'excluir_conversa': return resposta({ ok: true, data: await excluirConversaAPedido(sessao, { conversaId: p.conversaId, motivo: p.motivo }) });
      case 'retencao': await configurarRetencao(sessao, { prazoDias: p.prazoDias }); return resposta({ ok: true });
      case 'revogar': return resposta({ ok: true, data: await revogarArquivo(sessao, { arquivoId: p.arquivoId }) });
      case 'trocar_link': await trocarLinkArquivo(sessao, { arquivoId: p.arquivoId }); return resposta({ ok: true });
      case 'expiracao': return resposta({ ok: true, data: await definirExpiracaoArquivo(sessao, { arquivoId: p.arquivoId, expiraEm: p.expiraEm }) });
      case 'reativar': await reativarArquivo(sessao, { arquivoId: p.arquivoId, expiraEm: p.expiraEm }); return resposta({ ok: true });
    }
  } catch (e) { return erro(e); }
}
