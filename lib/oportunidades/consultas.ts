import type { DbExecutor } from '../db/contracts.ts';
import { SQL_ORIGEM_NEGOCIACAO } from '../marketing/atribuicao.ts';
import { etapaDoEstado, type Oportunidade } from './modelo.ts';
import { exigirSchema } from './service.ts';

const BASE = `WITH alvos AS (
 SELECT k.id,k.empresa_id,'CONTATO'::text AS tipo,k.nome,k.cliente_id,k.status,NULL::numeric AS valor,k.data_desejada AS data_evento,
 k.responsavel_id,k.recebido_em AS criada_em FROM marketing_contatos k WHERE k.empresa_id=$1::uuid AND k.status IN ('NOVO','EM_ATENDIMENTO')
 AND k.fechamento_id IS NULL
 UNION ALL
 SELECT f.id,f.empresa_id,'FECHAMENTO',coalesce(c.nome_completo,'Cliente não vinculado'),f.cliente_id,f.status,
 coalesce(f.valor_aprovado,f.valor_negociado,f.valor_tabela),f.data_evento,f.usuario_responsavel_id,f.iniciado_em
 FROM fechamentos f LEFT JOIN clientes c ON c.empresa_id=f.empresa_id AND c.id=f.cliente_id WHERE f.empresa_id=$1::uuid
 AND f.status IN ('RASCUNHO','AGUARDANDO_APROVACAO','APROVADO','AGUARDANDO_CONTRATO','CONTRATO_ASSINADO','AGUARDANDO_PAGAMENTO')
)
 SELECT a.id::text,a.tipo,a.nome,a.cliente_id::text AS "clienteId",a.status,a.valor::text,a.data_evento::text AS "dataEvento",
 (CASE WHEN a.tipo='FECHAMENTO' THEN a.responsavel_id ELSE coalesce(p.responsavel_id,a.responsavel_id) END)::text AS "responsavelId",
 CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'tipo',p.tipo,'data',p.data::text,'observacao',p.observacao,'responsavelId',CASE WHEN a.tipo='FECHAMENTO' THEN a.responsavel_id ELSE p.responsavel_id END) END AS proxima,
 clock_timestamp()-coalesce((SELECT max(x.encerrada_em) FROM oportunidades_acoes x WHERE x.empresa_id=a.empresa_id AND x.resultado='FEITA'
 AND ((a.tipo='CONTATO' AND x.contato_id=a.id) OR (a.tipo='FECHAMENTO' AND x.fechamento_id=a.id))),a.criada_em)>=interval '14 days' AS "sugerirPerda"
 FROM alvos a LEFT JOIN oportunidades_acoes p ON p.empresa_id=a.empresa_id AND p.encerrada_em IS NULL
 AND ((a.tipo='CONTATO' AND p.contato_id=a.id) OR (a.tipo='FECHAMENTO' AND p.fechamento_id=a.id))
 WHERE ($2::uuid IS NULL OR (CASE WHEN a.tipo='FECHAMENTO' THEN a.responsavel_id ELSE coalesce(p.responsavel_id,a.responsavel_id) END)=$2::uuid)
 ORDER BY p.data NULLS FIRST,a.criada_em,a.id`;

