import type {DataVaga} from './sugestoes.ts';
export function custoEstimadoPorContrato(l:{orcamentoCentavos:number|null;contratos:number}){return l.orcamentoCentavos===null||l.contratos<=0?null:l.orcamentoCentavos/l.contratos;}
/** Seis fins de semana com sábado ou domingo livre; não inclui sexta, nem duplica o mesmo fim de semana. */
export function finsDeSemanaLivres(datas:DataVaga[]){const grupos=new Map<string,DataVaga[]>();for(const d of [...datas].sort((a,b)=>a.data.localeCompare(b.data))){if(d.diaSemana!==0&&d.diaSemana!==6)continue;const dia=new Date(d.data+'T12:00:00Z');if(d.diaSemana===0)dia.setUTCDate(dia.getUTCDate()-1);const chave=dia.toISOString().slice(0,10);grupos.set(chave,[...(grupos.get(chave)??[]),d]);}return [...grupos.values()].slice(0,6);}
