import { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/autenticacao/service";
import { validarVinculoComposicao } from "@/lib/comercial/composicao";
import { MOTIVOS_PACOTE, motivoOu } from "@/lib/comercial/motivos-pacote";
import { PacoteAdminError, alterarComposicaoPacoteAdmin } from "@/lib/comercial/pacotes-admin";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Catálogo administrativo.
 * (1) Tenant: adicionais, pacotes e a composição que passa pelo pacote da empresa.
 * (2) Buffet é catálogo global. A membership consulta e seleciona no pacote da empresa.
 *     Criar, editar, desativar e excluir exigem autoridade global explícita, que este modelo não tem.
 *     A migration 050 não autoriza essa escrita. Adicional de outra empresa continua fora.
 * (3) Legado ainda sem tenant: linhas de pacotes, adicionais e tabelas com empresa_id nulo.
 *     Não são alcançadas por esta escrita.
 */
const uuid = z.string().uuid();
const nome = z.string().trim().min(1).max(160);
const motivo = z.string().trim().min(3).max(500).optional();
const operacao = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("categoria"), id: uuid, nome, ativo: z.boolean() }).strict(),
  z.object({ acao: z.literal("nova_categoria"), nome, ativo: z.boolean() }).strict(),
  z.object({ acao: z.literal("excluir_categoria"), id: uuid }).strict(),
  z.object({ acao: z.literal("item"), id: uuid, nome, ativo: z.boolean(), categoriaId: uuid.nullable().optional() }).strict(),
  z.object({ acao: z.literal("novo_item"), nome, categoriaId: uuid.nullable().optional(), ativo: z.boolean() }).strict(),
  z.object({ acao: z.literal("excluir_item"), id: uuid }).strict(),
  z.object({ acao: z.literal("adicional"), id: uuid, nome, ativo: z.boolean() }).strict(),
  z.object({
    acao: z.literal("vinculo_adicional"),
    pacoteId: uuid,
    adicionalId: uuid,
    modalidade: z.enum(["INCLUSO", "EXTRA", "INDISPONIVEL"]),
    motivo,
  }).strict(),
  z.object({
    acao: z.literal("regra_buffet"),
    pacoteId: uuid,
    categoriaId: uuid,
    ativo: z.boolean(),
    max: z.number().int().min(1).max(30),
    motivo,
  }).strict(),
]);

const acoesGlobais = new Set(["categoria", "item", "novo_item", "nova_categoria", "excluir_categoria", "excluir_item"]);

function recusarCatalogoGlobal(): never {
  throw new PacoteAdminError(
    "CATALOGO_GLOBAL_SEM_AUTORIDADE",
    "Referência global do catálogo não é alterada por uma membership de empresa.",
    403,
  );
}

