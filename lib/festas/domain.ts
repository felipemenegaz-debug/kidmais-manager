export const capacidades=['FESTA_CONSULTAR','FESTA_CRIAR','FESTA_OPERAR','FESTA_CORRIGIR','FESTA_CONFIGURAR_AREAS'] as const;
export type Capacidade=typeof capacidades[number];
export type Estado='PROXIMA'|'HOJE'|'REALIZADA'|'CANCELADA'|'REMOVIDA';
export class FestaError extends Error {status:number;constructor(message:string,status=409){super(message);this.status=status;}}
export function exigir(condicao:unknown,mensagem:string,status=409):asserts condicao{if(!condicao)throw new FestaError(mensagem,status);}
export function excedentes(presentes:number,contratados:number){return Math.max(presentes-contratados,0);}
export function horarioSaoPaulo(agora=new Date()){
 const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(agora);
 const get=(name:string)=>parts.find(p=>p.type===name)!.value;
 return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}
/** Rótulo de consulta. Nunca grava realização ou modifica a contratação. */
export function estadoDerivado(snapshot:unknown,cancelada:boolean,invalidada:boolean,agora=new Date()):Estado{
 if(invalidada)return 'REMOVIDA';if(cancelada)return 'CANCELADA';
 const e=(snapshot as {evento?:{data?:string;horarioInicio?:string;horarioFim?:string}})?.evento;
 const data=e?.data?.slice(0,10);if(!data)return 'PROXIMA';
 let fim=data+'T'+(e?.horarioFim||'23:59:59');
 if(e?.horarioFim&&e.horarioInicio&&e.horarioFim<e.horarioInicio){const d=new Date(data+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);fim=d.toISOString().slice(0,10)+'T'+e.horarioFim;}
 const agoraLocal=horarioSaoPaulo(agora);
 if(agoraLocal>=fim)return 'REALIZADA';
 return data<=agoraLocal.slice(0,10)?'HOJE':'PROXIMA';
}
export function pertenceVisao(estado:Estado,visao:string,abertas:boolean,filtro='Todas'){
 if(estado==='REMOVIDA')return false;
 if(visao==='Histórico')return ['REALIZADA','CANCELADA'].includes(estado)&&(filtro==='Todas'||estado===(filtro==='Canceladas'?'CANCELADA':'REALIZADA'));
 if(visao==='Pendências')return estado!=='CANCELADA'&&abertas;
 return estado===(visao==='Hoje'?'HOJE':'PROXIMA');
}
