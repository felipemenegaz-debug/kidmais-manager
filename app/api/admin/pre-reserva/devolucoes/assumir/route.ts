import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { assumirDevolucao } from '@/lib/pre-reserva/devolucao';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const entrada = z.object({ referencia: z.string().trim().regex(/^E[0-9]{20}[A-Za-z0-9]{11}$/) }).strict();

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const { referencia } = entrada.parse(await request.json());
    await withTenantTransaction(sessao, null, (tx, tenant) => assumirDevolucao(tx, tenant, referencia));
    return jsonNoStore({ ok: true });
  } catch (erro) {
    return apiErrorResponse(erro);
  }
}
