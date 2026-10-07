import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { rotaDesenvolvedor } from '@/lib/desenvolvedor/http';
import { lerJson } from '@/lib/acessos/http';
import { alterarImplantacao, alterarSituacaoEmpresa, atualizarCadastroEmpresa, obterEmpresa } from '@/lib/desenvolvedor/empresas';
import { operarComercial } from '@/lib/desenvolvedor/comercial';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, (sessao) => obterEmpresa(sessao, id));
}

export async function PATCH(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, async (sessao, ctx) => atualizarCadastroEmpresa(sessao, id, await lerJson(request), ctx));
}

const corpoSchema = z.object({ acao: z.enum(['implantacao', 'suspender', 'reativar', 'comercial']), dados: z.unknown() }).strict();

export async function POST(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return rotaDesenvolvedor(request, async (sessao, ctx) => {
        const corpo = corpoSchema.parse(await lerJson(request));
        if (corpo.acao === 'implantacao')
            return alterarImplantacao(sessao, id, corpo.dados, ctx);
        if (corpo.acao === 'comercial')
            return operarComercial(sessao, id, corpo.dados, ctx);
        return alterarSituacaoEmpresa(sessao, id, corpo.acao, corpo.dados, ctx);
    });
}
