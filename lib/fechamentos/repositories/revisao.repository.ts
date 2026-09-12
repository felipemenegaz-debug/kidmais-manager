import {escolhasDisponiveis,colunasEscolhas} from './escolhas-buffet';
import type { DbExecutor } from '../../db/contracts';
import { db } from '../../db/postgres';
import type { FechamentoRecord, FechamentoAdicionalRecord } from './models';
export const camposOperacao = ['cliente_id', 'responsavel_adicional_id', 'aniversariante_id', 'idade_aniversariante_evento', 'tema_festa', 'data_evento', 'horario_inicio', 'horario_fim', 'configuracao_agenda_id', 'pacote_id', 'tabela_preco_id', 'preco_pacote_id', 'regra_desconto_pacote_id', 'categoria_horario', 'categoria_preco_aplicada', 'convidados', 'convidados_faturados', 'valor_pacote_base', 'desconto_percentual', 'valor_desconto_pacote', 'valor_pacote_aplicado', 'valor_adicionais', 'valor_tabela', 'valor_negociado', 'valor_aprovado', 'motivo_negociacao', 'observacoes_negociacao', 'forma_pagamento_pretendida', 'condicao_pagamento', 'alteracoes_pacote', 'observacoes_cliente', 'observacoes_equipe', 'usuario_responsavel_id', 'buffet_status', 'buffet_salgados', 'buffet_bebidas', 'buffet_doces', 'buffet_bolo', 'buffet_outros', 'buffet_lembrancinha', 'buffet_empratado', 'buffet_bombom'] as const;
const camposItens = ['adicional_id', 'preco_adicional_id', 'nome_aplicado', 'unidade_cobranca_aplicada', 'quantidade', 'valor_unitario_aplicado', 'valor_total', 'observacoes'] as const;
export type RevisaoOperacional = {
    id: string;
    fechamento_id: string;
    contrato_id: string;
    contrato_versao_id: string;
    versao_base_id: string;
    estado: 'EM_ELABORACAO' | 'CONGELADA' | 'APLICADA' | 'CANCELADA';
    revisao: number;
    motivo: string;
    fonte_base_hash: string;
    conteudo_hash: string;
    hold_destino_adquirido_em: string | null;
    revisao_comercial_aprovada: number | null;
    congelado_documento_id: string | null;
    operacao: FechamentoRecord;
};
const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function mapOperation(row: Record<string, unknown>, base: FechamentoRecord): FechamentoRecord {
    const data: Record<string, unknown> = { ...base };
    for (const key of camposOperacao) {
        let value = row[key] ?? null;
        if (value !== null && (key.startsWith('valor_') || key === 'desconto_percentual' || key === 'convidados' || key === 'convidados_faturados' || key === 'idade_aniversariante_evento'))
            value = Number(value);
        data[camel(key)] = value;
    }
    return data as FechamentoRecord;
}
export async function buscarRevisaoDaVersao(vid: string, tx: DbExecutor = db(), lock = false) {
    const row = (await tx.query<Record<string, unknown>>(`SELECT r.*,r.data_evento::text AS data_evento,r.hold_destino_adquirido_em::text AS hold_destino_adquirido_em FROM fechamento_revisoes r WHERE contrato_versao_id=$1 ${lock ? 'FOR UPDATE' : ''}`, [vid])).rows[0];
    if (!row)
        return null;
    const { buscarFechamentoPorId } = await import('./fechamento.repository');
    const base = (await buscarFechamentoPorId(String(row.fechamento_id), tx))!;
    return { ...row, operacao: mapOperation(row, base) } as RevisaoOperacional;
}
export async function listarItensRevisao(id: string, tx: DbExecutor = db()): Promise<FechamentoAdicionalRecord[]> {
    const rows = (await tx.query<Record<string, unknown>>('SELECT * FROM fechamento_revisao_adicionais WHERE fechamento_revisao_id=$1 ORDER BY adicional_id', [id])).rows;
    return rows.map(row => { const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(row))
        out[camel(k)] = ['quantidade', 'valor_unitario_aplicado', 'valor_total'].includes(k) ? Number(v) : v; return out as FechamentoAdicionalRecord; });
}
export const projecaoOperacaoSql = (alias: string) => `(jsonb_build_object(${camposOperacao.filter(k=>!colunasEscolhas.includes(k)).map(k => `'${k}',${alias}.${k}`).join(',')}) || jsonb_strip_nulls(jsonb_build_object(${colunasEscolhas.map(k=>`'${k}',to_jsonb(${alias})->'${k}'`).join(',')})))`;
const itensVigentesSql = `COALESCE((SELECT jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id) FROM fechamento_adicionais a WHERE a.fechamento_id=f.id),'[]'::jsonb)`;
async function camposDisponiveis(tx:DbExecutor){return await escolhasDisponiveis(tx)?camposOperacao:camposOperacao.filter(k=>!colunasEscolhas.includes(k));}
const comumSql = `'schemaVersao',1,'operacao',${projecaoOperacaoSql('f')},'adicionais',${itensVigentesSql}`;
export async function criarRevisaoOperacionalRegistro(tx: DbExecutor, input: {
    id: string;
    fechamentoId: string;
    contratoId: string;
    versaoId: string;
    baseId: string;
    baseHash: string;
    motivo: string;
    chave: string;
    usuarioId: string;
}) {
    const camposOperacao=await camposDisponiveis(tx);
    await tx.query(`INSERT INTO fechamento_revisoes(id,fechamento_id,contrato_id,contrato_versao_id,versao_base_id,motivo,chave_criacao,fonte_base_hash,conteudo_hash,criado_por_usuario_id,atualizado_por_usuario_id,${camposOperacao.join(',')})
 SELECT $1,f.id,$2,$3,$4,$5,$6,encode(sha256(convert_to(jsonb_build_object(${comumSql},'versaoBaseId',$4::uuid,'snapshotBaseHash',$7::text)::text,'UTF8')),'hex'),encode(sha256(convert_to(jsonb_build_object(${comumSql})::text,'UTF8')),'hex'),$8,$8,${camposOperacao.map(k => 'f.' + k).join(',')} FROM fechamentos f WHERE f.id=$9`, [input.id, input.contratoId, input.versaoId, input.baseId, input.motivo, input.chave, input.baseHash, input.usuarioId, input.fechamentoId]);
    await tx.query(`INSERT INTO fechamento_revisao_adicionais(fechamento_revisao_id,${camposItens.join(',')}) SELECT $1,${camposItens.join(',')} FROM fechamento_adicionais WHERE fechamento_id=$2`, [input.id, input.fechamentoId]);
}
export async function salvarOperacaoPreparada(tx: DbExecutor, r: RevisaoOperacional, f: FechamentoRecord, itens: FechamentoAdicionalRecord[], usuarioId: string, motivo: string) {
    const camposOperacao=await camposDisponiveis(tx);
    await tx.query(`UPDATE fechamento_revisoes SET ${camposOperacao.map((k, i) => k + '=$' + (i + 2)).join(',')},motivo=$${camposOperacao.length + 2},atualizado_por_usuario_id=$${camposOperacao.length + 3} WHERE id=$1`, [r.id, ...camposOperacao.map(k => f[camel(k) as keyof FechamentoRecord] ?? null), motivo, usuarioId]);
    await tx.query('DELETE FROM fechamento_revisao_adicionais WHERE fechamento_revisao_id=$1', [r.id]);
    for (const a of itens)
        await tx.query(`INSERT INTO fechamento_revisao_adicionais(fechamento_revisao_id,${camposItens.join(',')}) VALUES(${Array.from({ length: camposItens.length + 1 }, (_, i) => '$' + (i + 1)).join(',')})`, [r.id, ...camposItens.map(k => a[camel(k) as keyof FechamentoAdicionalRecord] ?? null)]);
    const hash = (await tx.query<{
        hash: string;
    }>('SELECT kidmais_hash_revisao_operacional($1) hash', [r.id])).rows[0].hash;
    if (hash !== r.conteudo_hash)
        await tx.query('UPDATE fechamento_revisoes SET conteudo_hash=$2,revisao=revisao+1,revisao_comercial_aprovada=NULL,aprovacao_negociacao_id=NULL,aprovado_comercial_por_usuario_id=NULL,aprovado_comercial_em=NULL WHERE id=$1', [r.id, hash]);
    return buscarRevisaoDaVersao(r.contrato_versao_id, tx);
}
export async function aplicarOperacaoPreparada(tx: DbExecutor, r: RevisaoOperacional) {
    const camposOperacao=await camposDisponiveis(tx);
    await tx.query(`UPDATE fechamentos f SET ${camposOperacao.map(k => `${k}=r.${k}`).join(',')} FROM fechamento_revisoes r WHERE r.id=$1 AND f.id=r.fechamento_id`, [r.id]);
    await tx.query('DELETE FROM fechamento_adicionais WHERE fechamento_id=$1', [r.fechamento_id]);
    await tx.query(`INSERT INTO fechamento_adicionais(fechamento_id,${camposItens.join(',')}) SELECT $2,${camposItens.join(',')} FROM fechamento_revisao_adicionais WHERE fechamento_revisao_id=$1`, [r.id, r.fechamento_id]);
    await tx.query("UPDATE fechamento_revisoes SET estado='APLICADA',aplicado_em=clock_timestamp() WHERE id=$1", [r.id]);
}
