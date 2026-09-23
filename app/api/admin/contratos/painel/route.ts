import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db/postgres';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { detalheAdministrativo } from '@/lib/contratos/services/administrativo.service';
import { apiErrorResponse } from '@/lib/http/api-response';
export async function GET(request: NextRequest) {
    try {
        await exigirApiAdminCrmDisponivel(request);
        const id = request.nextUrl.searchParams.get('contratoId');
        if (id && !z.string().uuid().safeParse(id).success)
            return NextResponse.json({ ok: false, erro: 'Contrato inválido.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
        const data = id ? await detalheAdministrativo(z.string().uuid().parse(id)) : (await db().query(`SELECT c.id,c.fechamento_id,CASE WHEN c.status<>'ASSINADO' AND e.estado='CANCELADA' THEN 'PREPARACAO_CANCELADA' ELSE c.status END AS status,v.snapshot->'contratante'->>'nomeCompleto' AS nome,v.snapshot->'evento'->>'data' AS data_evento,v.snapshot->'evento'->'pacote'->>'nome' AS pacote,v.snapshot->'evento'->>'convidados' AS convidados FROM contratos c LEFT JOIN contrato_versoes v ON v.contrato_id=c.id AND v.numero_versao=c.versao_atual LEFT JOIN contrato_edicoes e ON e.contrato_versao_id=v.id WHERE ($1::boolean OR (c.status <> 'CANCELADO' AND (e.estado IS DISTINCT FROM 'CANCELADA' OR c.status='ASSINADO'))) ORDER BY c.criado_em DESC`,[request.nextUrl.searchParams.get('incluirCancelados')==='1'])).rows;
        return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (e) {
        return apiErrorResponse(e);
    }
}
