import { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/autenticacao/service";
import { validarVinculoComposicao } from "@/lib/comercial/composicao";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const nome = z.string().trim().min(1).max(160);
const operacao = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("categoria"), id: uuid, nome, ativo: z.boolean() }).strict(),
  z.object({ acao: z.literal("item"), id: uuid, nome, ativo: z.boolean() }).strict(),
  z.object({ acao: z.literal("novo_item"), categoriaId: uuid, nome }).strict(),
  z.object({ acao: z.literal("adicional"), id: uuid, nome, ativo: z.boolean() }).strict(),
  z.object({
    acao: z.literal("vinculo_adicional"),
    pacoteId: uuid,
    adicionalId: uuid,
    modalidade: z.enum(["INCLUSO", "EXTRA", "INDISPONIVEL"]),
  }).strict(),
  z.object({ acao: z.literal("nova_categoria"), nome }).strict(),
  z.object({
    acao: z.literal("regra_buffet"),
    pacoteId: uuid,
    categoriaId: uuid,
    ativo: z.boolean(),
    max: z.number().int().min(1).max(30),
  }).strict(),
]);

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
    const pedido = z.object({ empresaId: z.string().optional() }).passthrough().parse(bruto);
    const estado = await withTenantTransaction(sessao, pedido.empresaId ?? null, async (tx, tenant) => {
      const data = operacao.parse(bruto);
      const empresaId = tenant.empresaComprovada;
      let resultado;
      if (data.acao === "categoria") {
        resultado = await tx.query(
          "UPDATE buffet_categorias SET nome=$2, ativo=$3, arquivado_em=CASE WHEN $3 THEN NULL ELSE clock_timestamp() END WHERE id=$1 RETURNING id",
          [data.id, data.nome, data.ativo],
        );
      } else if (data.acao === "item") {
        resultado = await tx.query(
          "UPDATE buffet_itens SET nome=$2, ativo=$3, arquivado_em=CASE WHEN $3 THEN NULL ELSE clock_timestamp() END WHERE id=$1 RETURNING id",
          [data.id, data.nome, data.ativo],
        );
      } else if (data.acao === "adicional") {
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
        resultado = await tx.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           SELECT p.id, a.id, $3
             FROM pacotes p
             JOIN adicionais a ON a.id = $2::uuid AND a.empresa_id = p.empresa_id
            WHERE p.id = $1::uuid AND p.empresa_id = $4::uuid
           ON CONFLICT (pacote_id, adicional_id) DO UPDATE SET modalidade = EXCLUDED.modalidade, ativo = true
           RETURNING pacote_id`,
          [data.pacoteId, data.adicionalId, data.modalidade, empresaId],
        );
      } else if (data.acao === "regra_buffet") {
        resultado = await tx.query(
          `INSERT INTO pacote_buffet_categorias (pacote_id, categoria_id, modo_itens, escolhas_min, escolhas_max, ativo)
           SELECT p.id, $2::uuid, 'TODOS_ATIVOS', 0, $3, $4
             FROM pacotes p
            WHERE p.id = $1::uuid AND p.empresa_id = $5::uuid
           ON CONFLICT (pacote_id, categoria_id) DO UPDATE SET escolhas_max = EXCLUDED.escolhas_max, ativo = EXCLUDED.ativo
           RETURNING pacote_id`,
          [data.pacoteId, data.categoriaId, data.max, data.ativo, empresaId],
        );
      } else if (data.acao === "nova_categoria") {
        const codigo = `CUSTOM_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
        resultado = await tx.query(
          `INSERT INTO buffet_categorias (codigo, nome, ordem_exibicao)
           VALUES ($1, $2, (SELECT COALESCE(MAX(ordem_exibicao), 0) + 1 FROM buffet_categorias))
           RETURNING id`,
          [codigo, data.nome],
        );
      } else {
        const codigo = `CUSTOM_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
        resultado = await tx.query(
          `INSERT INTO buffet_itens (categoria_id, codigo, nome, ordem_exibicao)
           SELECT id, $2, $3, COALESCE((SELECT MAX(ordem_exibicao) + 1 FROM buffet_itens WHERE categoria_id = $1), 1)
             FROM buffet_categorias
            WHERE id = $1 AND ativo
           RETURNING id`,
          [data.categoriaId, codigo, data.nome],
        );
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
