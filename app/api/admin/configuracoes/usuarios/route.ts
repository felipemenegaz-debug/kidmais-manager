import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { alterarAssinaturaNaEmpresa, alterarPapelNaEmpresa, criarUsuarioAdministrativo, listarUsuariosAdministrativos, removerDaEmpresa } from '@/lib/autenticacao/usuarios';
import { apiErrorResponse } from '@/lib/http/api-response';
import { PacoteAdminError } from '@/lib/comercial/pacotes-admin';
import { isClienteServiceError } from '@/lib/clientes/services/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, status = 200) {
    return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function fail(error: unknown) {
    if (error instanceof ZodError || error instanceof SyntaxError)
        return json({ ok: false, erro: 'Confira nome, e-mail, nível e senha.' }, 400);
    // Tenant não comprovado (403) e papel desta empresa: mesmas respostas das demais rotas de tenant.
    if (error instanceof PacoteAdminError)
        return apiErrorResponse(error);
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
        // 056: só as memberships DESTA empresa (tenant comprovado); `empresaId` só escolhe entre as do usuário.
        return json({ ok: true, data: await listarUsuariosAdministrativos(sessao, request.nextUrl.searchParams.get('empresaId')) });
    } catch (error) {
        return fail(error);
    }
}

export async function POST(request: NextRequest) {
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        const body = await request.json() as { acao?: string };
        const requestId = randomUUID();
        const empresa = request.nextUrl.searchParams.get('empresaId');
        // 056: desativar a identidade global é ação de PLATAFORMA; a administração da empresa remove a membership.
        if (body.acao === 'desativar')
            return json({ ok: false, erro: 'Desativar a conta em todas as empresas é uma ação da plataforma. Use “Remover desta empresa”.', codigo: 'ACAO_DE_PLATAFORMA' }, 403);
        if (body.acao === 'criar')
            return json({ ok: true, data: await criarUsuarioAdministrativo(sessao, body, requestId, undefined, empresa) });
        if (body.acao === 'papel')
            return json({ ok: true, data: await alterarPapelNaEmpresa(sessao, body, requestId, undefined, empresa) });
        if (body.acao === 'assinatura')
            return json({ ok: true, data: await alterarAssinaturaNaEmpresa(sessao, body, requestId, undefined, empresa) });
        if (body.acao === 'remover')
            return json({ ok: true, data: await removerDaEmpresa(sessao, body, requestId, undefined, empresa) });
        return json({ ok: false, erro: 'Confira nome, e-mail, nível e senha.' }, 400);
    } catch (error) {
        return fail(error);
    }
}
