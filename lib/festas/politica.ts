type Dados=Record<string,unknown>;
/** Compartilhada pela UI e pelo serviço; o serviço usa o registro bloqueado no banco. */
export function politicaOperacao(i:Dados,antes:Dados|null){
 const acao=i.acao;
 let corrigir=false;
 if(acao==='tarefa'||acao==='pendencia'){
  const finais=acao==='tarefa'?['CONCLUIDA','NAO_SE_APLICA']:['RESOLVIDA','NAO_SE_APLICA'];
  corrigir=i.estado==='NAO_SE_APLICA'||!!antes&&(i.prioridade!==antes.prioridade||i.categoria!==antes.categoria||finais.includes(String(antes.estado))&&i.estado!==antes.estado);
 }
 if(acao==='contagem'&&i.corrigeId)corrigir=true;
 const normal=['tarefa','pendencia','observacao','buffet','solicitacao','contagem'].includes(String(acao));
 return {corrigir,motivoObrigatorio:corrigir||!normal};
}
export function chaveCronologica(snapshot:unknown){const e=(snapshot as {evento?:{data?:string;horarioInicio?:string}})?.evento;return `${e?.data??''}T${e?.horarioInicio??'00:00'}`;}
export function horarioResumo(snapshot:unknown){const e=(snapshot as {evento?:{horarioInicio?:string;horarioFim?:string}})?.evento;return [e?.horarioInicio?.slice(0,5),e?.horarioFim?.slice(0,5)].filter(Boolean).join('–');}
