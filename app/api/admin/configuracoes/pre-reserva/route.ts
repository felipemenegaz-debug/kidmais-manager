import type { NextRequest } from 'next/server';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { exigirGestaoNoTenant, withTenantTransaction } from '@/lib/saas/provar-tenant';
import { recursoIncluido } from '@/lib/assinatura/recursos-plano';
import { PacoteAdminError } from '@/lib/comercial/pacotes-admin';
import { configuracaoPreReserva, salvarConfiguracaoPreReserva } from '@/lib/pre-reserva/configuracao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, 'Somente a Gestão consulta a configuração de pré-reserva.');
      const { rows: [schema] } = await tx.query<{ instalada: boolean }>(
        "SELECT to_regclass('public.pre_reserva_configuracoes') IS NOT NULL AS instalada",
      );
      if (!schema.instalada) throw new PacoteAdminError('PRE_RESERVA_INDISPONIVEL', 'A configuração de pré-reserva ainda não está disponível.', 503);
      const config = await configuracaoPreReserva(tx, tenant);
      const orcamentoOnline = await recursoIncluido(tx, tenant.empresaComprovada, 'ORCAMENTO_ONLINE');
      const { rows: [pix] } = await tx.query<{ cadastrado: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM empresa_pix_recebimento WHERE empresa_id=$1) AS cadastrado',
        [tenant.empresaComprovada],
      );
      return { ...config, orcamentoOnline, recebedorPix: pix.cadastrado };
    });
    return jsonNoStore({ ok: true, data });
  } catch (erro) { return apiErrorResponse(erro); }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const entrada: unknown = await request.json();
    const data = await withTenantTransaction(sessao, null, (tx, tenant) => salvarConfiguracaoPreReserva(tx, tenant, sessao, entrada));
    return jsonNoStore({ ok: true, data });
  } catch (erro) { return apiErrorResponse(erro); }
}
