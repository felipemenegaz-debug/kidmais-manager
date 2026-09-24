import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { db } from '@/lib/db/postgres';
import { criarUsuarioAdministrativo, desativarUsuarioAdministrativo, listarUsuariosAdministrativos } from '@/lib/autenticacao/usuarios';
import { isClienteServiceError } from '@/lib/clientes/services/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, status = 200) {
    return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function fail(error: unknown) {
    if (error instanceof ZodError || error instanceof SyntaxError)
        return json({ ok: false, erro: 'Confira nome, e-mail, nível e senha.' }, 400);
    if (isClienteServiceError(error))
        return json({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus);
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (['23505', '40001', '40P01'].includes(code))
        return json({ ok: false, erro: 'Outra operação alterou este registro. Atualize e tente novamente.' }, 409);
    console.error('[UsuariosAdmin]', code || 'erro');
    return json({ ok: false, erro: 'Não foi possível concluir a operação.' }, 500);
}

export async function GET(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        return json({ ok: true, data: await listarUsuariosAdministrativos(sessao, db()) });
    } catch (error) {
        return fail(error);
    }
}

export async function POST(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const body = await request.json() as { acao?: string };
        const requestId = randomUUID();
        if (body.acao === 'desativar')
            return json({ ok: true, data: await desativarUsuarioAdministrativo(sessao, body, requestId) });
        if (body.acao === 'criar')
            return json({ ok: true, data: await criarUsuarioAdministrativo(sessao, body, requestId) });
        return json({ ok: false, erro: 'Confira nome, e-mail, nível e senha.' }, 400);
    } catch (error) {
        return fail(error);
    }
}
