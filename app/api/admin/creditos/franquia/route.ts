import type { NextRequest } from 'next/server';
import { consultarFinanceiro } from "@/lib/financeiro/http";
import { exigirGestaoNoTenant } from '@/lib/saas/provar-tenant';
import { franquiaDaEmpresa } from '@/lib/convites/franquia-empresa';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return consultarFinanceiro(request, (tx, tenant) => {
    exigirGestaoNoTenant(tenant, 'Somente a Gestão pode consultar a franquia da empresa.');
    return franquiaDaEmpresa(tx, tenant.empresaComprovada);
  });
}
