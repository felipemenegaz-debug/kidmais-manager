import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { FILTROS, decodificarCursor, interpretarBusca, listarContratosPaginados, type Filtro } from '@/lib/contratos/services/lista-contratos';
import { listarContratosImportados } from '@/lib/contratos/importados';
import { hojeBrasilia } from '@/lib/financeiro/calculos';
import { apiErrorResponse } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';

const semCache = { 'Cache-Control': 'no-store' } as const;

/**
 * Lista de contratos da tela (fase 2): página do Core por cursor + contagens dos filtros, e, à parte, os contratos
 * importados ainda em conferência (sem financeiro, fora do cursor). Tudo na transação da empresa comprovada; a busca e o
 * cursor são validados antes. A lista antiga do painel (`/api/admin/contratos/painel` sem contratoId) não muda.
 */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const q = request.nextUrl.searchParams;
    const filtro = z.enum(FILTROS).catch('proximas').parse(q.get('filtro') ?? 'proximas') as Filtro;
    let busca, cursor;
    try { busca = interpretarBusca(q.get('busca')); cursor = decodificarCursor(q.get('cursor'), filtro); }
    catch { return NextResponse.json({ ok: false, erro: 'Busca ou página inválida.', codigo: 'DADOS_INVALIDOS' }, { status: 400, headers: semCache }); }
    const hoje = hojeBrasilia();
    const data = await withTenantTransaction(sessao, q.get('empresaId'), async (tx, tenant) => {
      const pagina = await listarContratosPaginados(tx, tenant.empresaComprovada, { filtro, busca, cursor, hoje });
      // Importados: só na primeira página e sem busca por texto (a projeção própria não tem os mesmos campos).
      const importados = cursor ? [] : (await listarContratosImportados(tx, tenant.empresaComprovada, hoje))
        .filter((i) => !busca.texto || (i.nome ?? '').toLowerCase().includes(busca.texto.replace(/\\(.)/g, '$1')))
        .filter((i) => !busca.data || i.data_evento === busca.data);
      return { ...pagina, importados };
    });
    return NextResponse.json({ ok: true, data }, { headers: semCache });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
