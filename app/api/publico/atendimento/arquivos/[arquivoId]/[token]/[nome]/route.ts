import type { NextRequest } from 'next/server';
import { lerArquivoPublico, respostaArquivo } from '@/lib/whatsapp/atendimento/arquivos-publico';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Arquivo da biblioteca do atendimento (foto, vídeo, PDF) para o provedor do WhatsApp baixar: sem sessão, por id + token.
type Contexto = { params: Promise<{ arquivoId: string; token: string; nome: string }> };
async function servir(request: NextRequest, context: Contexto, head: boolean) {
  const { arquivoId, token } = await context.params;
  return respostaArquivo(await lerArquivoPublico(arquivoId, token).catch(() => null), request.headers.get('range'), head);
}
export async function GET(request: NextRequest, context: Contexto) { return servir(request, context, false); }
export async function HEAD(request: NextRequest, context: Contexto) { return servir(request, context, true); }
