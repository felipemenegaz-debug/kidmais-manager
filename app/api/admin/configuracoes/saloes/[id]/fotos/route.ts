import type { NextRequest } from "next/server";
import { z } from "zod";
import { adicionarFoto, exigirApresentacaoInstalada, repetirEmConflito, SalaoApresentacaoError } from "@/lib/agenda/salao-apresentacao";
import { TEMPO_PADRAO, criarSemaforo, lerMultipartLimitado, limitesUpload, type CodigoMultipart } from "@/lib/importacao-contrato/multipart";
import { ImagemInvalidaError, normalizarWebp, WEBP_MAX_ENTRADA } from "@/lib/imagens/normalizar-webp";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Envio de foto do salão (102). Ordem: guarda administrativa → tenant + Gestão + salão da empresa ANTES de ler o corpo →
 * leitura com teto efetivo (8 MB + envelope, mesmo sem Content-Length ou com valor falso; uma parte "arquivo") →
 * normalização WebP FORA de transação → gravação sob o lock do salão, que repete tenant, Gestão, versão e vaga.
 * Versão e legenda vão na query (não são dados pessoais): o leitor limitado só devolve o arquivo.
 */
type Contexto = { params: Promise<{ id: string }> };
const GESTAO = "Apenas quem tem Gestão pode alterar a apresentação dos salões.";
const uploads = criarSemaforo(2);
const MENSAGENS: Record<CodigoMultipart, string> = {
  CORPO_GRANDE: "Envie uma imagem de até 8 MB.", ARQUIVO_GRANDE: "Envie uma imagem de até 8 MB.", PARTES_DEMAIS: "Envie uma foto por vez.",
  CABECALHO_GRANDE: "Envio inválido.", CAMPO_GRANDE: "Envio inválido.", MULTIPART_INVALIDO: "Envio inválido.", ARQUIVO_AUSENTE: "Escolha a foto.",
  LEITURA_LENTA: "O envio demorou demais. Tente de novo.", ENVIO_CANCELADO: "O envio foi interrompido.",
};
const consulta = z.object({
  versao: z.coerce.number().int().min(0),
  legenda: z.string().min(1).max(120),
  empresaId: z.string().uuid().optional(),
}).strict();

export async function POST(request: NextRequest, contexto: Contexto) {
  const liberar = uploads.tentar();
  if (!liberar) return jsonNoStore({ ok: false, erro: "Há outro envio em andamento. Tente de novo em instantes.", codigo: "UPLOADS_SIMULTANEOS" }, { status: 429 });
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const salaoId = z.string().uuid().parse((await contexto.params).id);
    const q = consulta.parse(Object.fromEntries(request.nextUrl.searchParams));
    // Autorização antes de ocupar memória com o upload.
    await withTenantTransaction(sessao, q.empresaId ?? null, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, GESTAO);
      await exigirApresentacaoInstalada(tx);
      const r = await tx.query(`SELECT 1 FROM agenda_saloes WHERE id = $1::uuid AND empresa_id = $2::uuid`, [salaoId, tenant.empresaComprovada]);
      if (r.rowCount !== 1) throw new SalaoApresentacaoError("SALAO_NAO_ENCONTRADO", "Salão não encontrado.", 404);
    });
    const lido = await lerMultipartLimitado(request.body, request.headers.get("content-type"), limitesUpload(WEBP_MAX_ENTRADA), { ...TEMPO_PADRAO, sinal: request.signal });
    if (!lido.ok) return jsonNoStore({ ok: false, erro: MENSAGENS[lido.codigo], codigo: lido.codigo }, { status: lido.status });
    let imagem;
    try {
      imagem = await normalizarWebp(Buffer.from(lido.arquivo.bytes));
    } catch (error) {
      const tamanho = error instanceof ImagemInvalidaError && error.motivo === "TAMANHO";
      throw new SalaoApresentacaoError("IMAGEM_INVALIDA", tamanho ? "Envie uma imagem de até 8 MB." : "Não foi possível usar esta imagem. Envie um PNG, JPEG ou WebP válido.", tamanho ? 413 : 400);
    }
    const data = await repetirEmConflito(() => withTenantTransaction(sessao, q.empresaId ?? null, (tx, tenant) => {
      exigirGestaoNoTenant(tenant, GESTAO);
      return adicionarFoto(tx, { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, requestId: crypto.randomUUID() }, salaoId, q.versao, imagem, q.legenda);
    }));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  } finally {
    liberar();
  }
}
