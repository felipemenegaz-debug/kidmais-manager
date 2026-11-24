import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { confirmarDevolucao } from '@/lib/pre-reserva/devolucao';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const entrada = z.object({
  original: z.string().trim().regex(/^E[0-9]{20}[A-Za-z0-9]{11}$/),
  referencia: z.string().trim().min(1),
  valorCentavos: z.number().int().positive(),
  devolvidoEm: z.string(),
  extratoConferido: z.boolean(),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const { original, ...baixa } = entrada.parse(await request.json());
    await withTenantTransaction(sessao, null, (tx, tenant) => confirmarDevolucao(tx, tenant, original, baixa));
    return jsonNoStore({ ok: true });
  } catch (erro) {
    return apiErrorResponse(erro);
  }
}
