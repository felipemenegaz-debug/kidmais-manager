import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  gerarContrato,
  isContratoServiceError,
  obterContratoPorFechamento,
} from "@/lib/contratos/services";
import { isClienteServiceError } from "@/lib/clientes/services";
import { PacoteAdminError } from "@/lib/comercial/pacotes-admin";
import { executarComPosseNoTenant, fechamentoNoTenant } from "@/lib/contratos/services/contrato-tenant";
import { ResumoTenantError } from "@/lib/contratos/services/resumo-tenant";
import { apiErrorResponse } from "@/lib/http/api-response";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import {
  contextoCrmDaRequest,
  exigirApiAdminCrmDisponivel,
} from "@/lib/http/admin-crm-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const gerarSchema = z
  .object({
    fechamentoId: z.string().uuid(),
    motivoNovaVersao: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function erroContrato(error: unknown) {
  // Fechamento fora do tenant (404 igual) ou tenant não comprovado (403).
  if (error instanceof ResumoTenantError || error instanceof PacoteAdminError) return apiErrorResponse(error);
  if (isContratoServiceError(error) || isClienteServiceError(error)) {
    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: error.message,
          codigo: error.code,
          detalhes: error.details ?? null,
        },
        { status: error.httpStatus },
      ),
    );
  }

  console.error("[Kidmais Contratos API] erro não tratado", error);
  return noStore(
    NextResponse.json(
      {
        ok: false,
        erro: "Não foi possível processar o Contrato agora.",
        codigo: "ERRO_CONTRATO",
      },
      { status: 500 },
    ),
  );
}

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const fechamentoId = request.nextUrl.searchParams.get("fechamentoId") ?? "";
    const parsed = z.string().uuid().safeParse(fechamentoId);
    if (!parsed.success) {
      return noStore(
        NextResponse.json(
          {
            ok: false,
            erro: "Informe um fechamentoId válido.",
            codigo: "DADOS_INVALIDOS",
          },
          { status: 400 },
        ),
      );
    }

    // B2/D1: posse do fechamento e leitura do contrato (snapshot com dados pessoais) na MESMA transação.
    const data = await executarComPosseNoTenant(sessao, request.nextUrl.searchParams.get("empresaId"), parsed.data, fechamentoNoTenant, { withTenantTransaction }, (tx) => obterContratoPorFechamento(parsed.data, tx));
    return noStore(NextResponse.json({ ok: true, data }));
  } catch (error) {
    return erroContrato(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return noStore(
        NextResponse.json(
          { ok: false, erro: "Corpo JSON inválido.", codigo: "JSON_INVALIDO" },
          { status: 400 },
        ),
      );
    }

    const parsed = gerarSchema.safeParse(body);
    if (!parsed.success) {
      return noStore(
        NextResponse.json(
          {
            ok: false,
            erro: "Dados inválidos para geração do Contrato.",
            codigo: "DADOS_INVALIDOS",
            detalhes: parsed.error.flatten(),
          },
          { status: 400 },
        ),
      );
    }

    // B2/C2: tenant + posse do fechamento e geração do contrato na MESMA transação (executor).
    const crm = contextoCrmDaRequest(request);
    const data = await executarComPosseNoTenant(sessao, request.nextUrl.searchParams.get("empresaId"), parsed.data.fechamentoId, fechamentoNoTenant, { withTenantTransaction }, (tx) => gerarContrato(parsed.data, {
      usuarioId: crm.usuarioId,
      origem: "CONTRATO_INTERNO_DEV",
      requestId: crm.requestId,
      ip: crm.ip,
      userAgent: crm.userAgent,
      executor: tx,
    }));

    return noStore(
      NextResponse.json(
        { ok: true, data },
        { status: data.reutilizado ? 200 : 201 },
      ),
    );
  } catch (error) {
    return erroContrato(error);
  }
}
