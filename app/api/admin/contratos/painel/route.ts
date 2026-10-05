import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { detalheAdministrativo } from '@/lib/contratos/services/administrativo.service';
import { contratoNoTenant, executarComPosseNoTenant, listarContratosDoTenant } from '@/lib/contratos/services/contrato-tenant';
import { contratoIntegradoDaImportacao, detalheContratoImportado, listarContratosImportados, origemHistoricaDoContrato } from '@/lib/contratos/importados';
import { hojeBrasilia } from '@/lib/financeiro/calculos';
import { apiErrorResponse } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
const semCache = { 'Cache-Control': 'no-store' } as const;
export async function GET(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const q = request.nextUrl.searchParams, empresaSolicitada = q.get('empresaId');
        const id = q.get('contratoId'), importacaoId = q.get('importacaoId');
        if ((id && !z.string().uuid().safeParse(id).success) || (importacaoId && !z.string().uuid().safeParse(importacaoId).success))
            return NextResponse.json({ ok: false, erro: 'Contrato inválido.' }, { status: 400, headers: semCache });
        // Tenant Context (B2/D1): detalhe lido na MESMA transação da posse provada; lista já filtrada pela empresa no SQL.
        let data: unknown;
        if (id) {
            // Contrato integrado de importação histórica: o mesmo detalhe do Core + a origem (conferência em papel, original, correções).
            data = await executarComPosseNoTenant(sessao, empresaSolicitada, id, contratoNoTenant, { withTenantTransaction }, async (tx, tenant) => ({
                ...await detalheAdministrativo(id, tx),
                origemHistorica: await origemHistoricaDoContrato(tx, tenant.empresaComprovada, id.toLowerCase(), tenant.papelAtual),
                festaId: (await tx.query<{ id: string }>(
                    'SELECT f.id FROM festas f JOIN contratos c ON c.id=f.contrato_id JOIN fechamentos fe ON fe.id=c.fechamento_id WHERE f.contrato_id=$1 AND fe.empresa_id=$2::uuid AND f.invalidada_em IS NULL LIMIT 1',
                    [id, tenant.empresaComprovada],
                )).rows[0]?.id ?? null,
            }));
        }
        else if (importacaoId) {
            // Contrato importado (somente leitura): empresa comprovada no SQL; outra empresa ou inexistente ⇒ 404 igual.
            // Já integrada: o link antigo leva ao contrato do Core (sem exibir a projeção duplicada).
            const importado = await withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
                const contratoId = await contratoIntegradoDaImportacao(tx, tenant.empresaComprovada, importacaoId.toLowerCase());
                return contratoId ? { integrado: true as const, contratoId } : detalheContratoImportado(tx, tenant.empresaComprovada, hojeBrasilia(), importacaoId.toLowerCase(), tenant.papelAtual);
            });
            if (!importado) return NextResponse.json({ ok: false, erro: 'Contrato não encontrado.' }, { status: 404, headers: semCache });
            data = importado;
        }
        else {
            data = await withTenantTransaction(sessao, empresaSolicitada, (tx, tenant) => listarContratosDoTenant(tx, tenant.empresaComprovada, q.get('incluirCancelados') === '1'));
            // Contratos importados (somente leitura, `ia_importacoes`) entram na lista por padrão; `incluirImportados=0` os oculta.
            if (q.get('incluirImportados') !== '0') {
                const importados = await withTenantTransaction(sessao, empresaSolicitada, (tx, tenant) => listarContratosImportados(tx, tenant.empresaComprovada, hojeBrasilia()));
                data = [...(data as unknown[]), ...importados];
            }
        }
        return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (e) {
        return apiErrorResponse(e);
    }
}
