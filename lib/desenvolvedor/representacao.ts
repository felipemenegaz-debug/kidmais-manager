import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { exigirDesenvolvedorNaTransacao, exigirReautenticacaoRecente } from './autorizacao.ts';
import { auditarPainel, type ContextoPainel } from './auditoria.ts';
import { painelDepsPadrao, type PainelDeps } from './interessadas.ts';

/**
 * Representação, sócios declarados e pedidos de acesso de uma empresa (067/069) no painel do desenvolvedor.
 *
 * Representação declarada no cadastro fica DECLARADA até a decisão da plataforma (aprovar/recusar; aprovada pode ser
 * revogada). Validar dígitos de CNPJ ou consultar cadastro público NÃO certifica representação: a decisão é humana,
 * com motivo e evidência descrita, e não muda acesso algum (memberships continuam sendo a única fonte de acesso).
 * Pedido de acesso (CNPJ já cadastrado) é registrado aqui; atendê-lo = convidar a pessoa pelo fluxo de convites.
 */
const ISO = (c: string) => `to_char((${c}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function instalada(tx: DbExecutor, tabela: string) {
    return (await tx.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${tabela}`])).rows[0]?.ok === true;
}

export async function representacaoDaEmpresa(tx: DbExecutor, empresaId: string) {
    const representacoes = await instalada(tx, 'empresa_representacoes') ? (await tx.query<{ id: string; pessoa: string; email: string; qualificacao: string; situacao: string; declarado_em: string; decidido_em: string | null; decidido_por: string | null; motivo_decisao: string | null }>(
        `SELECT r.id, u.nome AS pessoa, u.email, r.qualificacao, r.situacao, ${ISO('r.declarado_em')} AS declarado_em, ${ISO('r.decidido_em')} AS decidido_em,
                d.nome AS decidido_por, r.motivo_decisao
           FROM empresa_representacoes r JOIN usuarios_administrativos u ON u.id = r.usuario_id LEFT JOIN usuarios_administrativos d ON d.id = r.decidido_por
          WHERE r.empresa_id = $1::uuid ORDER BY r.declarado_em DESC LIMIT 20`, [empresaId])).rows : [];
    const cadastro069 = await instalada(tx, 'empresa_socios');
    const socios = cadastro069 ? (await tx.query<{ nome: string; qualificacao: string; criado_em: string }>(
        `SELECT nome, qualificacao, ${ISO('criado_em')} AS criado_em FROM empresa_socios WHERE empresa_id = $1::uuid ORDER BY criado_em, nome`, [empresaId])).rows : [];
    const solicitacoes = cadastro069 ? (await tx.query<{ id: string; pessoa: string; email: string; situacao: string; criado_em: string; motivo_decisao: string | null }>(
        `SELECT s.id, u.nome AS pessoa, u.email, s.situacao, ${ISO('s.criado_em')} AS criado_em, s.motivo_decisao
           FROM solicitacoes_acesso_empresa s JOIN usuarios_administrativos u ON u.id = s.usuario_id
          WHERE s.empresa_id = $1::uuid ORDER BY s.criado_em DESC LIMIT 20`, [empresaId])).rows : [];
    return { instalada: representacoes.length > 0 || await instalada(tx, 'empresa_representacoes'), representacoes, socios, solicitacoes };
}

const motivo = z.string().trim().min(5, 'Informe o motivo (5 a 500 caracteres).').max(500);
const decisaoSchema = z.discriminatedUnion('alvo', [
    z.object({ alvo: z.literal('representacao'), id: z.string().uuid(), decisao: z.enum(['APROVADA', 'RECUSADA', 'REVOGADA']), motivo, evidencia: z.string().trim().max(1000).optional() }).strict(),
    z.object({ alvo: z.literal('solicitacao'), id: z.string().uuid(), decisao: z.enum(['ATENDIDA', 'RECUSADA']), motivo }).strict(),
]);

export async function decidirRepresentacaoOuPedido(sessao: SessaoAdmin, id: string, raw: unknown, ctx: ContextoPainel, deps: PainelDeps = painelDepsPadrao) {
    exigirReautenticacaoRecente(sessao);
    const empresaId = z.string().uuid().parse(id);
    const input = decisaoSchema.parse(raw);
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        if (input.alvo === 'representacao') {
            const atual = (await tx.query<{ situacao: string; usuario_id: string; qualificacao: string }>(
                'SELECT situacao, usuario_id, qualificacao FROM empresa_representacoes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE', [input.id, empresaId])).rows[0];
            if (!atual)
                throw erroAcesso('NAO_ENCONTRADO', 'Representação não encontrada nesta empresa.', 404);
            const permitido = (atual.situacao === 'DECLARADA' && input.decisao !== 'REVOGADA') || (atual.situacao === 'APROVADA' && input.decisao === 'REVOGADA');
            if (!permitido)
                throw erroAcesso('CONFLITO', `Não é possível passar de ${atual.situacao.toLowerCase()} para ${input.decisao.toLowerCase()}.`, 409);
            await tx.query(
                `UPDATE empresa_representacoes SET situacao = $3, decidido_por = $4::uuid, decidido_em = clock_timestamp(), motivo_decisao = $5,
                        descricao_evidencia = coalesce($6, descricao_evidencia)
                  WHERE id = $1::uuid AND empresa_id = $2::uuid`, [input.id, empresaId, input.decisao, sessao.usuario_id, input.motivo, input.evidencia || null]);
            await auditarPainel(deps.registrarAuditoria, tx, {
                atorId: sessao.usuario_id, acao: `REPRESENTACAO_${input.decisao}`, entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId, resultado: 'SUCESSO',
                antes: { situacao: atual.situacao }, depois: { representacaoId: input.id, pessoaId: atual.usuario_id, qualificacao: atual.qualificacao, situacao: input.decisao }, justificativa: input.motivo, ctx,
            });
            return { alvo: input.alvo, situacao: input.decisao };
        }
        const pedido = (await tx.query<{ situacao: string; usuario_id: string }>(
            'SELECT situacao, usuario_id FROM solicitacoes_acesso_empresa WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE', [input.id, empresaId])).rows[0];
        if (!pedido)
            throw erroAcesso('NAO_ENCONTRADO', 'Pedido de acesso não encontrado nesta empresa.', 404);
        if (pedido.situacao !== 'PENDENTE')
            throw erroAcesso('CONFLITO', 'Este pedido já foi decidido.', 409);
        await tx.query(`UPDATE solicitacoes_acesso_empresa SET situacao = $3, decidido_por = $4::uuid, decidido_em = clock_timestamp(), motivo_decisao = $5
                         WHERE id = $1::uuid AND empresa_id = $2::uuid`, [input.id, empresaId, input.decisao, sessao.usuario_id, input.motivo]);
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: `PEDIDO_ACESSO_${input.decisao}`, entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId, resultado: 'SUCESSO',
            antes: { situacao: 'PENDENTE' }, depois: { solicitacaoId: input.id, pessoaId: pedido.usuario_id, situacao: input.decisao }, justificativa: input.motivo, ctx,
        });
        return { alvo: input.alvo, situacao: input.decisao };
    });
}
