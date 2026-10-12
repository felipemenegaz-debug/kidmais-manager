import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { TEMPO_PADRAO, criarSemaforo, lerMultipartLimitado, limitesUpload, type CodigoMultipart } from '@/lib/importacao-contrato/multipart';
import { LIMITE_ARQUIVO } from '@/lib/whatsapp/atendimento/arquivos';
import { exigirGestaoBiblioteca, salvarArquivo } from '@/lib/whatsapp/atendimento/prontas-servico';
import { respostaDeErroAtendimento } from '@/lib/whatsapp/atendimento/erros';
import { definirExpiracaoArquivo, revogarArquivo, trocarLinkArquivo } from '@/lib/whatsapp/atendimento/privacidade';
import { z } from 'zod';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Envio de foto, vídeo ou PDF para a biblioteca (só o representante). Nada é enviado ao cliente aqui. */
const uploads = criarSemaforo(2);
const MENSAGENS: Record<CodigoMultipart, string> = {
  CORPO_GRANDE: 'O arquivo passa do tamanho aceito (foto 5 MB, vídeo 16 MB, PDF 16 MB).', ARQUIVO_GRANDE: 'O arquivo passa do tamanho aceito (foto 5 MB, vídeo 16 MB, PDF 16 MB).',
  PARTES_DEMAIS: 'Envie um arquivo por vez.', CABECALHO_GRANDE: 'Envio inválido.', CAMPO_GRANDE: 'Envie um arquivo por vez.', MULTIPART_INVALIDO: 'Envio inválido.',
  ARQUIVO_AUSENTE: 'Escolha o arquivo.', LEITURA_LENTA: 'O envio demorou demais. Tente de novo.', ENVIO_CANCELADO: 'O envio foi interrompido.',
};
const resposta = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const TIPOS = ['IMAGEM', 'VIDEO', 'DOCUMENTO'] as const;

export async function POST(request: NextRequest) {
  const liberar = uploads.tentar();
  if (!liberar) return resposta({ ok: false, erro: 'Há outro envio em andamento. Tente de novo em instantes.', codigo: 'UPLOADS_SIMULTANEOS' }, 429);
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    // Papel conferido ANTES de ler o corpo: quem não gerencia a biblioteca não ocupa memória com upload.
    await exigirGestaoBiblioteca(sessao);
    const tipo = request.nextUrl.searchParams.get('tipo');
    const tipoEsperado = TIPOS.find((t) => t === tipo);
    const lido = await lerMultipartLimitado(request.body, request.headers.get('content-type'), limitesUpload(Math.max(...Object.values(LIMITE_ARQUIVO))), { ...TEMPO_PADRAO, sinal: request.signal });
    if (!lido.ok) return resposta({ ok: false, erro: MENSAGENS[lido.codigo], codigo: lido.codigo }, lido.status);
    return resposta({ ok: true, data: await salvarArquivo(sessao, { nome: lido.arquivo.nome, bytes: lido.arquivo.bytes, tipoEsperado }) });
  } catch (e) {
    const r = respostaDeErroAtendimento(e);
    return resposta(r.corpo, r.status);
  } finally {
    liberar();
  }
}

/**
 * D3: revogar (apaga o conteúdo, troca o link, arquiva as prontas e cancela a fila; irreversível — confirmação digitada),
 * trocar o link (o anterior para de servir) ou definir a expiração (null = sem expiração). Só o representante.
 */
const acaoArquivo = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('revogar'), arquivoId: z.uuid(), confirmacao: z.literal('REVOGAR') }).strict(),
  z.object({ acao: z.literal('trocar_link'), arquivoId: z.uuid() }).strict(),
  z.object({ acao: z.literal('expiracao'), arquivoId: z.uuid(), expiraEm: z.iso.datetime({ offset: true }).nullable() }).strict(),
]);
export async function PATCH(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const pedido = acaoArquivo.safeParse(await request.json());
    if (!pedido.success) return resposta({ ok: false, erro: 'Confira os campos.', codigo: 'DADOS_INVALIDOS' }, 400);
    const p = pedido.data;
    if (p.acao === 'revogar') return resposta({ ok: true, data: await revogarArquivo(sessao, { arquivoId: p.arquivoId }) });
    if (p.acao === 'trocar_link') { await trocarLinkArquivo(sessao, { arquivoId: p.arquivoId }); return resposta({ ok: true }); }
    await definirExpiracaoArquivo(sessao, { arquivoId: p.arquivoId, expiraEm: p.expiraEm });
    return resposta({ ok: true });
  } catch (e) {
    const r = respostaDeErroAtendimento(e);
    return resposta(r.corpo, r.status);
  }
}
