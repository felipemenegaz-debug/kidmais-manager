import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { coreNativo } from '@/lib/contratos/integracao-importados/composicao';
import {
  conferirFinanceiro, confirmarIntegracao, IntegracaoImportadoError, opcoesIntegracao, simularFinanceiro, simularIntegracao,
} from '@/lib/contratos/integracao-importados/servico';
import { hojeBrasilia } from '@/lib/financeiro/calculos';
import { exigirApiAdminCrmDisponivel, tokenAdmin } from '@/lib/http/admin-crm-api';
import { apiErrorResponse } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const semCache = { 'Cache-Control': 'no-store' } as const;
const HASH = z.string().regex(/^[0-9a-f]{64}$/);

const pedidoSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('simular'), decisoes: z.unknown() }).strict(),
  z.object({ acao: z.literal('confirmar'), decisoes: z.unknown(), resumoHash: HASH, chave: z.string().uuid() }).strict(),
  z.object({ acao: z.literal('simular-financeiro'), financeiro: z.unknown() }).strict(),
  z.object({ acao: z.literal('conferir-financeiro'), financeiro: z.unknown(), resumoHash: HASH, chave: z.string().uuid() }).strict(),
]);

/**
 * Recusas do banco (gatilhos 019/057/061/062, inclusive no commit) e disputas de lock viram 409 sem detalhes internos.
 * A resposta nunca identifica a contratação ocupante.
 */
function erroDeBanco(e: unknown) {
  const codigo = (e as { code?: unknown })?.code;
  if (codigo === '40P01' || codigo === '40001' || codigo === '55P03') {
    return NextResponse.json({ ok: false, erro: 'Outra operação concorrente está usando estes dados. Tente de novo.', codigo: 'CONCORRENCIA' }, { status: 409, headers: semCache });
  }
  if (codigo === '23505') {
    return NextResponse.json({ ok: false, erro: 'Este contrato importado já foi integrado ou a confirmação foi repetida. Recarregue a página.', codigo: 'IMPORTACAO_JA_INTEGRADA' }, { status: 409, headers: semCache });
  }
  if (codigo === '23503') {
    return NextResponse.json({ ok: false, erro: 'Um cadastro usado na integração mudou ou não existe mais. Recarregue e confira de novo. Nada foi gravado.', codigo: 'REFERENCIA_INVALIDA' }, { status: 409, headers: semCache });
  }
  if (codigo === '23514' || codigo === 'P0001') {
    const mensagem = String((e as { message?: unknown }).message ?? '');
    if (/^062: unidade/.test(mensagem)) {
      return NextResponse.json({ ok: false, erro: 'A unidade escolhida não está habilitada para a agenda (ou foi revogada). Nada foi gravado.', codigo: 'UNIDADE_NAO_HABILITADA' }, { status: 409, headers: semCache });
    }
    if (/^061: a versão conferida/.test(mensagem)) {
      return NextResponse.json({ ok: false, erro: 'O contrato mudou desde a integração: confira os pagamentos no financeiro do contrato. Nada foi gravado.', codigo: 'VERSAO_NAO_VIGENTE' }, { status: 409, headers: semCache });
    }
    const agenda = /Conflito|Horário indisponível|bloqueio/i.test(mensagem);
    return NextResponse.json({
      ok: false,
      erro: agenda ? 'O horário ficou indisponível na agenda durante a confirmação. Nada foi gravado.' : 'O banco recusou a integração por inconsistência. Nada foi gravado.',
      codigo: agenda ? 'CONFLITO_AGENDA' : 'INTEGRACAO_RECUSADA',
    }, { status: 409, headers: semCache });
  }
  return null;
}

function resposta(e: unknown) {
  if (e instanceof IntegracaoImportadoError) {
    return NextResponse.json({ ok: false, erro: e.message, codigo: e.code, detalhes: e.details ?? null }, { status: e.httpStatus, headers: semCache });
  }
  return erroDeBanco(e) ?? apiErrorResponse(e);
}

async function importacaoDaRota(context: { params: Promise<{ importacaoId: string }> }) {
  const id = z.string().uuid().safeParse((await context.params).importacaoId);
  return id.success ? id.data.toLowerCase() : null;
}

/** Opções do assistente "Integrar ao sistema" para um contrato importado da empresa comprovada. */
export async function GET(request: NextRequest, context: { params: Promise<{ importacaoId: string }> }) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const importacaoId = await importacaoDaRota(context);
    if (!importacaoId) return NextResponse.json({ ok: false, erro: 'Contrato inválido.' }, { status: 400, headers: semCache });
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get('empresaId'), (tx, tenant) =>
      opcoesIntegracao(tx, tenant, importacaoId, hojeBrasilia()));
    return NextResponse.json({ ok: true, data }, { headers: semCache });
  } catch (e) {
    return resposta(e);
  }
}

/**
 * simular / confirmar a integração; simular-financeiro / conferir-financeiro para a pendência "Conferir pagamentos".
 * Confirmar exige autenticação recente (senha nos últimos 5 minutos), o hash do resumo que o operador viu e uma chave
 * de idempotência: a mesma chave com o mesmo conteúdo devolve o resultado gravado; com outro conteúdo, 409.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ importacaoId: string }> }) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const importacaoId = await importacaoDaRota(context);
    if (!importacaoId) return NextResponse.json({ ok: false, erro: 'Contrato inválido.' }, { status: 400, headers: semCache });
    const pedido = pedidoSchema.parse(await request.json());
    // ip: null como no restante do Admin (contextoCrmDaRequest): sem proxy confiável declarado, o cabeçalho não é prova.
    const ctx = { usuarioId: sessao.usuario_id, token: tokenAdmin(request), requestId: randomUUID(), ip: null, userAgent: request.headers.get('user-agent')?.slice(0, 1000) ?? null, autenticadoEm: sessao.autenticado_em };
    const hoje = hojeBrasilia();
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get('empresaId'), (tx, tenant): Promise<unknown> => {
      if (tenant.usuarioId !== ctx.usuarioId) throw new IntegracaoImportadoError('OPERACAO_NAO_AUTORIZADA', 'Sessão divergente.', 403);
      switch (pedido.acao) {
        case 'simular': return simularIntegracao(tx, tenant, importacaoId, pedido.decisoes, hoje);
        case 'confirmar': return confirmarIntegracao(tx, tenant, ctx, importacaoId, { decisoes: pedido.decisoes, resumoHash: pedido.resumoHash, chave: pedido.chave.toLowerCase() }, hoje, coreNativo);
        case 'simular-financeiro': return simularFinanceiro(tx, tenant, importacaoId, pedido.financeiro, hoje);
        case 'conferir-financeiro': return conferirFinanceiro(tx, tenant, ctx, importacaoId, { financeiro: pedido.financeiro, resumoHash: pedido.resumoHash, chave: pedido.chave.toLowerCase() }, hoje, coreNativo);
      }
    });
    return NextResponse.json({ ok: true, data }, { headers: semCache });
  } catch (e) {
    return resposta(e);
  }
}
