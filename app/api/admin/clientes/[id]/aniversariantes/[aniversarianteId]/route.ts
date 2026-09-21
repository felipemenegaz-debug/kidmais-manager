import { NextRequest } from 'next/server';
import { z } from 'zod';
import { editarAniversarianteInterno } from '@/lib/clientes/services';
import { apiErrorResponse, jsonNoStore } from '@/lib/http/api-response';
import { contextoCrmDaRequest, exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { aniversarianteSchema } from '../../../schemas';

type RouteContext = { params: Promise<{ id: string; aniversarianteId: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const params = await context.params;
    const clienteId = z.string().uuid().safeParse(params.id);
    const aniversarianteId = z.string().uuid().safeParse(params.aniversarianteId);
    if (!clienteId.success || !aniversarianteId.success)
      return jsonNoStore({ ok: false, erro: 'Identificador inválido.', codigo: 'DADOS_INVALIDOS' }, { status: 400 });
    const dados = aniversarianteSchema.safeParse(await request.json());
    if (!dados.success)
      return jsonNoStore({ ok: false, erro: 'Dados do aniversariante inválidos.', codigo: 'DADOS_INVALIDOS', detalhes: dados.error.flatten() }, { status: 400 });
    const data = await editarAniversarianteInterno(clienteId.data, aniversarianteId.data, dados.data, contextoCrmDaRequest(request));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
