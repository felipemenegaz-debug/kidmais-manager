import { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/autenticacao/service";
import { validarVinculoComposicao } from "@/lib/comercial/composicao";
import { PacoteAdminError } from "@/lib/comercial/pacotes-admin";
import { db } from "@/lib/db/postgres";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const vinculo = z.object({
  acao: z.literal("vinculo"),
  empresaId: uuid,
  adicionalId: uuid,
  modalidade: z.enum(["INCLUSO", "EXTRA", "INDISPONIVEL"]),
}).strict();
const buffet = z.object({
  acao: z.literal("buffet"),
  empresaId: uuid,
  categoriaId: uuid,
  ativo: z.boolean(),
  escolhasMin: z.number().int().min(0).max(30),
  escolhasMax: z.number().int().min(0).max(30),
}).strict();
const corpo = z.discriminatedUnion("acao", [vinculo, buffet]);
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (sessao.papel !== "REPRESENTANTE_AUTORIZADO") throw authError("Apenas o proprietário pode editar a composição.", 403);
    const id = uuid.safeParse((await context.params).id);
    if (!id.success) return jsonNoStore({ ok: false, erro: "Pacote inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    const input = corpo.parse(await request.json());
    if (input.acao === "buffet" && input.escolhasMin > input.escolhasMax) {
      throw new PacoteAdminError("LIMITE_BUFFET", "O mínimo de escolhas não pode passar do máximo.", 409);
    }
    if (input.acao === "vinculo") {
      const atual = await db().query<{ pacote: string; adicional: string; modalidade: "INCLUSO" | "EXTRA" | "INDISPONIVEL" | null }>(
        `SELECT p.codigo AS pacote, a.codigo AS adicional, pa.modalidade
           FROM pacotes p
           JOIN adicionais a ON a.id = $3::uuid
           LEFT JOIN pacote_adicionais pa ON pa.pacote_id = p.id AND pa.adicional_id = a.id AND pa.ativo
          WHERE p.id = $1::uuid AND p.empresa_id = $2::uuid`,
        [id.data, input.empresaId, input.adicionalId],
      );
      const linha = atual.rows[0];
      if (!linha) return jsonNoStore({ ok: false, erro: "Pacote não encontrado nesta empresa.", codigo: "NAO_ENCONTRADO" }, { status: 404 });
      validarVinculoComposicao({ pacoteCodigo: linha.pacote, adicionalCodigo: linha.adicional, modalidade: input.modalidade, modalidadeAtual: linha.modalidade });
      await db().query(
        `INSERT INTO pacote_adicionais(pacote_id, adicional_id, modalidade)
         VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (pacote_id, adicional_id) DO UPDATE SET modalidade = EXCLUDED.modalidade, ativo = true`,
        [id.data, input.adicionalId, input.modalidade],
      );
    } else {
      const gravado = await db().query(
        `INSERT INTO pacote_buffet_categorias(pacote_id, categoria_id, modo_itens, escolhas_min, escolhas_max, ativo)
         SELECT p.id, $3::uuid, 'SELECIONADOS', $4, $5, $6
           FROM pacotes p
          WHERE p.id = $1::uuid AND p.empresa_id = $2::uuid
         ON CONFLICT (pacote_id, categoria_id)
         DO UPDATE SET escolhas_min = EXCLUDED.escolhas_min, escolhas_max = EXCLUDED.escolhas_max, ativo = EXCLUDED.ativo
         RETURNING pacote_id`,
        [id.data, input.empresaId, input.categoriaId, input.escolhasMin, input.escolhasMax, input.ativo],
      );
      if (!gravado.rowCount) return jsonNoStore({ ok: false, erro: "Pacote não encontrado nesta empresa.", codigo: "NAO_ENCONTRADO" }, { status: 404 });
    }
    return jsonNoStore({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
