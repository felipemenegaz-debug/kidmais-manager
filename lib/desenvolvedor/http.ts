import type { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '../http/admin-crm-api.ts';
import { db } from '../db/postgres.ts';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository.ts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { erroAcesso, tabelaAusente } from '../acessos/erros.ts';
import { contextoDaRequisicao, falhar, responder } from '../acessos/http.ts';
import { RECUSA_PAINEL, temConcessaoDesenvolvedor } from './autorizacao.ts';
import { auditarPainel, type ContextoPainel } from './auditoria.ts';

/**
 * Guarda de TODAS as rotas /api/desenvolvedor/*:
 *   1. sessão administrativa válida (e, fora de GET, origem + CSRF) — exigirApiAdminCrmDisponivel;
 *   2. concessão de desenvolvedor ativa no banco — sem ela, 404 genérico e auditoria da recusa;
 *   3. o serviço confere a concessão de novo, travada, dentro da própria transação.
 * Papel global, papel de empresa e ser proprietário não contam.
 */
export async function rotaDesenvolvedor(request: NextRequest, trabalho: (sessao: SessaoAdmin, ctx: ContextoPainel) => Promise<unknown>, status = 200) {
    const ctx = contextoDaRequisicao(request);
    try {
        const sessao = await exigirApiAdminCrmDisponivel(request);
        let concedido: boolean;
        try {
            concedido = await temConcessaoDesenvolvedor(db(), sessao.usuario_id);
        }
        catch (error) {
            if (tabelaAusente(error))
                throw erroAcesso('NAO_ENCONTRADO', RECUSA_PAINEL, 404);
            throw error;
        }
        if (!concedido) {
            await auditarPainel(registrarAuditoria, undefined, {
                atorId: sessao.usuario_id, acao: 'PAINEL_ACESSO_RECUSADO', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: sessao.usuario_id, resultado: 'RECUSADO',
                depois: { metodo: request.method, rota: request.nextUrl.pathname.slice(0, 200) }, ctx,
            }).catch(() => undefined);
            throw erroAcesso('NAO_ENCONTRADO', RECUSA_PAINEL, 404);
        }
        return responder({ ok: true, data: await trabalho(sessao, ctx) }, status);
    }
    catch (error) {
        return falhar(error);
    }
}
