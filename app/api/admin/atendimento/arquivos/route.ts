import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { TEMPO_PADRAO, criarSemaforo, lerMultipartLimitado, limitesUpload, type CodigoMultipart } from '@/lib/importacao-contrato/multipart';
import { LIMITE_ARQUIVO } from '@/lib/whatsapp/atendimento/arquivos';
import { exigirGestaoBiblioteca, salvarArquivo } from '@/lib/whatsapp/atendimento/prontas-servico';
import { respostaDeErroAtendimento } from '@/lib/whatsapp/atendimento/erros';
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
