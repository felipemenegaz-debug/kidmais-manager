import { createHash, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { FestaError } from './domain.ts';
import { escolherSalaoDoContrato } from '../agenda/salao-festa.ts';
import type { OrigemSalao } from '../agenda/escrever-salao.ts';
import { salaoExigidoOuRecusa } from '../contratos/services/salao-contrato.ts';
import { exigirTravaConfiguracao } from '../agenda/trava-configuracao.ts';

export type ContextoFormalizacao = { requestId?: string | null; userAgent?: string | null };

/** Uses the caller's transaction exclusively; never authenticates an administrative session. */
/**
 * S-E: `versaoId` = versão sob a qual a festa é formalizada; se ela (ou a base, numa revisão) fixa um salão (V3), ele é
 * EXIGIDO (sem substituto) e a versão precisa bater com a festa; sem salão fixado, a escolha automática da 094 continua.
 */
/**
 * Plano "liberar mais de um salão" (D-LIB-4, rev. 5/6): o caminho diz o estado documental exigido —
 * FORMALIZACAO_PRE_ASSINATURA (entrada 4a, contrato-publico antes da assinatura: versão em preparação, sem prova CLIENTE)
 * ou FORMALIZACAO_POS_ASSINATURA (entradas 5 e 16: vigente com dupla prova nativa). Documento sem salão = curinga:
 * a festa fica como está e a validação do destino decide, sem escolha automática.
 */
export type MarcaFormalizacao = { caminho: 'FORMALIZACAO_PRE_ASSINATURA' | 'FORMALIZACAO_POS_ASSINATURA'; origem: OrigemSalao };

export async function bloquearAgendaFormalizacao(tx: DbExecutor, contratoId: string, versaoId: string, marca: MarcaFormalizacao) {
    await exigirTravaConfiguracao(tx);
    await tx.query('SELECT public.kidmais019_bloquear_contrato($1::uuid)', [contratoId]);
    // 094: com capacidade por salão, o sistema escolhe o salão livre antes da conferência (decisão de Felipe).
    // Rodada 2 (PG de 27/10): ao assinar uma REVISÃO, o salão exigido é o da base e a festa continua nele só até a
    // aplicação; a capacidade dele não é reavaliada (a revisão é justamente o que leva a festa ao destino que comporta,
    // e o destino é conferido pela conclusão da revisão). Continua exigido: a festa no salão da base, elegível e livre.
    const exigido = await salaoExigidoOuRecusa(tx, versaoId, marca.caminho);
    await escolherSalaoDoContrato(tx, contratoId, exigido ? { ...marca, exigido: exigido.salaoId, capacidade: !exigido.daBase } : { ...marca, exigido: null });
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
    // Entrada 5 (CRIAR, aceite público) ou 16 (RECONCILIAR, ferramenta operacional): a origem vem do modo.
    await bloquearAgendaFormalizacao(tx, contratoId, versaoId, {
        caminho: 'FORMALIZACAO_POS_ASSINATURA', origem: modo === 'RECONCILIAR' ? 'RECONCILIACAO_OPERACIONAL' : 'ACEITE_PUBLICO' });
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
