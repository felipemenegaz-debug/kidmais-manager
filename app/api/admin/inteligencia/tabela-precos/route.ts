import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { jsonNoStore } from "@/lib/http/api-response";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { limiteConfigurado } from "@/lib/importacao-contrato/arquivo";
import { TEMPO_PADRAO, criarSemaforo, lerMultipartLimitado, limitesUpload } from "@/lib/importacao-contrato/multipart";
import { hojeBrasilia } from "@/lib/financeiro/calculos";
import { arquivoDaImportacao, gravarLeitura, registrarImportacao } from "@/lib/comercial/importacao-tabela/servico";
import { EnvioRecusado, atenderLeituraTabela } from "@/lib/inteligencia/documentos/tabela-precos";
import { envioDocumentoExternoAutorizado } from "@/lib/inteligencia/flags";
import { roteadorDoAmbiente } from "../dependencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Uma leitura por vez por processo: o PDF inteiro fica em memória e a leitura pelo modelo é longa. */
const leituras = criarSemaforo(1);

/**
 * Composition root da leitura da tabela de preços em PDF (071): sessão → Tenant Context → serviços do Core que
 * guardam o PDF e a revisão; a leitura pelo modelo fica na camada de IA. POST envia um PDF novo; POST ?id= relê o PDF já guardado.
 * Nada aqui publica preço.
 */
async function atender(request: NextRequest, importacaoId: string | null) {
  const liberar = leituras.tentar();
  if (!liberar) return jsonNoStore({ ok: false, erro: "Há outra leitura em andamento. Tente de novo em instantes.", codigo: "LEITURA_EM_ANDAMENTO" }, { status: 429 });
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const empresaSolicitada = request.nextUrl.searchParams.get("empresaId");
    const limiteBytes = limiteConfigurado(process.env.AI_UPLOAD_MAX_BYTES);
    const { status, corpo } = await atenderLeituraTabela({
      importacaoId,
      async lerArquivo() {
        const lido = await lerMultipartLimitado(request.body, request.headers.get("content-type"), limitesUpload(limiteBytes), { ...TEMPO_PADRAO, sinal: request.signal });
        if (!lido.ok) throw new EnvioRecusado(lido.codigo, "Envie um PDF de até 15 MB.", lido.status);
        return lido.arquivo;
      },
    }, {
      emTenant: (trabalho) => withTenantTransaction(sessao, empresaSolicitada, trabalho),
      registrar: registrarImportacao,
      arquivoDe: arquivoDaImportacao,
      gravar: gravarLeitura,
      usuarioId: sessao.usuario_id,
      requestId: randomUUID(),
      limiteBytes,
      hoje: hojeBrasilia(new Date()),
      roteador: roteadorDoAmbiente(),
      envioExterno: envioDocumentoExternoAutorizado(process.env),
    });
    return jsonNoStore(corpo, { status });
  } catch (error) {
    // Sessão ausente, expirada ou sem acesso: os erros do projeto trazem code e httpStatus.
    const conhecido = error as { code?: unknown; httpStatus?: unknown; message?: string };
    if (typeof conhecido.code === "string" && typeof conhecido.httpStatus === "number") {
      return jsonNoStore({ ok: false, erro: conhecido.message, codigo: conhecido.code }, { status: conhecido.httpStatus });
    }
    console.error("[Kidmais IA] leitura da tabela falhou", error instanceof Error ? error.name : "erro");
    return jsonNoStore({ ok: false, erro: "Não foi possível ler a tabela agora.", codigo: "ERRO_INTERNO" }, { status: 500 });
  } finally {
    liberar();
  }
}

export async function POST(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (id !== null && !/^[0-9a-f-]{36}$/i.test(id)) return jsonNoStore({ ok: false, erro: "Importação inválida.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
  return atender(request, id);
}