export async function listarOportunidades(tx: DbExecutor,empresaId: string,responsavelId: string | null = null): Promise<Oportunidade[]> {
  await exigirSchema(tx);
  const r = await tx.query<Omit<Oportunidade,'etapa'|'href'>>(BASE,[empresaId,responsavelId]);
  return r.rows.map(v=>({...v,etapa:etapaDoEstado(v.status,v.tipo==='CONTATO')!,href:v.tipo==='CONTATO'
    ? (v.clienteId ? `/clientes/${v.clienteId}` : '/admin/marketing/origens') : `/admin/fechamentos/${v.id}/revisao`}));
}
export async function responsaveis(tx: DbExecutor,empresaId: string) {
  return (await tx.query<{id: string; nome: string}>(`SELECT u.id::text,u.nome FROM memberships m JOIN usuarios_administrativos u ON u.id=m.usuario_id
   WHERE m.empresa_id=$1::uuid AND m.status='ATIVA' AND u.ativo
   AND (m.papel='REPRESENTANTE_AUTORIZADO' OR EXISTS(SELECT 1 FROM marketing_membership_capacidades cap WHERE cap.empresa_id=m.empresa_id AND cap.membership_id=m.id AND cap.revogado_em IS NULL))
   ORDER BY u.nome,u.id`,[empresaId])).rows;
}
export async function contadoresMes(tx: DbExecutor,empresaId: string,hoje: string,responsavelId: string | null) {
  const r = await tx.query<{fechadas: number; perdidas: number; fechadasSemData: number}>(`SELECT
   (SELECT count(*)::int FROM fechamentos f WHERE f.empresa_id=$1::uuid AND f.status='CONFIRMADO'
    AND f.confirmada_em>=date_trunc('month',$2::date::timestamp) AT TIME ZONE 'America/Sao_Paulo'
    AND f.confirmada_em<(($2::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AND ($3::uuid IS NULL OR f.usuario_responsavel_id=$3::uuid)) AS fechadas,
   (SELECT count(*)::int FROM fechamentos f WHERE f.empresa_id=$1::uuid AND f.status='CONFIRMADO' AND f.confirmada_em IS NULL AND ($3::uuid IS NULL OR f.usuario_responsavel_id=$3::uuid)) AS "fechadasSemData",
   (SELECT count(*)::int FROM (
    SELECT perdida_em,responsavel_id FROM marketing_contatos WHERE empresa_id=$1::uuid
    UNION ALL SELECT perdida_em,usuario_responsavel_id FROM fechamentos WHERE empresa_id=$1::uuid) x
    WHERE perdida_em>=date_trunc('month',$2::date::timestamp) AT TIME ZONE 'America/Sao_Paulo'
    AND perdida_em<(($2::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AND ($3::uuid IS NULL OR responsavel_id=$3::uuid)) AS perdidas`,[empresaId,hoje,responsavelId]);
  return r.rows[0];
}
export type RelatorioFunil = { perdas: Array<{motivo: string; origem: string; quantidade: number}>; conversoes: Array<{de: string; para: string; base: number; convertidas: number; percentual: number | null}> };
export async function relatorioFunil(tx: DbExecutor,empresaId: string,de: string,ate: string,unidadeId: string | null): Promise<RelatorioFunil> {
  await exigirSchema(tx);
  const perdas = (await tx.query<{motivo: string; origem: string; quantidade: number}>(`WITH perdas AS (
   SELECT k.perda_motivo AS motivo,k.perdida_em,k.estabelecimento_id,coalesce(a.origem_codigo,'SEM_REGISTRO') AS origem
   FROM marketing_contatos k LEFT JOIN marketing_atribuicoes a ON a.empresa_id=k.empresa_id AND a.alvo_tipo='CONTATO' AND a.alvo_id=k.id AND a.vigente WHERE k.empresa_id=$1::uuid
   UNION ALL
   SELECT f.perda_motivo,f.perdida_em,f.estabelecimento_id,coalesce(a.origem_codigo,'SEM_REGISTRO') FROM fechamentos f
   LEFT JOIN LATERAL (${SQL_ORIGEM_NEGOCIACAO}) a ON true WHERE f.empresa_id=$1::uuid)
   SELECT motivo,origem,count(*)::int AS quantidade FROM perdas WHERE perdida_em>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
   AND perdida_em<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AND ($4::uuid IS NULL OR estabelecimento_id=$4::uuid) GROUP BY motivo,origem ORDER BY quantidade DESC,motivo,origem`,[empresaId,de,ate,unidadeId])).rows;
  const contato = (await tx.query<{base: number; convertidas: number}>(`SELECT count(*)::int AS base,count(*) FILTER(WHERE k.fechamento_id IS NOT NULL OR EXISTS
    (SELECT 1 FROM fechamentos f WHERE f.empresa_id=k.empresa_id AND f.cliente_id=k.cliente_id AND f.iniciado_em>=k.recebido_em))::int AS convertidas
    FROM marketing_contatos k WHERE k.empresa_id=$1::uuid AND k.recebido_em>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
    AND k.recebido_em<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AND ($4::uuid IS NULL OR k.estabelecimento_id=$4::uuid)`,[empresaId,de,ate,unidadeId])).rows[0];
  const conversoes: RelatorioFunil['conversoes'] = [{de:'Novo contato',para:'Proposta',...contato,percentual:contato.base ? contato.convertidas/contato.base*100 : null}];
  for (const [origem,destino] of [['Proposta','Contrato'],['Contrato','Sinal'],['Sinal','Fechada']]) {
    const linha = (await tx.query<{base: number; convertidas: number}>(`SELECT count(*)::int AS base,count(*) FILTER(WHERE EXISTS(
     SELECT 1 FROM oportunidades_marcos n WHERE n.empresa_id=m.empresa_id AND n.fechamento_id=m.fechamento_id AND n.etapa=$6 AND n.ocorrido_em>=m.ocorrido_em))::int AS convertidas
     FROM oportunidades_marcos m JOIN fechamentos f ON f.empresa_id=m.empresa_id AND f.id=m.fechamento_id WHERE m.empresa_id=$1::uuid AND m.etapa=$5
     AND m.ocorrido_em>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND m.ocorrido_em<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
     AND ($4::uuid IS NULL OR f.estabelecimento_id=$4::uuid)`,[empresaId,de,ate,unidadeId,origem,destino])).rows[0];
    conversoes.push({de:origem,para:destino,...linha,percentual:linha.base ? linha.convertidas/linha.base*100 : null});
  }
  return {perdas,conversoes};
}
