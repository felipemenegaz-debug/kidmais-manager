'use client';
import type { RelatorioFunil as Dados } from '@/lib/oportunidades/consultas';
import {useEffect,useRef} from 'react';
import { EstadoCarga,useMarketing } from '../marketing/comum';
import styles from './oportunidades.module.css';
export default function RelatorioFunil({consulta,origens}:{consulta:string;origens:Array<{codigo:string;rotulo:string}>}){
 const {dados,falha,carregando,recarregar}=useMarketing<Dados>('/api/admin/marketing/funil'+(consulta?'?'+consulta:''));
 const ref=useRef<HTMLElement>(null);
 useEffect(()=>{if(dados&&window.location.hash==='#funil')ref.current?.scrollIntoView({block:'start'});},[dados]);
 return <section ref={ref} id="funil" className={styles.relatorio}><h2>Oportunidades: perdas e conversão</h2><EstadoCarga carregando={carregando} falha={falha} aoTentar={recarregar}/>{dados&&!falha&&<div className={styles.tabelas}><div><h3>Perdas por motivo e origem</h3>{!dados.perdas.length?<p>Nenhuma perda registrada no período.</p>:<table><thead><tr><th>Motivo</th><th>Origem</th><th>Perdas</th></tr></thead><tbody>{dados.perdas.map(p=><tr key={p.motivo+p.origem}><td>{p.motivo}</td><td>{p.origem==='SEM_REGISTRO'?'Não registrada':origens.find(o=>o.codigo===p.origem)?.rotulo??(p.origem==='DESCONHECIDA'?'Desconhecida':p.origem)}</td><td>{p.quantidade}</td></tr>)}</tbody></table>}</div><div><h3>Conversão entre etapas</h3><table><thead><tr><th>Passagem</th><th>Resultado</th></tr></thead><tbody>{dados.conversoes.map(c=><tr key={c.de}><td>{c.de} → {c.para}</td><td>{c.convertidas} de {c.base} · {c.percentual===null?'Sem base':c.percentual.toLocaleString('pt-BR',{maximumFractionDigits:1})+'%'}</td></tr>)}</tbody></table><p>Contatos recebidos e entradas na etapa no período, acompanhados até hoje. As passagens de negociação são observadas desde a instalação do funil. Etapas anteriores e datas de confirmação antigas não são presumidas.</p></div></div>}</section>;
}
