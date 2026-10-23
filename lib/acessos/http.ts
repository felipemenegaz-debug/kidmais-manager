import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { isClienteServiceError } from '../clientes/services/errors.ts';
import { isAcessoServiceError, tabelaAusente } from './erros.ts';
import { ambienteDaOrigem, origemConfiavel } from '../http/origem-cliente.ts';

/**
 * HTTP comum dos fluxos de acesso (painel do desenvolvedor, perfil, convite e recuperação).
 * Respostas sempre `no-store`; erros sem detalhe interno; nada de senha, token ou link nas respostas de erro.
 */
export function responder(data: unknown, status = 200) {
    return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * IP do cliente para limites e auditoria. No Render com a borda confirmada (ORIGEM_CLIENTE_BORDA), o penúltimo valor
 * do X-Forwarded-For (o último é um salto da infraestrutura; o começo da lista pode vir do próprio cliente), público e
 * conferido com CF-Connecting-IP (lib/http/origem-cliente.ts). Fora disso, em divergência ou formato inesperado: null.
 * Quem recebe null limita pelo fluxo/identificador (lib/acessos/limite-origem.ts), nunca por uma chave global de IP.
 */
export function ipDaRequisicao(request: { headers: { get(nome: string): string | null } }, env: { RENDER?: string; ORIGEM_CLIENTE_BORDA?: string } = ambienteDaOrigem()) {
    return origemConfiavel(request, env);
}

export function contextoDaRequisicao(request: NextRequest) {
    return { requestId: randomUUID(), ip: ipDaRequisicao(request), userAgent: request.headers.get('user-agent')?.slice(0, 1000) ?? null };
}

/**
 * 429 com prazo calculável leva `Retry-After` (segundos, inteiro ≥ 1), lido de `details.retryAfterSegundos`.
 * Sem prazo conhecido, nenhum cabeçalho é inventado.
 */
export function comRetryAfter(res: NextResponse, status: number, details: Record<string, unknown> | null | undefined) {
    const segundos = details?.retryAfterSegundos;
    if (status === 429 && typeof segundos === 'number' && Number.isFinite(segundos) && segundos > 0)
        res.headers.set('Retry-After', String(Math.max(1, Math.ceil(segundos))));
    return res;
}

export function falhar(error: unknown) {
    if (isAcessoServiceError(error))
        return comRetryAfter(responder({ ok: false, erro: error.message, codigo: error.code, detalhes: error.details ?? null }, error.httpStatus), error.httpStatus, error.details);
    if (isClienteServiceError(error))
        return comRetryAfter(responder({ ok: false, erro: error.message, codigo: error.code, detalhes: error.details ?? null }, error.httpStatus), error.httpStatus, error.details);
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
