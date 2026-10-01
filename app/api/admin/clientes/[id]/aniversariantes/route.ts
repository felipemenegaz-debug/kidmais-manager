import { NextRequest } from 'next/server';
import { z } from 'zod';
import { cadastrarAniversarianteInterno } from '@/lib/clientes/services';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { contextoCrmDaRequest, exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
import { aniversarianteSchema } from '../../schemas';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const clienteId = z.string().uuid().safeParse((await context.params).id);
    if (!clienteId.success)
      return jsonNoStore({ ok: false, erro: 'ID de Cliente inválido.', codigo: 'DADOS_INVALIDOS' }, { status: 400 });
    const dados = aniversarianteSchema.safeParse(await request.json());
    if (!dados.success)
      return jsonNoStore({ ok: false, erro: 'Dados do aniversariante inválidos.', codigo: 'DADOS_INVALIDOS', detalhes: dados.error.flatten() }, { status: 400 });
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get('empresaId'), (tx, tenant) =>
      cadastrarAniversarianteInterno(clienteId.data, tenant.empresaComprovada, dados.data, contextoCrmDaRequest(request), tx));
    return jsonNoStore({ ok: true, data }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
