import type { NextRequest } from "next/server";
import { jsonNoStore } from "@/lib/http/api-response";
import { limiteConfigurado } from "@/lib/importacao-contrato/arquivo";
import { TEMPO_PADRAO, criarSemaforo, lerMultipartLimitado, limitesUpload, type CodigoMultipart } from "@/lib/importacao-contrato/multipart";
import { atenderDocumento } from "@/lib/inteligencia/documentos/upload";
import { InteligenciaError } from "@/lib/inteligencia/politica";
import { dependenciasDocumento } from "./composicao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Uploads simultâneos por processo. Cada um pode segurar até o teto do corpo em memória. */
const uploads = criarSemaforo(2);

const MENSAGENS: Record<CodigoMultipart, string> = {
  CORPO_GRANDE: "O arquivo é grande demais.",
  ARQUIVO_GRANDE: "O arquivo é grande demais.",
  PARTES_DEMAIS: "Envie só o arquivo do contrato.",
  CABECALHO_GRANDE: "Envio inválido.",
  CAMPO_GRANDE: "Envie só o arquivo do contrato.",
  MULTIPART_INVALIDO: "Envio inválido.",
  ARQUIVO_AUSENTE: "Envie o arquivo do contrato.",
  LEITURA_LENTA: "O envio demorou demais. Tente de novo com uma conexão mais estável.",
  ENVIO_CANCELADO: "O envio foi interrompido.",
};

/**
 * Upload do contrato histórico (PDF/JPG/PNG). O arquivo fica privado: nenhuma URL pública é gerada.
 * O corpo só é lido depois da sessão, do papel e da flag, com teto contado byte a byte (H7).
 */
export async function POST(request: NextRequest) {
  const liberar = uploads.tentar();
  if (!liberar) return jsonNoStore({ ok: false, erro: "Há outro envio em andamento. Tente de novo em instantes.", codigo: "UPLOADS_SIMULTANEOS" }, { status: 429 });
  try {
    const deps = dependenciasDocumento(request);
    const { status, corpo } = await atenderDocumento(
      {
        empresaSolicitada: request.nextUrl.searchParams.get("empresaId"),
        sinal: request.signal,
        async lerArquivo() {
          const lido = await lerMultipartLimitado(request.body, request.headers.get("content-type"), limitesUpload(limiteConfigurado(deps.env.AI_UPLOAD_MAX_BYTES)),
            // Conexão lenta ou cliente que desconectou não seguram o slot: prazo total, tempo ocioso e abort.
            { ...TEMPO_PADRAO, sinal: request.signal });
          if (!lido.ok) throw new InteligenciaError(lido.codigo, MENSAGENS[lido.codigo], lido.status);
          return lido.arquivo;
        },
      },
      deps,
    );
    return jsonNoStore(corpo, { status });
  } finally {
    liberar();
  }
}
