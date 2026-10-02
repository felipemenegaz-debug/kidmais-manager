import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { isClienteServiceError } from '@/lib/clientes/services/errors';
import { PacoteAdminError } from '@/lib/comercial/pacotes-admin';
import { listarAtendimento, controlarAtendimento, salvarConfiguracao } from '@/lib/whatsapp/atendimento/service';
import { estadoIaAtendimento } from '@/app/api/admin/inteligencia/whatsapp/modelo';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const controle = z.object({ acao: z.enum(['assumir','retomar','encerrar','enviar']), conversaId: z.uuid(), versao: z.number().int().nonnegative(), texto: z.string().trim().min(1).max(4000).optional() }).strict();
const resposta = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function erro(error: unknown) {
  if (isClienteServiceError(error) || error instanceof PacoteAdminError) return resposta({ok:false,erro:error.message,codigo:error.code},error.httpStatus);
  if (error instanceof SyntaxError || error instanceof z.ZodError) return resposta({ok:false,erro:'Confira os campos.',codigo:'DADOS_INVALIDOS'},400);
  const code = error instanceof Error && /^ATENDIMENTO_[A-Z_]+$/.test(error.message) ? error.message : 'ATENDIMENTO_INDISPONIVEL';
  const mensagem: Record<string,string> = { ATENDIMENTO_CONTATO_BLOQUEADO: 'Este contato pediu para não receber mensagens.', ATENDIMENTO_DESATUALIZADO: 'A conversa mudou. Atualize antes de continuar.', ATENDIMENTO_ENVIO_EM_ANDAMENTO: 'Uma mensagem está sendo enviada. Aguarde e atualize a conversa.', ATENDIMENTO_JANELA_EXPIRADA: 'A janela de atendimento expirou. Aguarde nova mensagem do cliente.', ATENDIMENTO_ASSUMA_ANTES_DE_ENVIAR: 'Assuma a conversa antes de responder.', ATENDIMENTO_AUTOMACAO_DESLIGADA: 'O piloto ainda não foi ativado no servidor.', ATENDIMENTO_ACESSO_NEGADO: 'Seu perfil não tem acesso a esta ação do atendimento.' };
  const status = code === 'ATENDIMENTO_DESATUALIZADO' || code === 'ATENDIMENTO_ENVIO_EM_ANDAMENTO' ? 409 : code === 'ATENDIMENTO_ACESSO_NEGADO' ? 403 : 503;
  return resposta({ ok: false, erro: mensagem[code] ?? 'Atendimento indisponível ou acesso não autorizado. Confira a configuração do piloto.', codigo: code }, status);
}
export async function GET(request: NextRequest) {
  try { const sessao = await exigirApiAdminCrmDisponivel(request); const id = request.nextUrl.searchParams.get('conversaId'); if (id && !z.uuid().safeParse(id).success) return resposta({ ok: false, erro: 'Conversa inválida.' }, 400); return resposta({ ok: true, data: { ...await listarAtendimento(sessao, id ?? undefined), ia: estadoIaAtendimento() } }); } catch (e) { return erro(e); }
}
export async function POST(request: NextRequest) {
  try { const sessao = await exigirApiAdminCrmDisponivel(request); const json: unknown = await request.json(); const config = z.object({ acao: z.literal('configurar'), configuracao: z.unknown() }).strict().safeParse(json); if (config.success) await salvarConfiguracao(sessao, config.data.configuracao); else { const pedido = controle.safeParse(json); if (!pedido.success) return resposta({ ok: false, erro: 'Confira os campos.' }, 400); await controlarAtendimento(sessao, pedido.data); } return resposta({ ok: true }); } catch (e) { return erro(e); }
}
