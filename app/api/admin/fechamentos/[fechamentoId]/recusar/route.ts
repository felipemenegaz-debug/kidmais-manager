import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
import { perdaSchema } from '@/lib/oportunidades/modelo';
import { recusarPedido } from '@/lib/oportunidades/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ fechamentoId: string }> }) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await context.params).fechamentoId);
    const perda = perdaSchema.parse(await request.json());
    const data = await withTenantTransaction(sessao, null,
      (tx, tenant) => recusarPedido(tx, tenant, id, perda));
    return jsonNoStore({ ok: true, data });
  } catch (erro) {
    return apiErrorResponse(erro);
  }
}
