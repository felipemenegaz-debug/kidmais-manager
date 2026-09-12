export const escolhasBuffet=['salgados','doces','bolo','bebidas','lembrancinha','empratado','bombom'] as const;
export type EscolhaBuffet=typeof escolhasBuffet[number];
export const rotulosBuffet:Record<EscolhaBuffet,string>={salgados:'Salgados',doces:'Doces',bolo:'Bolo',bebidas:'Bebidas e sucos',lembrancinha:'Lembrancinha',empratado:'Empratado',bombom:'Bombom'};
export function camposBuffet(pacote:string,codigosAdicionais:string[]=[]):EscolhaBuffet[]{
 const fields:EscolhaBuffet[]=['salgados','doces','bolo','bebidas'];
 if(['COMPLETA','PREMIUM','MINI_FESTA'].includes(pacote)||codigosAdicionais.some(c=>['LEMBRANCINHA_PERSONALIZADA','LEMBRANCINHA_PREMIUM'].includes(c)))fields.push('lembrancinha');
 if(pacote==='PREMIUM'||codigosAdicionais.includes('EMPRATADO_PREMIUM'))fields.push('empratado');
 if(pacote==='PREMIUM'||codigosAdicionais.includes('BOMBOM'))fields.push('bombom');
 return fields;
}
export function escolhasEfetivas(base:Partial<Record<EscolhaBuffet,string|null>>,operacional:Partial<Record<EscolhaBuffet,string|null>>|null){return Object.fromEntries(escolhasBuffet.map(k=>[k,operacional?.[k]??base[k]??''])) as Record<EscolhaBuffet,string>;}
export function nomeComIdade(snapshot:unknown,nascimentoCrm?:string|null){
 const s=snapshot as {aniversariante?:{nome?:string;idadeNoEvento?:number|null;dataNascimento?:string|null};evento?:{data?:string}};
 const a=s?.aniversariante;let idade=a?.idadeNoEvento;
 if(idade==null){const nascimento=(a?.dataNascimento||nascimentoCrm)?.slice(0,10),evento=s?.evento?.data?.slice(0,10);if(nascimento&&evento&&/^\d{4}-\d{2}-\d{2}$/.test(nascimento)&&/^\d{4}-\d{2}-\d{2}$/.test(evento)&&nascimento<=evento&&Number.isFinite(new Date(nascimento+'T12:00:00Z').valueOf())&&new Date(nascimento+'T12:00:00Z').toISOString().slice(0,10)===nascimento){idade=Number(evento.slice(0,4))-Number(nascimento.slice(0,4))-(evento.slice(5)<nascimento.slice(5)?1:0);}}
 const texto=typeof idade==='number'&&Number.isInteger(idade)&&idade>=0&&idade<=120?`${idade} ${idade===1?'ano':'anos'}`:'Idade não informada';return `${a?.nome||'Aniversariante'} — ${texto}`;
}
