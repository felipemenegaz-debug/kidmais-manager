import type {DbExecutor} from '../db/contracts';
export type Registro={id:string;[key:string]:unknown};
export type Festa=Registro & {contrato_id:string;revisao:number;versao_contratual_criacao_id:string};
export type Contrato={id:string;fechamento_id:string;status:string;cancelado_em:string|null;versao_id:string;estado:string;status_versao:string;numero_versao:number;snapshot:{evento:{convidados:number;data:string};[key:string]:unknown}};
export async function contrato(tx:DbExecutor,id:string,lock=false):Promise<Contrato>{
 if(lock){const pre=(await tx.query<{fechamento_id:string}>('SELECT fechamento_id FROM contratos WHERE id=$1',[id])).rows[0];if(pre)await tx.query('SELECT id FROM fechamentos WHERE id=$1 FOR UPDATE',[pre.fechamento_id]);await tx.query('SELECT id FROM contratos WHERE id=$1 FOR UPDATE',[id]);await tx.query('SELECT contrato_id FROM contrato_fluxos WHERE contrato_id=$1 FOR UPDATE',[id]);}
 return (await tx.query<Contrato>(`SELECT c.id,c.fechamento_id,c.status,c.cancelado_em::text,f.versao_vigente_id versao_id,e.estado,v.status status_versao,v.numero_versao,v.snapshot FROM contratos c JOIN contrato_fluxos f ON f.contrato_id=c.id JOIN contrato_versoes v ON v.id=f.versao_vigente_id LEFT JOIN contrato_edicoes e ON e.contrato_versao_id=v.id WHERE c.id=$1`,[id])).rows[0];
}
export async function filhos(tx:DbExecutor,id:string){
 const result:Record<string,Registro[]>={};
 for(const table of ['tarefas','pendencias','contagens_convidados','solicitacoes','eventos'])result[table]=(await tx.query<Registro>(`SELECT * FROM festa_${table} WHERE festa_id=$1 ORDER BY ${table==='eventos'||table==='contagens_convidados'?'sequencia':'id'}`,[id])).rows;
 result.buffet=(await tx.query<Registro>('SELECT festa_id id,* FROM festa_buffet WHERE festa_id=$1',[id])).rows;
 return result;
}
export async function contagens(tx:DbExecutor,f:Festa){
 const atuais=(await tx.query<Registro>(`WITH RECURSIVE cadeia AS (
 SELECT c.id raiz,c.id,c.observado_em,c.sequencia ordem,c.total_presentes FROM festa_contagens_convidados c WHERE festa_id=$1 AND corrige_contagem_id IS NULL
 UNION ALL SELECT p.raiz,c.id,p.observado_em,p.ordem,c.total_presentes FROM cadeia p JOIN festa_contagens_convidados c ON c.corrige_contagem_id=p.id WHERE c.festa_id=$1)
 SELECT * FROM cadeia p WHERE NOT EXISTS(SELECT 1 FROM festa_contagens_convidados c WHERE c.corrige_contagem_id=p.id) ORDER BY observado_em DESC,ordem DESC LIMIT 1`,[f.id])).rows[0]??null;
 return {atual:atuais};
}

export const formalizacaoElegivelSql="c.status='ASSINADO' AND v.status='ASSINADA' AND e.estado='CONCLUIDA' AND (SELECT count(DISTINCT a.parte) FROM contrato_assinaturas a WHERE a.contrato_versao_id=v.id AND a.parte IN ('KIDMAIS','CLIENTE'))=2";
export async function formalizacaoCompleta(tx:DbExecutor,versaoId:string){return (await tx.query(`SELECT v.id FROM contratos c JOIN contrato_fluxos cf ON cf.contrato_id=c.id JOIN contrato_versoes v ON v.id=cf.versao_vigente_id JOIN contrato_edicoes e ON e.contrato_versao_id=v.id WHERE v.id=$1 AND ${formalizacaoElegivelSql}`,[versaoId])).rows.length>0;}
