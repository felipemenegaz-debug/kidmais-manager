'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { ConfiguracaoAtendimento } from '@/lib/whatsapp/atendimento/core';
import type { Conversa, Mensagem } from '@/lib/whatsapp/atendimento/service';
import styles from './atendimento.module.css';

type Dados = { usuarioId: string; conversas: Conversa[]; mensagens: Mensagem[]; configuracao: ConfiguracaoAtendimento | null; automacaoDisponivel: boolean; podeConfigurar: boolean };
const estados = { IA: 'IA atendendo', AGUARDANDO_HUMANO: 'Aguardando atendente', HUMANO: 'Atendente assumiu', ENCERRADA: 'Encerrada' };
const dataBr = (iso: string | null) => iso ? iso.split('-').reverse().join('/') : null;
const horario = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const mensagemEstado: Record<string,string> = { PENDENTE: 'Na fila', PROCESSANDO: 'Preparando', PROCESSADA: 'Recebida', CANCELADA: 'Não enviada', ENVIANDO: 'Enviando', SUBMETIDA: 'Enviada ao provedor', ENTREGUE: 'Entregue', FALHOU: 'Falhou', INCERTO: 'Entrega não confirmada' };
export default function AtendimentoWhatsapp() {
  const [dados,setDados] = useState<Dados | null>(null), [selecionada,setSelecionada] = useState<string | null>(null), [erro,setErro] = useState(''), [ocupado,setOcupado] = useState(false), [texto,setTexto] = useState(''), [quadro,setQuadro] = useState(false), [config,setConfig] = useState<ConfiguracaoAtendimento | null>(null);
  const pedidoAtual = useRef(0), tituloConversa = useRef<HTMLHeadingElement>(null), focarConversa = useRef(false);
  const carregar = useCallback(async () => {
    const pedido = ++pedidoAtual.current;
    try { const r = await adminFetch('/api/admin/atendimento' + (selecionada ? '?conversaId=' + selecionada : '')); const json = await r.json(); if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível carregar o atendimento.'); if (pedido === pedidoAtual.current) { setDados(json.data); setErro(''); } }
    catch(e) { if (pedido === pedidoAtual.current) setErro(e instanceof Error ? e.message : 'Não foi possível carregar o atendimento.'); }
  },[selecionada]);
  useEffect(() => { const contador = pedidoAtual; const inicio = window.setTimeout(() => void carregar(),0); const timer = window.setInterval(() => { if (!document.hidden) void carregar(); },10000); return () => { ++contador.current; window.clearTimeout(inicio); window.clearInterval(timer); }; },[carregar]);
  const conversa = dados?.conversas.find(c => c.id === selecionada);
  // Celular e teclado: ao escolher uma conversa, o foco vai para ela (a lista pode ter até 100 itens acima).
  useEffect(() => { if (conversa && focarConversa.current) { focarConversa.current = false; tituloConversa.current?.focus(); tituloConversa.current?.scrollIntoView({ block: 'start' }); } }, [conversa]);
  async function agir(acao: 'assumir' | 'retomar' | 'encerrar' | 'enviar') {
    if (!conversa || ocupado) return;
    setOcupado(true);setErro('');
    try { const r = await adminFetch('/api/admin/atendimento',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({acao,conversaId:conversa.id,versao:Number(conversa.versao),...(acao==='enviar'?{texto}: {})})}); const json = await r.json(); if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível concluir.'); if (acao==='enviar') setTexto(''); await carregar(); }
    catch(e) {setErro(e instanceof Error ? e.message : 'Não foi possível concluir.');} finally {setOcupado(false);}
  }
  async function salvar() {
    if (!config || ocupado) return;setOcupado(true);
    try { const r=await adminFetch('/api/admin/atendimento',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({acao:'configurar',configuracao:config})});const json=await r.json();if(!r.ok||!json.ok)throw Error(json.erro||'Confira os campos da configuração.');setConfig(null);await carregar(); } catch(e){setErro(e instanceof Error?e.message:'Falha ao salvar.');}finally{setOcupado(false);}
  }
  function escolher(id: string) {focarConversa.current=true;setSelecionada(id);setTexto('');setQuadro(false);}
  return <main className={styles.pagina}>
    <header className={styles.topo}><div><h1>Atendimento WhatsApp</h1><p>Conversas, interessados e passagem para a equipe.</p></div><div className={styles.acoes}><button aria-pressed={!quadro} onClick={()=>setQuadro(false)}>Conversas</button><button aria-pressed={quadro} onClick={()=>setQuadro(true)}>Quadro</button><button onClick={()=>void carregar()} disabled={ocupado}>Atualizar</button></div></header>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {!dados && !erro && <p aria-live="polite">Carregando atendimento…</p>}
    {dados && <>
      {!dados.automacaoDisponivel && <p className={styles.aviso}>O piloto automático está desligado no servidor. Conexão, configuração e ativação são etapas separadas.</p>}
      {dados.podeConfigurar && <details className={styles.painel}><summary>Configurar atendimento e respostas publicadas</summary><button onClick={()=>setConfig(dados.configuracao ?? {ativo:false,nome:'Kidmais',perguntas:[]})}>Editar configuração</button>{config && <section>
        <label>Nome da empresa<input value={config.nome} maxLength={100} onChange={e=>setConfig({...config,nome:e.target.value})}/></label>
        <label><input type="checkbox" disabled={!dados.automacaoDisponivel} checked={config.ativo} onChange={e=>setConfig({...config,ativo:e.target.checked})}/>Atendimento automático habilitado</label>
        <p>Publique somente informações aprovadas. A IA seleciona estas respostas; não cria preços ou condições.</p>
        {config.perguntas.map((p,index)=><fieldset key={p.id}><legend>Resposta {index+1}</legend><label>Pergunta<input value={p.pergunta} maxLength={250} onChange={e=>setConfig({...config,perguntas:config.perguntas.map((x,i)=>i===index?{...x,pergunta:e.target.value}:x)})}/></label><label>Resposta aprovada<textarea value={p.resposta} maxLength={1500} onChange={e=>setConfig({...config,perguntas:config.perguntas.map((x,i)=>i===index?{...x,resposta:e.target.value}:x)})}/></label><button onClick={()=>setConfig({...config,perguntas:config.perguntas.filter((_,i)=>i!==index)})}>Remover resposta</button></fieldset>)}
        <div className={styles.acoes}><button disabled={config.perguntas.length>=30} onClick={()=>setConfig({...config,perguntas:[...config.perguntas,{id:'faq_'+crypto.randomUUID().slice(0,8),pergunta:'',resposta:''}]})}>Adicionar resposta</button><button disabled={ocupado} className={styles.primario} onClick={()=>void salvar()}>Salvar configuração</button><button onClick={()=>setConfig(null)}>Cancelar edição</button></div>
      </section>}</details>}
      {quadro ? <div className={styles.quadro}>{(Object.keys(estados) as Array<Conversa['estado']>).map(estado=><section key={estado} className={styles.painel}><h2>{estados[estado]}</h2>{dados.conversas.filter(c=>c.estado===estado).map(c=><button className={styles.cardConversa} key={c.id} onClick={()=>escolher(c.id)}><strong>Contato · final {c.contato.slice(-4)}</strong><span>{dataBr(c.interesse.data) || 'Data não informada'} · {c.interesse.convidados ? c.interesse.convidados+' convidados' : 'Convidados não informados'}</span></button>)}{!dados.conversas.some(c=>c.estado===estado)&&<p>Nenhuma conversa.</p>}</section>)}</div> : <div className={styles.layout}>
        <aside className={styles.painel}><h2>Conversas</h2>{!dados.conversas.length&&<p>Nenhuma conversa recebida.</p>}{dados.conversas.map(c=><button className={styles.cardConversa} key={c.id} aria-pressed={c.id===selecionada} onClick={()=>escolher(c.id)}><strong>Contato · final {c.contato.slice(-4)}</strong><span>{estados[c.estado]}</span></button>)}</aside>
        <section className={styles.painel} aria-label="Conversa selecionada">{!conversa ? <p>Selecione uma conversa para atender.</p> : <>
          <h2 ref={tituloConversa} tabIndex={-1}>Contato · final {conversa.contato.slice(-4)} · {estados[conversa.estado]}</h2><p>Interesse: {dataBr(conversa.interesse.data) || 'data pendente'} · {conversa.interesse.convidados || 'quantidade pendente'} convidados</p>
          {conversa.nao_contatar && <p role="status">Este contato pediu para não receber mensagens. Novos envios estão bloqueados.</p>}
          <div className={styles.acoes}><button disabled={ocupado||conversa.nao_contatar} onClick={()=>void agir('assumir')}>Assumir e pausar IA</button><button className={styles.retomarIa} disabled={ocupado||conversa.nao_contatar||!dados.automacaoDisponivel||conversa.estado==='ENCERRADA'} onClick={()=>void agir('retomar')}>Retomar IA</button><button disabled={ocupado||conversa.estado==='ENCERRADA'} onClick={()=>void agir('encerrar')}>Encerrar</button><Link className={styles.primario} href="/clientes">Preparar contratação</Link></div>
          <div className={styles.historico}>{dados.mensagens.map(m=><article key={m.id} className={styles.mensagem} data-direcao={m.direcao}><small>{m.direcao==='ENTRADA'?'Cliente':'Equipe / assistente'} · {mensagemEstado[m.estado] || m.estado} · <time dateTime={m.criada_em}>{horario(m.criada_em)}</time></small><p>{m.texto || 'Conteúdo sem texto (mídia ou mensagem longa demais). Consulte o canal original; a análise desse conteúdo ainda não está disponível.'}</p></article>)}</div>
          <form onSubmit={e=>{e.preventDefault();void agir('enviar');}}><label htmlFor="resposta-whatsapp">Resposta do atendente</label><textarea id="resposta-whatsapp" maxLength={4000} value={texto} onChange={e=>setTexto(e.target.value)} disabled={ocupado||conversa.nao_contatar||conversa.responsavel_id!==dados.usuarioId||conversa.estado!=='HUMANO'} /><button className={styles.primario} disabled={ocupado||conversa.nao_contatar||conversa.responsavel_id!==dados.usuarioId||!texto.trim()||conversa.estado!=='HUMANO'||!dados.automacaoDisponivel}>Enviar resposta</button></form>
        </>}</section>
      </div>}
    </>}
  </main>;
}
