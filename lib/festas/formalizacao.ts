import { createHash, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { FestaError } from './domain.ts';

export type ContextoFormalizacao = { requestId?: string | null; userAgent?: string | null };

/** Uses the caller's transaction exclusively; never authenticates an administrative session. */
export async function bloquearAgendaFormalizacao(tx: DbExecutor, contratoId: string) {
    await tx.query('SELECT public.kidmais019_bloquear_contrato($1::uuid)', [contratoId]);
    // Separate statement after the advisory lock: READ COMMITTED sees the last winner.
    await tx.query('SELECT public.kidmais019_validar_destino($1::uuid)', [contratoId]);
}

export async function garantirFestaFormalizada(
    tx: DbExecutor, contratoId: string, versaoId: string, context: ContextoFormalizacao = {},
    modo: 'CRIAR' | 'RETRY' | 'RECONCILIAR' = 'CRIAR',
) {
    const formal = (await tx.query<{ valida: boolean }>(
        'SELECT public.kidmais019_formalizacao($1::uuid,$2::uuid) AS valida', [contratoId, versaoId],
    )).rows[0];
    if (!formal?.valida) throw new FestaError('Formalização incompleta ou documento divergente.');
    const existentes = (await tx.query<{ id: string; invalidada_em: string | null }>(
        'SELECT id,invalidada_em FROM public.festas WHERE contrato_id=$1 ORDER BY criado_em FOR UPDATE', [contratoId],
    )).rows;
    const ativa = existentes.find(f => !f.invalidada_em);
    if (ativa) return { festaId: ativa.id, reutilizado: true };
    if (existentes.length) throw new FestaError('Festa invalidada: reconciliação explícita necessária.');
    if (modo === 'RETRY') throw new FestaError('Contrato anterior sem Festa. Reconciliação explícita necessária.');
    await bloquearAgendaFormalizacao(tx, contratoId);
    const assinaturas = (await tx.query<{ id: string; parte: string }>(
        'SELECT id,parte FROM public.contrato_assinaturas WHERE contrato_versao_id=$1 ORDER BY parte', [versaoId],
    )).rows;
    const chave = randomUUID(), requestId = context.requestId ?? randomUUID();
    const causa = { origem: 'AUTOMATICA_FORMALIZACAO', ator: 'SISTEMA', contratoId, versaoId, assinaturas, requestId, modo };
    const payloadHash = createHash('sha256').update(JSON.stringify(causa)).digest('hex');
    const f = (await tx.query<{ id: string }>(`INSERT INTO public.festas
        (contrato_id,versao_contratual_criacao_id,chave_criacao,payload_hash,criado_por,origem_criacao)
        VALUES($1,$2,$3,$4,NULL,'AUTOMATICA_FORMALIZACAO') RETURNING id`,
    [contratoId, versaoId, chave, payloadHash])).rows[0];
    await tx.query(`INSERT INTO public.festa_eventos
        (festa_id,tipo,entidade_id,usuario_id,identidade_snapshot,request_id,chave_idempotencia,
         payload_hash,versao_contratual_id,dados_antes,dados_depois,motivo,ocorrido_em,ator_tipo,origem_iniciadora)
        VALUES($1,'FESTA_CRIADA',$1,NULL,$2::jsonb,$3,$4,$5,$6,NULL,$2::jsonb,
         'Criação automática após formalização das duas partes',clock_timestamp(),'SISTEMA','CONTRATO')`,
    [f.id, JSON.stringify(causa), requestId, chave, payloadHash, versaoId]);
    await tx.query(`INSERT INTO public.auditoria
        (ator_tipo,acao,entidade_tipo,entidade_id,dados_depois,justificativa,origem,request_id,user_agent)
        VALUES('SISTEMA','FESTA_CRIADA','FESTA',$1,$2::jsonb,
        'Formalização contratual das duas partes','FESTA',$3,$4)`,
    [f.id, JSON.stringify(causa), requestId, context.userAgent ?? null]);
    await tx.query(`INSERT INTO public.eventos_historico_cliente
        (cliente_id,tipo_evento,origem,entidade_tipo,entidade_id,detalhe,metadata)
        SELECT f.cliente_id,'FESTA_CRIADA','CONTRATO','FESTA',$2,
        'Festa criada automaticamente após as duas assinaturas',$3::jsonb
        FROM public.contratos c JOIN public.fechamentos f ON f.id=c.fechamento_id WHERE c.id=$1`,
    [contratoId, f.id, JSON.stringify(causa)]);
    return { festaId: f.id, reutilizado: false };
}
