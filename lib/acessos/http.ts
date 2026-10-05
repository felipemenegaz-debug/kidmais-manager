import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { isClienteServiceError } from '../clientes/services/errors.ts';
import { isAcessoServiceError, tabelaAusente } from './erros.ts';

/**
 * HTTP comum dos fluxos de acesso (painel do desenvolvedor, perfil, convite e recuperação).
 * Respostas sempre `no-store`; erros sem detalhe interno; nada de senha, token ou link nas respostas de erro.
 */
export function responder(data: unknown, status = 200) {
    return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * IP do cliente para limites e auditoria. Em deploy reconhecido (Render), o proxy ACRESCENTA o IP real ao fim do
 * X-Forwarded-For; o começo da lista pode vir do próprio cliente, então só o último valor é confiável.
 * Fora do deploy (local) não há proxy confiável: null.
 */
export function ipDaRequisicao(request: { headers: { get(nome: string): string | null } }, env: { RENDER?: string } = { RENDER: process.env.RENDER }) {
    if (env.RENDER !== 'true')
        return null;
    const valores = (request.headers.get('x-forwarded-for') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    const ultimo = valores.at(-1) ?? '';
    return isIP(ultimo) ? ultimo : null;
}

export function contextoDaRequisicao(request: NextRequest) {
    return { requestId: randomUUID(), ip: ipDaRequisicao(request), userAgent: request.headers.get('user-agent')?.slice(0, 1000) ?? null };
}

export function falhar(error: unknown) {
    if (isAcessoServiceError(error))
        return responder({ ok: false, erro: error.message, codigo: error.code, detalhes: error.details ?? null }, error.httpStatus);
    if (isClienteServiceError(error))
        return responder({ ok: false, erro: error.message, codigo: error.code }, error.httpStatus);
    if (error instanceof ZodError) {
        const primeiro = error.issues[0];
        return responder({ ok: false, erro: primeiro?.message && !/^Invalid|^Expected/.test(primeiro.message) ? primeiro.message : 'Dados inválidos.', codigo: 'DADOS_INVALIDOS', detalhes: { campo: primeiro?.path.join('.') ?? null } }, 400);
    }
    if (error instanceof SyntaxError)
        return responder({ ok: false, erro: 'Dados inválidos.', codigo: 'DADOS_INVALIDOS' }, 400);
    if (tabelaAusente(error))
        return responder({ ok: false, erro: 'Recurso indisponível neste ambiente: a migration 063 ainda não foi aplicada.', codigo: 'PAINEL_INDISPONIVEL' }, 503);
    console.error('[acessos] erro não tratado', error instanceof Error ? error.name : typeof error);
    return responder({ ok: false, erro: 'Não foi possível concluir a operação. Nada foi alterado além do que a tela mostrar.', codigo: 'ERRO_INTERNO' }, 500);
}

export async function lerJson(request: NextRequest): Promise<unknown> {
    const texto = await request.text();
    if (texto.length > 64_000)
        throw new SyntaxError('corpo grande demais');
    return texto ? JSON.parse(texto) : {};
}
