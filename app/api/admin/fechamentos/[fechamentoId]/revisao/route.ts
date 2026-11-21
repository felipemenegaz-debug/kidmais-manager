import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { contextoCrmDaRequest, exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { isClienteServiceError } from "@/lib/clientes/services";
import { isFechamentoServiceError } from "@/lib/fechamentos/services/errors";
import { obterRevisaoComercial, revisarComercial } from "@/lib/fechamentos/services/revisao-comercial.service";
import { CondicaoPagamentoError } from "@/lib/comercial/condicao-pagamento";
import { pretensaoPixSchema, valorComercialSchema } from "@/lib/http/condicao-pagamento-schema";
import { PacoteAdminError } from "@/lib/comercial/pacotes-admin";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import type { DbExecutor } from "@/lib/db/contracts";
import type { RevisaoPreReserva } from "@/lib/pre-reserva/apresentacao-admin";

import { resumoComercialDaEmpresa } from '@/lib/assinatura/paywall';
import { situacaoRecusa } from '@/lib/oportunidades/service';
import { MarketingError } from '@/lib/marketing/erros';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ fechamentoId: string }> };
const schema = z.object({
  solicitacaoId: z.string().uuid(), decisao: z.enum(["APROVAR", "RECUSAR"]),
  valorBaseAprovado: valorComercialSchema.optional(),
  condicaoAprovada: pretensaoPixSchema.nullable().optional(),
  motivo: z.string().trim().min(1).max(1000),
}).strict();
function resposta(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
function erro(error: unknown) {
  if (isClienteServiceError(error) || isFechamentoServiceError(error) || error instanceof PacoteAdminError) {
    return resposta({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus);
  }
  if (error instanceof CondicaoPagamentoError || error instanceof z.ZodError || error instanceof SyntaxError) {
    return resposta({ ok: false, erro: "Dados da revisão inválidos. Confira os valores e a precisão de centavos.", codigo: "DADOS_INVALIDOS" }, 400);
  }
  console.error("[Revisão comercial]", error);
  return resposta({ ok: false, erro: "Não foi possível processar a revisão." }, 500);
}

async function lerPreReserva(tx: DbExecutor, empresa: string, pedido: string) {
  const { rows: [schema] } = await tx.query<{ instalada: boolean }>(
    "SELECT to_regclass('public.pre_reserva_situacoes') IS NOT NULL AS instalada",
  );
  if (!schema.instalada) return undefined;
  const { rows: [aceite] } = await tx.query<RevisaoPreReserva>(`
    SELECT a.sequencia, a.sinal_centavos AS "sinalCentavos", a.aceito_em AS "aceitoEm",
           a.inicio_evento AS inicio, a.fim_evento AS fim, u.nome AS unidade, l.nome AS salao,
           a.recebedor, g.garantia_ate AS "garantiaAte", g.garantia,
           ARRAY(SELECT DISTINCT s.dinheiro FROM pre_reserva_situacoes s
                 WHERE s.empresa_id=a.empresa_id AND s.fechamento_id=a.fechamento_id
                 ORDER BY s.dinheiro) AS destinos
    FROM pre_reserva_aceites a
    LEFT JOIN estabelecimentos u ON (u.empresa_id,u.id)=(a.empresa_id,a.estabelecimento_id)
    LEFT JOIN agenda_saloes l ON (l.empresa_id,l.id)=(a.empresa_id,a.salao_id)
    LEFT JOIN pre_reserva_situacoes g ON (g.empresa_id,g.fechamento_id)=(a.empresa_id,a.fechamento_id)
                                    AND g.garantia_ate IS NOT NULL
    WHERE a.empresa_id=$1 AND a.fechamento_id=$2 ORDER BY a.sequencia DESC LIMIT 1
  `, [empresa, pedido]);
  return aceite;
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await context.params).fechamentoId);
    // Tenant provado antes de ler; fechamento de outra empresa responde como inexistente.
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"),
      async (tx, tenant) => {
        const revisao = await obterRevisaoComercial(id, tenant.empresaComprovada, tx);
        const preReserva = tenant.papelAtual === 'REPRESENTANTE_AUTORIZADO'
          ? await lerPreReserva(tx, tenant.empresaComprovada, id) : undefined;
        const dados = preReserva ? { ...revisao, preReserva } : revisao;
        if (dados.fechamento.status !== 'AGUARDANDO_CONTRATO' || !dados.fechamento.clienteId ||
            tenant.papelAtual !== 'REPRESENTANTE_AUTORIZADO') return dados;
        const comercial = await resumoComercialDaEmpresa(tx, tenant.empresaComprovada);
        if (comercial.nivel !== 'COMPLETO') return dados;
        try {
          return { ...dados, recusa: await situacaoRecusa(tx, id, tenant) };
        } catch (e) {
          if (!(e instanceof MarketingError)) throw e;
          if (e.code === 'OPORTUNIDADES_INDISPONIVEIS') return { ...dados, recusa: 'INDISPONIVEL' };
          if (e.httpStatus === 403 || e.httpStatus === 409) return dados;
          throw e;
        }
      });
    return resposta({ ok: true, data });
  } catch (error) { return erro(error); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await context.params).fechamentoId);
    const input = schema.parse(await request.json());
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"),
      (tx, tenant) => revisarComercial(id, tenant.empresaComprovada, input, contextoCrmDaRequest(request), tx));
    return resposta({ ok: true, data }, data.reutilizada ? 200 : 201);
  } catch (error) { return erro(error); }
}
