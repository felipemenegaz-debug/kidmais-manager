import { z } from 'zod';
import type { DbExecutor } from '../../db/contracts';
import { registrarAuditoria, registrarEventoHistorico } from '../repositories';
import { ClienteServiceError } from './errors';
import type { ClienteServiceContext } from './context';

export const acaoLixeiraSchema = z.object({
    acao: z.enum(['ARQUIVAR','EXCLUIR','RESTAURAR']), motivo: z.string().trim().min(3).max(500),
    chave: z.string().uuid(), atualizadoEm: z.string().datetime({ offset: true }),
    confirmarRemocao: z.boolean().optional(), confirmarHistorico: z.boolean().optional(),
}).strict().refine(p => p.acao === 'RESTAURAR' || p.confirmarRemocao === true && p.confirmarHistorico === true, 'Confirme as duas etapas.');

function recusar(message: string) { return new ClienteServiceError('DADOS_INVALIDOS',message,409); }

/** Caller supplies one transaction. Never removes records or changes business links. */
export async function moverClienteLixeira(tx: DbExecutor, id: string, raw: unknown, ctx: ClienteServiceContext) {
    const p = acaoLixeiraSchema.parse(raw);
    if (!ctx.usuarioId) throw new ClienteServiceError('AUTENTICACAO_ADMINISTRATIVA','Autenticação administrativa obrigatória.',401);
    const atual = (await tx.query<{ status: string; mesma: boolean }>(
        'SELECT status,atualizado_em=$2::timestamptz AS mesma FROM clientes WHERE id=$1 FOR UPDATE',[id,p.atualizadoEm])).rows[0];
    if (!atual) throw new ClienteServiceError('CLIENTE_NAO_ENCONTRADO','Cliente não encontrado.',404);
    const anterior = (await tx.query<{ usuario_id: string; justificativa: string; dados_depois: Record<string, unknown> }>(
        "SELECT usuario_id,justificativa,dados_depois FROM auditoria WHERE entidade_tipo='CLIENTE' AND entidade_id=$1 AND request_id=$2 AND acao IN ('CLIENTE_ARQUIVAR','CLIENTE_EXCLUIR','CLIENTE_RESTAURAR')",[id,p.chave])).rows[0];
    if (anterior) {
        if (anterior.usuario_id !== ctx.usuarioId || anterior.justificativa !== p.motivo || anterior.dados_depois.acao !== p.acao || anterior.dados_depois.base !== p.atualizadoEm) throw recusar('Chave já usada para outra intenção.');
        return { reutilizado: true };
    }
    if (atual.status === 'MESCLADO') throw recusar('Use o cadastro principal do cliente mesclado.');
    if (!atual.mesma) throw recusar('Cadastro atualizado por outra operação. Recarregue antes de confirmar.');
    if (atual.status !== (p.acao === 'RESTAURAR' ? 'INATIVO' : 'ATIVO')) throw recusar('Situação do cliente mudou. Recarregue antes de confirmar.');
    const status = p.acao === 'RESTAURAR' ? 'ATIVO' : 'INATIVO';
    const quando = (await tx.query<{ quando: string }>(
        'UPDATE clientes SET status=$2,atualizado_por_usuario_id=$3,atualizado_em=clock_timestamp() WHERE id=$1 RETURNING clock_timestamp()::text AS quando',[id,status,ctx.usuarioId])).rows[0].quando;
    const depois = { status, acao: p.acao, quando, base: p.atualizadoEm };
    await registrarAuditoria({ clienteId:id, atorTipo:'USUARIO', usuarioId:ctx.usuarioId, acao:`CLIENTE_${p.acao}`, entidadeTipo:'CLIENTE', entidadeId:id,
        dadosAntes:{status:atual.status},dadosDepois:depois,justificativa:p.motivo,origem:'CRM_INTERNO',requestId:p.chave },tx);
    await registrarEventoHistorico({ clienteId:id,clienteOrigemId:id,tipoEvento:`CLIENTE_${p.acao}`,origem:'CRM_INTERNO',entidadeTipo:'CLIENTE',entidadeId:id,
        usuarioId:ctx.usuarioId,detalhe:p.motivo,metadata:{antes:atual.status,...depois,chave:p.chave} },tx);
    return { reutilizado:false };
}

export const consultaLixeiraSql = `SELECT c.id,c.nome_completo AS nome,c.status,to_char(c.atualizado_em AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "atualizadoEm",
 CASE WHEN c.telefone IS NULL AND c.whatsapp IS NULL THEN NULL ELSE '•••• '||right(COALESCE(c.whatsapp,c.telefone),4) END AS contato,
 CASE WHEN c.email IS NULL THEN NULL ELSE left(c.email,1)||'•••@•••' END AS email,
 CASE WHEN c.status='ATIVO' THEN 'Ativo' WHEN a.dados_depois->>'acao'='EXCLUIR' THEN 'Na lixeira' ELSE 'Arquivado' END AS situacao,
 a.dados_depois->>'quando' AS quando,u.nome AS responsavel,a.justificativa AS motivo,
 COALESCE((a.dados_depois->>'quando')::timestamptz <= clock_timestamp()-interval '90 days',false) AND c.status='INATIVO' AS "retencao90Dias"
 FROM clientes c LEFT JOIN LATERAL (
 SELECT dados_depois,usuario_id,justificativa FROM auditoria
 WHERE entidade_tipo='CLIENTE' AND entidade_id=c.id AND acao IN ('CLIENTE_ARQUIVAR','CLIENTE_EXCLUIR','CLIENTE_RESTAURAR')
 ORDER BY (dados_depois->>'quando')::timestamptz DESC,criado_em DESC,id DESC LIMIT 1
 ) a ON true LEFT JOIN usuarios_administrativos u ON u.id=a.usuario_id
 WHERE (($1::uuid IS NULL AND c.status='INATIVO') OR c.id=$1::uuid)
 ORDER BY c.nome_completo,c.id LIMIT $2 OFFSET $3`;

export async function consultarLixeira(tx: DbExecutor, id?: string, offset = 0) {
    return (await tx.query(consultaLixeiraSql,[id??null,id?1:50,offset])).rows;
}