function contextoEmpresa(bruto: unknown) {
  if (bruto == null || typeof bruto !== "object" || Array.isArray(bruto)) {
    return { empresaId: null as string | null, operacao: bruto };
  }
  const registro = { ...(bruto as Record<string, unknown>) };
  const cru = registro.empresaId;
  delete registro.empresaId;
  if (cru == null || cru === "") return { empresaId: null, operacao: registro };
  return { empresaId: z.string().uuid().parse(cru), operacao: registro };
}

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      const empresaId = tenant.empresaComprovada;
      const categorias = await tx.query("SELECT id, codigo, nome, ativo FROM buffet_categorias ORDER BY ordem_exibicao, nome");
      const itens = await tx.query("SELECT id, categoria_id, nome, ativo FROM buffet_itens ORDER BY ordem_exibicao, nome");
      const adicionais = await tx.query(
        "SELECT id, codigo, nome, categoria, ativo FROM adicionais WHERE empresa_id = $1::uuid ORDER BY categoria, ordem_exibicao, nome",
        [empresaId],
      );
      const pacotes = await tx.query(
        "SELECT id, codigo, nome FROM pacotes WHERE empresa_id = $1::uuid AND vigente ORDER BY ordem_exibicao",
        [empresaId],
      );
      const vinculos = await tx.query(
        `SELECT pa.pacote_id, pa.adicional_id, pa.modalidade
           FROM pacote_adicionais pa
           JOIN pacotes p ON p.id = pa.pacote_id
          WHERE pa.ativo AND p.empresa_id = $1::uuid`,
        [empresaId],
      );
      const regras = await tx.query(
        `SELECT r.pacote_id, r.categoria_id, r.ativo, r.escolhas_max
           FROM pacote_buffet_categorias r
           JOIN pacotes p ON p.id = r.pacote_id
          WHERE p.empresa_id = $1::uuid`,
        [empresaId],
      );
      return {
        categorias: categorias.rows,
        itens: itens.rows,
        adicionais: adicionais.rows,
        pacotes: pacotes.rows,
        vinculos: vinculos.rows,
        regras: regras.rows,
      };
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (sessao.papel !== "REPRESENTANTE_AUTORIZADO") throw authError("Apenas o proprietário pode editar o catálogo.", 403);
    const bruto = await request.json();
    const pedido = contextoEmpresa(bruto);
    const estado = await withTenantTransaction(sessao, pedido.empresaId, async (tx, tenant) => {
      const data = operacao.parse(pedido.operacao);
      const empresaId = tenant.empresaComprovada;
      if (acoesGlobais.has(data.acao)) recusarCatalogoGlobal();
      let resultado: { rowCount: number | null } | undefined;
      if (data.acao === "adicional") {
        resultado = await tx.query(
          "UPDATE adicionais SET nome=$2, ativo=$3 WHERE id=$1::uuid AND empresa_id=$4::uuid RETURNING id",
          [data.id, data.nome, data.ativo, empresaId],
        );
      } else if (data.acao === "vinculo_adicional") {
        const atual = await tx.query<{ pacote: string; adicional: string; modalidade: "INCLUSO" | "EXTRA" | "INDISPONIVEL" | null }>(
          `SELECT p.codigo AS pacote, a.codigo AS adicional, pa.modalidade
             FROM pacotes p
             JOIN adicionais a ON a.id = $2::uuid AND a.empresa_id = p.empresa_id
             LEFT JOIN pacote_adicionais pa ON pa.pacote_id = p.id AND pa.adicional_id = a.id AND pa.ativo
            WHERE p.id = $1::uuid AND p.empresa_id = $3::uuid`,
          [data.pacoteId, data.adicionalId, empresaId],
        );
        const vinculo = atual.rows[0];
        if (!vinculo) return { ausente: true as const };
        validarVinculoComposicao({
          pacoteCodigo: vinculo.pacote,
          adicionalCodigo: vinculo.adicional,
          modalidade: data.modalidade,
          modalidadeAtual: vinculo.modalidade,
        });
        await alterarComposicaoPacoteAdmin(
          tx,
          data.pacoteId,
          { tipo: "vinculo", adicionalId: data.adicionalId, modalidade: data.modalidade },
          {
            empresaId,
            usuarioId: sessao.usuario_id,
            requestId: crypto.randomUUID(),
            motivo: motivoOu(data.motivo, MOTIVOS_PACOTE.composicao),
          },
        );
        return { ausente: false as const };
      } else if (data.acao === "regra_buffet") {
        const atual = await tx.query<{ escolhas_min: number | null }>(
          `SELECT r.escolhas_min
             FROM pacotes p
             LEFT JOIN pacote_buffet_categorias r
               ON r.pacote_id = p.id AND r.categoria_id = $2::uuid
            WHERE p.id = $1::uuid AND p.empresa_id = $3::uuid`,
          [data.pacoteId, data.categoriaId, empresaId],
        );
        if (!atual.rows[0]) return { ausente: true as const };
        const escolhasMin = atual.rows[0].escolhas_min == null ? 0 : Number(atual.rows[0].escolhas_min);
        if (escolhasMin > data.max) {
          throw new PacoteAdminError("LIMITE_BUFFET", "O mínimo de escolhas não pode passar do máximo.", 409);
        }
        await alterarComposicaoPacoteAdmin(
          tx,
          data.pacoteId,
          {
            tipo: "buffet",
            categoriaId: data.categoriaId,
            ativo: data.ativo,
            escolhasMin,
            escolhasMax: data.max,
          },
          {
            empresaId,
            usuarioId: sessao.usuario_id,
            requestId: crypto.randomUUID(),
            motivo: motivoOu(data.motivo, MOTIVOS_PACOTE.composicao),
          },
        );
        return { ausente: false as const };
      }
      if (!resultado?.rowCount) return { ausente: true as const };
      return { ausente: false as const };
    });
    if (estado.ausente) return jsonNoStore({ ok: false, erro: "Registro indisponível nesta empresa." }, { status: 404 });
    return jsonNoStore({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
