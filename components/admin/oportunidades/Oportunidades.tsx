'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ETAPAS, TIPOS_ACAO, type Oportunidade } from '@/lib/oportunidades/modelo';
import { MotivoPerda } from './MotivoPerda';
import { EstadoCarga, enviarMarketing, useMarketing } from '../marketing/comum';
import styles from './oportunidades.module.css';

type Dados = {podeEditar:boolean;hoje:string;usuarioId:string;itens:Oportunidade[];responsaveis:Array<{id:string;nome:string}>;contadores:{fechadas:number;perdidas:number;fechadasSemData:number}};
const moeda=(valor:string|null)=>valor===null?'Valor a definir':Number(valor).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const dia=(valor:string)=>valor.split('-').reverse().join('/');
export default function Oportunidades() {
  const [responsavel,setResponsavel]=useState(''),[janela,setJanela]=useState<{item:Oportunidade;feito:boolean}|null>(null),[novo,setNovo]=useState(false);
  const url='/api/admin/oportunidades'+(responsavel?'?responsavelId='+encodeURIComponent(responsavel):'');
  const {dados,falha,carregando,recarregar,dadosDe}=useMarketing<Dados>(url);
  // Atualização em segundo plano (foco da janela, Atualizar) NÃO desativa as ações: o foco chega antes do clique e o
  // desativava, engolindo o primeiro clique de quem volta de outra janela (23/11/2026). Só a primeira carga e a troca de
  // filtro (dados de outra consulta) bloqueiam; a gravação confere a próxima ação esperada no servidor.
  const pronta=!!dados && dadosDe===url && !falha;
  useEffect(()=>{const atualizar=()=>recarregar();window.addEventListener('focus',atualizar);return()=>window.removeEventListener('focus',atualizar);},[recarregar]);
  const podeEditar=!!dados?.podeEditar;
  const hoje=dados?.itens.filter(i=>i.proxima && i.proxima.data<=dados.hoje)??[];
  return <main className={styles.pagina}>
    <header className={styles.cabecalho}><div><p className={styles.marca}>iA.Fest · Comercial</p><h1>Oportunidades</h1><p>Um próximo passo para cada festa que pode acontecer.</p></div>{podeEditar&&<button disabled={!pronta} onClick={()=>setNovo(true)}>Novo contato</button>}</header>
    <div className={styles.filtros}><label>Responsável<select value={responsavel} onChange={e=>setResponsavel(e.target.value)}><option value="">Todos</option>{dados?.responsaveis.map(r=><option key={r.id} value={r.id}>{r.nome}</option>)}</select></label><button className={styles.secundario} onClick={recarregar}>Atualizar</button></div>
    <EstadoCarga carregando={carregando} falha={falha} aoTentar={recarregar}/>
    {dados && !falha && <>
      <section className={styles.hoje} aria-labelledby="para-hoje"><header><h2 id="para-hoje">Para hoje</h2><span>{hoje.length} {hoje.length===1?'ação':'ações'}</span></header>
        {!hoje.length?<p>Nenhuma ação para hoje. Confira as oportunidades sem próximo passo.</p>:<ul>{hoje.map(i=><li key={i.tipo+i.id}><div><strong>{i.nome}</strong><p>{i.proxima!.tipo} · <span className={i.proxima!.data<dados.hoje?styles.alerta:''}>{dia(i.proxima!.data)}{i.proxima!.data<dados.hoje?' · atrasada':''}</span> · {dados.responsaveis.find(r=>r.id===i.responsavelId)?.nome??'Responsável indisponível'}</p></div>{podeEditar&&<button disabled={!pronta} onClick={()=>setJanela({item:i,feito:true})}>Feito</button>}</li>)}</ul>}
      </section>
      <div className={styles.funil}>{ETAPAS.map(etapa=>{
        const itens=dados.itens.filter(i=>i.etapa===etapa),conhecidos=itens.filter(i=>i.valor!==null);
        return <section className={styles.coluna} key={etapa} aria-label={etapa}><header><h2>{etapa} <span>{itens.length}</span></h2><p>{moeda(conhecidos.reduce((s,i)=>s+Number(i.valor),0).toFixed(2))}{conhecidos.length<itens.length?' + valores a definir':''}</p></header>
          {!itens.length&&<p className={styles.vazio}>Nenhuma oportunidade aqui.</p>}{itens.map(i=><article key={i.tipo+i.id} className={styles.cartao}><h3>{i.nome}</h3><p>{i.dataEvento?dia(i.dataEvento):'Data a combinar'}</p><strong>{moeda(i.valor)}</strong>
            <p>{dados.responsaveis.find(r=>r.id===i.responsavelId)?.nome??'Sem responsável'}</p>
            {i.proxima?<div className={styles.proxima}><strong>{i.proxima.tipo}</strong><p>{dia(i.proxima.data)}</p>{i.proxima.observacao&&<p>{i.proxima.observacao}</p>}</div>:<p className={styles.alerta}>Sem próxima ação</p>}
            {i.sugerirPerda&&<p className={styles.sugestao}>14 dias sem ação concluída. Sugestão: “Parou de responder”. Confirme antes de encerrar.</p>}
            {podeEditar&&<button disabled={!pronta} className={styles.secundario} onClick={()=>setJanela({item:i,feito:false})}>{i.proxima?'Ação ou perda':'Definir próxima ação'}</button>}
            <Link href={i.href}>{i.tipo==='CONTATO'?(i.clienteId?'Ver cliente':'Ver contatos'):'Abrir negociação'}</Link>
          </article>)}
        </section>;
      })}</div>
      <footer className={styles.contadores}><p><strong>{dados.contadores.fechadas}</strong> fechadas no mês</p><Link href="/admin/marketing#funil"><strong>{dados.contadores.perdidas}</strong> perdidas no mês · Ver motivos</Link>{dados.contadores.fechadasSemData>0&&<small>{dados.contadores.fechadasSemData} confirmação(ões) anterior(es) sem data conhecida, fora do contador mensal.</small>}</footer>
    </>}
    {podeEditar && janela && dados && <JanelaAcao key={janela.item.id} item={janela.item} feito={janela.feito} dados={dados} fechar={()=>setJanela(null)} salvo={()=>{setJanela(null);recarregar();}}/>}
    {podeEditar && novo&&<NovoContato fechar={()=>setNovo(false)} salvo={()=>{setNovo(false);recarregar();}}/>}
  </main>;
}
function Modal({titulo,fechar,children,busy=false}:{titulo:string;fechar:()=>void;children:ReactNode;busy?:boolean}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{ref.current?.showModal();},[]);
  return <dialog ref={ref} className={styles.modal} aria-label={titulo} onCancel={e=>{e.preventDefault();if(!busy)fechar();}}><header><h2>{titulo}</h2><button type="button" aria-label="Fechar" disabled={busy} className={styles.secundario} onClick={fechar}>×</button></header>{children}</dialog>;
}
function JanelaAcao({item,feito,dados,fechar,salvo}:{item:Oportunidade;feito:boolean;dados:Dados;fechar:()=>void;salvo:()=>void}) {
  const [perder,setPerder]=useState(false),[tipo,setTipo]=useState<string>(item.proxima?.tipo??TIPOS_ACAO[0]),[data,setData]=useState(feito?dados.hoje:(item.proxima?.data??dados.hoje)),[observacao,setObservacao]=useState(feito?'':(item.proxima?.observacao??'')),[responsavelId,setResponsavelId]=useState(item.responsavelId??dados.usuarioId),[motivo,setMotivo]=useState<string>(item.sugerirPerda?'Parou de responder':''),[erro,setErro]=useState(''),[busy,setBusy]=useState(false);
  async function salvar(e:React.FormEvent){e.preventDefault();setBusy(true);setErro('');try{
    await enviarMarketing('/api/admin/oportunidades',{alvo:{tipo:item.tipo,id:item.id},esperada:item.proxima?.id??null,...(perder?{acao:'perder',perda:{motivo,observacao},concluir:feito}:{acao:feito?'concluir':'agendar',proxima:{tipo,data,observacao,responsavelId}})});salvo();
  }catch(e){setErro(e instanceof Error?e.message:'Não foi possível salvar.');}finally{setBusy(false);}}
  return <Modal titulo={feito?'Ação feita. Qual é o próximo passo?':'Próximo passo'} fechar={fechar} busy={busy}><p>{item.nome}</p><div className={styles.filtros}><button type="button" className={!perder?'':styles.secundario} disabled={busy} onClick={()=>setPerder(false)}>Próxima ação</button><button type="button" className={perder?'':styles.secundario} disabled={busy} onClick={()=>setPerder(true)}>Registrar perda</button></div>
    <form onSubmit={salvar}>{perder?<><MotivoPerda nome="motivo-perda-funil" valor={motivo} aoMudar={setMotivo} desativado={busy}/><p>Ao confirmar, a oportunidade será encerrada. Contrato já assinado segue pelo cancelamento do contrato.</p></>:<><label>Ação<select value={tipo} disabled={busy} onChange={e=>setTipo(e.target.value)}>{TIPOS_ACAO.map(t=><option key={t}>{t}</option>)}</select></label><label>Data<input type="date" required value={data} disabled={busy} onChange={e=>setData(e.target.value)}/></label><label>Responsável<select required value={responsavelId} disabled={busy} onChange={e=>setResponsavelId(e.target.value)}><option value="">Selecione</option>{dados.responsaveis.map(r=><option key={r.id} value={r.id}>{r.nome}</option>)}</select></label></>}
      <label>{perder && motivo==='Outro' ? 'Explique o motivo' : 'Observação (opcional)'}<textarea required={perder && motivo==='Outro'} maxLength={1000} value={observacao} disabled={busy} onChange={e=>setObservacao(e.target.value)}/></label>{erro&&<p role="alert" className={styles.alerta}>{erro}</p>}<button disabled={busy || (perder && motivo==='Outro' && !observacao.trim())}>{busy?'Salvando…':perder?'Confirmar perda':feito?'Concluir e agendar':'Salvar próxima ação'}</button>
    </form></Modal>;
}
function NovoContato({fechar,salvo}:{fechar:()=>void;salvo:()=>void}) {
  const [nome,setNome]=useState(''),[telefone,setTelefone]=useState(''),[mensagem,setMensagem]=useState(''),[busy,setBusy]=useState(false),[erro,setErro]=useState('');
  const chave=useRef<string>('');
  async function salvar(e:React.FormEvent){e.preventDefault();setBusy(true);setErro('');if(!chave.current)chave.current=crypto.randomUUID();try{
    await enviarMarketing('/api/admin/oportunidades',{acao:'registrar',nome,telefone:telefone.replace(/\D/g,''),canal:'TELEFONE',mensagem,chave:chave.current});salvo();
  }catch(e){setErro(e instanceof Error?e.message:'Não foi possível registrar.');}finally{setBusy(false);}}
  return <Modal titulo="Novo contato" fechar={fechar} busy={busy}><form onSubmit={salvar}><label>Nome<input autoFocus required minLength={2} maxLength={120} value={nome} disabled={busy} onChange={e=>setNome(e.target.value)}/></label><label>Telefone com DDD<input required type="tel" maxLength={25} value={telefone} disabled={busy} onChange={e=>setTelefone(e.target.value)}/></label><label>Observação (opcional)<textarea maxLength={1000} value={mensagem} disabled={busy} onChange={e=>setMensagem(e.target.value)}/></label>{erro&&<p role="alert" className={styles.alerta}>{erro}</p>}<button disabled={busy}>{busy?'Registrando…':'Registrar contato'}</button></form></Modal>;
}
