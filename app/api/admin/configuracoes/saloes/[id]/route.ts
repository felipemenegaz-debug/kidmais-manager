import { NextRequest } from "next/server";
import { z } from "zod";
import {
  confirmarDeclaracao, copiarFotoDoSite, editarLegenda, exigirApresentacaoInstalada, imagensDoSiteParaSalao, lerApresentacao, lerOrigemDoSite,
  removerFoto, reordenarFotos, salvarApresentacao,
} from "@/lib/agenda/salao-apresentacao";
import { EXCLUSIVOS, GRUPOS_ITEM } from "@/lib/agenda/salao-apresentacao-regras";
import { itensDosPacotesDoSalao } from "@/lib/agenda/salao-pacotes";
import { normalizarWebp } from "@/lib/imagens/normalizar-webp";
import { repetirEmConflito, SalaoApresentacaoError } from "@/lib/agenda/salao-apresentacao";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Apresentação de um salão (102). Ler: qualquer membership da empresa. Gravar: só Gestão (sem exceção de assistente).
 * Toda gravação leva a versão do conteúdo que a pessoa viu (409 se mudou). A tela não grava nome, capacidade, ordem
 * nem ativo: esses campos são da Agenda.
 */
type Contexto = { params: Promise<{ id: string }> };
const uuid = z.string().uuid();
const GESTAO = "Apenas quem tem Gestão pode alterar a apresentação dos salões.";
const versao = z.number().int().min(0);
const numero = (max: number) => z.number().int().min(1).max(max).nullable();

const salvar = z.object({
  acao: z.literal("salvar"),
  versao,
  campos: z.object({
    convidadosMinimo: numero(10000),
    convidadosSentados: numero(10000),
    areaM2: numero(5000),
    idadeMin: z.number().int().min(0).max(17).nullable(),
    idadeMax: z.number().int().min(0).max(17).nullable(),
    frase: z.string().max(200).nullable(),
    outraFestaSimultanea: z.boolean().nullable(),
    exclusivos: z.array(z.enum(EXCLUSIVOS)).max(EXCLUSIVOS.length),
    fotosReferencia: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
  }).strict(),
  itens: z.array(z.object({
    id: uuid.optional(),
    grupo: z.enum(GRUPOS_ITEM),
    codigo: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/).nullable().optional(),
    proprio: z.string().max(120).nullable().optional(),
    detalhe: z.string().max(80).nullable().optional(),
    destaque: z.boolean(),
  }).strict()).max(80),
}).strict();
const legenda = z.string().max(120);
const corpo = z.discriminatedUnion("acao", [
  salvar,
  z.object({ acao: z.literal("legenda"), versao, fotoId: uuid, legenda }).strict(),
  z.object({ acao: z.literal("remover_foto"), versao, fotoId: uuid }).strict(),
  z.object({ acao: z.literal("reordenar"), versao, fotos: z.array(uuid).max(8) }).strict(),
  z.object({ acao: z.literal("copiar_do_site"), versao, imagemId: uuid, legenda }).strict(),
  z.object({ acao: z.literal("declarar"), versao }).strict(),
]);

export async function GET(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const salaoId = uuid.parse((await contexto.params).id);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      await exigirApresentacaoInstalada(tx);
      const empresaId = tenant.empresaComprovada;
      return {
        gestao: tenant.papelAtual === "REPRESENTANTE_AUTORIZADO",
        apresentacao: await lerApresentacao(tx, empresaId, salaoId),
        pacotes: await itensDosPacotesDoSalao(tx, empresaId, salaoId),
        site: await imagensDoSiteParaSalao(tx, empresaId, salaoId),
      };
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const salaoId = uuid.parse((await contexto.params).id);
    const bruto = await request.json() as Record<string, unknown>;
    const empresaId = z.string().uuid().nullable().optional().parse(bruto.empresaId);
    const { empresaId: _ignorado, ...resto } = bruto;
    void _ignorado;
    const input = corpo.parse(resto);
    const ctxDe = (tenantEmpresa: string) => ({ empresaId: tenantEmpresa, usuarioId: sessao.usuario_id, requestId: crypto.randomUUID() });

    if (input.acao === "copiar_do_site") {
      // Fase 1 (tenant + Gestão + posse da origem), normalização FORA da transação, fase 2 sob lock com a origem FOR SHARE.
      const origem = await withTenantTransaction(sessao, empresaId, async (tx, tenant) => {
        exigirGestaoNoTenant(tenant, GESTAO);
        await exigirApresentacaoInstalada(tx);
        return { ...(await lerOrigemDoSite(tx, tenant.empresaComprovada, salaoId, input.imagemId)), empresa: tenant.empresaComprovada };
      });
      let imagem;
      try {
        imagem = await normalizarWebp(origem.conteudo);
      } catch {
        throw new SalaoApresentacaoError("IMAGEM_INVALIDA", "Não foi possível usar esta imagem do site.", 400);
      }
      const data = await repetirEmConflito(() => withTenantTransaction(sessao, empresaId, async (tx, tenant) => {
        exigirGestaoNoTenant(tenant, GESTAO);
        if (tenant.empresaComprovada !== origem.empresa) throw new SalaoApresentacaoError("SALAO_MUDOU", "A empresa mudou. Recarregue a página.", 409);
        return copiarFotoDoSite(tx, ctxDe(tenant.empresaComprovada), salaoId, input.versao, input.imagemId, origem.sha256, imagem, input.legenda);
      }));
      return jsonNoStore({ ok: true, data });
    }

    const data = await repetirEmConflito(() => withTenantTransaction(sessao, empresaId, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, GESTAO);
      const ctx = ctxDe(tenant.empresaComprovada);
      switch (input.acao) {
        case "salvar": return salvarApresentacao(tx, ctx, salaoId, input.versao, input.campos, input.itens);
        case "legenda": return editarLegenda(tx, ctx, salaoId, input.versao, input.fotoId, input.legenda);
        case "remover_foto": return removerFoto(tx, ctx, salaoId, input.versao, input.fotoId);
        case "reordenar": return reordenarFotos(tx, ctx, salaoId, input.versao, input.fotos);
        case "declarar": return confirmarDeclaracao(tx, ctx, salaoId, input.versao);
      }
    }));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
