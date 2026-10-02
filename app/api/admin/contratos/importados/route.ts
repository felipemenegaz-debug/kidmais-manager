import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { listarContratosImportados } from '@/lib/contratos/importados';
import { hojeBrasilia } from '@/lib/financeiro/calculos';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Contratos importados da empresa comprovada, opcionalmente de um cliente (página do cliente). Somente leitura. */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const q = request.nextUrl.searchParams;
    const clienteId = q.get('clienteId');
    if (clienteId && !z.string().uuid().safeParse(clienteId).success) {
      return NextResponse.json({ ok: false, erro: 'Cliente inválido.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    const data = await withTenantTransaction(sessao, q.get('empresaId'), (tx, tenant) =>
      listarContratosImportados(tx, tenant.empresaComprovada, hojeBrasilia(), clienteId?.toLowerCase() ?? undefined));
    return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
