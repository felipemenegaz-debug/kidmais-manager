'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { ConfiguracaoAtendimento } from '@/lib/whatsapp/atendimento/core';
import type { ConversaLista, EstadoCanal, MensagemLista } from '@/lib/whatsapp/atendimento/service';
import styles from './atendimento.module.css';

type Dados = { usuarioId: string; conversas: ConversaLista[]; mensagens: MensagemLista[]; configuracao: ConfiguracaoAtendimento | null; automacaoDisponivel: boolean; canal: EstadoCanal; ia: { ia: boolean; orcamento: boolean }; podeConfigurar: boolean };
type Estado = ConversaLista['estado'];
const estados: Record<Estado, string> = { IA: 'IA atendendo', AGUARDANDO_HUMANO: 'Aguardando atendente', HUMANO: 'Atendente assumiu', ENCERRADA: 'Encerrada' };
const dataBr = (iso: string | null) => iso ? iso.split('-').reverse().join('/') : null;
const horario = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// O estado da mensagem depende da direção: uma entrada "cancelada" não é uma mensagem perdida.
const saida: Record<string,string> = { PENDENTE: 'Na fila', PROCESSANDO: 'Preparando', ENVIANDO: 'Enviando', SUBMETIDA: 'Enviada ao provedor', ENTREGUE: 'Entregue', FALHOU: 'Não enviada', CANCELADA: 'Não enviada', INCERTO: 'Entrega não confirmada' };
const entrada: Record<string,string> = { PENDENTE: 'Aguardando a IA', PROCESSANDO: 'IA analisando', PROCESSADA: 'Recebida', CANCELADA: 'Sem resposta automática', FALHOU: 'IA não respondeu; encaminhada' };
// O que aconteceu e o que fazer, para saídas que não chegaram (ou podem não ter chegado) ao cliente.
const explicacaoSaida: Record<string,string> = {
  PENDENTE: 'Sai quando o processador rodar. Se ficar mais de 15 minutos na fila, é cancelada e não é enviada.',
  CANCELADA: 'Cancelada antes do envio: conversa assumida, configuração alterada, janela de 24 horas ou prazo da fila. O cliente não recebeu.',
  FALHOU: 'O provedor recusou ou informou falha. O cliente não recebeu; responda de novo se ainda fizer sentido.',
  INCERTO: 'O provedor não confirmou o envio, e o cliente pode ter recebido. Confira no WhatsApp antes de repetir: não há reenvio automático.',
};
const JANELA_MS = 24 * 60 * 60 * 1000;
const novaConfiguracao = (): ConfiguracaoAtendimento => ({ ativo: false, nome: 'Kidmais', perguntas: [], limites: { respostasPor24h: 20 } });

function responsavel(c: ConversaLista, usuarioId: string) {
  if (!c.responsavel_id) return 'Sem responsável';
  return c.responsavel_id === usuarioId ? 'Você' : c.responsavel_nome ?? 'Outro atendente';
}

export default function AtendimentoWhatsapp() {
  const [dados,setDados] = useState<Dados | null>(null), [selecionada,setSelecionada] = useState<string | null>(null), [erro,setErro] = useState(''), [ocupado,setOcupado] = useState(false), [texto,setTexto] = useState(''), [quadro,setQuadro] = useState(false), [config,setConfig] = useState<ConfiguracaoAtendimento | null>(null), [lidoEm,setLidoEm] = useState(0);
  const pedidoAtual = useRef(0), tituloConversa = useRef<HTMLHeadingElement>(null), focarConversa = useRef(false), cartoes = useRef(new Map<string, HTMLButtonElement>());
  const carregar = useCallback(async () => {
    const pedido = ++pedidoAtual.current;
    try { const r = await adminFetch('/api/admin/atendimento' + (selecionada ? '?conversaId=' + selecionada : '')); const json = await r.json(); if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível carregar o atendimento.'); if (pedido === pedidoAtual.current) { setDados(json.data); setLidoEm(Date.now()); setErro(''); } }
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
    if (!config || ocupado) return;setOcupado(true);setErro('');
    try { const r=await adminFetch('/api/admin/atendimento',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({acao:'configurar',configuracao:config})});const json=await r.json();if(!r.ok||!json.ok)throw Error(json.erro||'Confira os campos da configuração.');setConfig(null);await carregar(); } catch(e){setErro(e instanceof Error?e.message:'Falha ao salvar.');}finally{setOcupado(false);}
  }
  function escolher(id: string) {focarConversa.current=true;setSelecionada(id);setTexto('');setQuadro(false);}
  // Volta à lista com o foco no cartão da conversa aberta (no celular a lista fica acima do histórico).
  function voltarALista() { const atual = selecionada ? cartoes.current.get(selecionada) : undefined; atual?.focus(); atual?.scrollIntoView({ block: 'center' }); }
  const cartao = (c: ConversaLista, detalhe: string) => <button className={styles.cardConversa} key={c.id} ref={el => { if (el) cartoes.current.set(c.id, el); else cartoes.current.delete(c.id); }} aria-pressed={quadro ? undefined : c.id===selecionada} onClick={()=>escolher(c.id)}>
    <strong>Contato · final {c.contato_final}</strong><span>{detalhe}</span><span>{responsavel(c, dados?.usuarioId ?? '')}{c.atualizada_em ? ' · ' + horario(c.atualizada_em) : ''}</span>
  </button>;
  // Horário da última leitura (atualizada a cada 10 s): a janela é conferida de novo no servidor ao enviar.
  // Só as mensagens da conversa aberta: ao trocar de conversa, o histórico anterior não aparece sob o novo contato.
  const historico = dados?.mensagens.filter(m => m.conversa_id === selecionada) ?? [];
  const janelaAberta = conversa ? lidoEm - new Date(conversa.ultima_entrada_em).getTime() < JANELA_MS : false;
  const podeResponder = !!conversa && !ocupado && !conversa.nao_contatar && conversa.estado === 'HUMANO' && conversa.responsavel_id === dados?.usuarioId && !!dados?.automacaoDisponivel && !!dados?.ia.ia && !!dados?.configuracao?.ativo && janelaAberta;
  const aguardando = dados?.conversas.filter(c => c.estado === 'AGUARDANDO_HUMANO').length ?? 0;
  // Só quando "Retomar IA" faria sentido (conversa com a equipe) e está bloqueado por configuração do servidor ou da empresa.
  const motivoRetomar = !conversa || !dados || conversa.nao_contatar || conversa.estado === 'IA' || conversa.estado === 'ENCERRADA' ? '' : !dados.automacaoDisponivel ? 'Retomar IA indisponível: o envio está desligado no servidor deste ambiente.' : !dados.ia.ia ? 'Retomar IA indisponível: a chave da IA está desligada neste ambiente.' : !dados.configuracao?.ativo ? 'Retomar IA indisponível: o atendimento automático da empresa está desligado na configuração.' : '';
  const motivoSemResposta = !conversa || !dados ? '' : conversa.nao_contatar ? 'Este contato pediu para não receber mensagens.' : !dados.automacaoDisponivel ? 'O envio está desligado no servidor deste ambiente.' : !dados.ia.ia ? 'A chave da IA está desligada neste ambiente: a fila não envia respostas agora.' : !dados.configuracao?.ativo ? 'O atendimento da empresa está desligado na configuração: respostas pela fila não saem.' : conversa.estado !== 'HUMANO' || conversa.responsavel_id !== dados.usuarioId ? 'Assuma a conversa para responder.' : !janelaAberta ? 'A janela de 24 horas expirou. Aguarde nova mensagem do cliente.' : '';
  return <main className={styles.pagina}>
    <header className={styles.topo}><div><h1>Atendimento WhatsApp</h1><p>Conversas, interessados e passagem para a equipe.</p></div><div className={styles.acoes}><button aria-pressed={!quadro} onClick={()=>setQuadro(false)}>Conversas</button><button aria-pressed={quadro} onClick={()=>setQuadro(true)}>Quadro</button><button onClick={()=>void carregar()} disabled={ocupado}>Atualizar</button></div></header>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {!dados && !erro && <p aria-live="polite">Carregando atendimento…</p>}
    {dados && <>
      <section className={styles.canal} aria-labelledby="situacao-canal">
        <h2 id="situacao-canal">Situação do canal</h2>
        <dl>
          <div data-ligado={dados.canal.receptor}><dt>Receptor do número</dt><dd>{dados.canal.receptor ? `Este ambiente (${dados.canal.ambiente})` : 'Outro ambiente ou nenhum'}</dd></div>
          <div data-ligado={dados.canal.recepcao}><dt>Receber mensagens</dt><dd>{dados.canal.recepcao ? 'Ligado' : 'Desligado'}</dd></div>
          <div data-ligado={dados.canal.envio && dados.ia.ia}><dt>Enviar respostas</dt><dd>{!dados.canal.envio ? 'Desligado' : dados.ia.ia ? 'Ligado' : 'Bloqueado pela chave da IA'}</dd></div>
          <div data-ligado={dados.ia.orcamento}><dt>Orçamento da IA</dt><dd>{dados.ia.orcamento ? 'Definido' : 'Sem teto: a IA não é chamada'}</dd></div>
          <div data-ligado={!!dados.configuracao?.ativo}><dt>Atendimento automático da empresa</dt><dd>{dados.configuracao?.ativo ? 'Ligado' : 'Desligado'}</dd></div>
        </dl>
      </section>
      {!dados.automacaoDisponivel && <p className={styles.aviso}>O piloto automático está desligado no servidor. Conexão, configuração e ativação são etapas separadas.</p>}
      {dados.podeConfigurar && <details className={styles.painel}><summary>Configurar atendimento, respostas publicadas e limites</summary>{!config && <button onClick={()=>setConfig(dados.configuracao ?? novaConfiguracao())}>Editar configuração</button>}{config && <form onSubmit={e=>{e.preventDefault();void salvar();}}>
        <label>Nome da empresa<input value={config.nome} required minLength={2} maxLength={100} onChange={e=>setConfig({...config,nome:e.target.value})}/></label>
        <label className={styles.opcao}><input type="checkbox" disabled={!dados.automacaoDisponivel} checked={config.ativo} onChange={e=>setConfig({...config,ativo:e.target.checked})}/>Atendimento automático habilitado</label>
        {!dados.automacaoDisponivel && <p>Só pode ser ligado depois da ativação no servidor deste ambiente.</p>}
        <label>Respostas automáticas por conversa em 24 horas<input type="number" inputMode="numeric" required min={1} max={100} value={config.limites.respostasPor24h} onChange={e=>setConfig({...config,limites:{respostasPor24h:Number(e.target.value)}})} aria-describedby="limite-ajuda"/></label>
        <p id="limite-ajuda">Ao atingir o limite, a conversa vai para a equipe com uma mensagem fixa de encaminhamento. O custo máximo da IA é definido no servidor.</p>
        <p>Publique somente informações aprovadas. A IA escolhe uma destas respostas; não cria preços, descontos, disponibilidade ou condições.</p>
        {config.perguntas.map((p,index)=><fieldset key={p.id}><legend>Resposta {index+1}</legend><label>Pergunta<input value={p.pergunta} required minLength={3} maxLength={250} onChange={e=>setConfig({...config,perguntas:config.perguntas.map((x,i)=>i===index?{...x,pergunta:e.target.value}:x)})}/></label><label>Resposta aprovada<textarea value={p.resposta} required minLength={3} maxLength={1500} onChange={e=>setConfig({...config,perguntas:config.perguntas.map((x,i)=>i===index?{...x,resposta:e.target.value}:x)})}/></label><button type="button" onClick={()=>setConfig({...config,perguntas:config.perguntas.filter((_,i)=>i!==index)})}>Remover resposta</button></fieldset>)}
        <div className={styles.acoes}><button type="button" disabled={config.perguntas.length>=30} onClick={()=>setConfig({...config,perguntas:[...config.perguntas,{id:'faq_'+crypto.randomUUID().slice(0,8),pergunta:'',resposta:''}]})}>Adicionar resposta</button><button type="submit" disabled={ocupado} className={styles.primario}>Salvar configuração</button><button type="button" onClick={()=>setConfig(null)}>Cancelar edição</button></div>
      </form>}</details>}
      {quadro ? <><p>Contagens das {dados.conversas.length} conversas carregadas (até as 100 atualizadas mais recentemente).</p><div className={styles.quadro}>{(Object.keys(estados) as Estado[]).map(estado=><section key={estado} className={styles.painel} aria-label={estados[estado]}><h2>{estados[estado]} ({dados.conversas.filter(c=>c.estado===estado).length})</h2>{dados.conversas.filter(c=>c.estado===estado).map(c=>cartao(c,`${dataBr(c.interesse.data) || 'Data não informada'} · ${c.interesse.convidados ? c.interesse.convidados+' convidados' : 'Convidados não informados'}`))}{!dados.conversas.some(c=>c.estado===estado)&&<p>Nenhuma conversa.</p>}</section>)}</div></> : <div className={styles.layout}>
        <aside className={styles.painel} aria-label="Lista de conversas"><h2>Conversas</h2>{!dados.conversas.length&&<p>Nenhuma conversa recebida.</p>}{aguardando > 0 && <p className={styles.fila}>{aguardando === 1 ? '1 aguardando atendente' : `${aguardando} aguardando atendente`} entre as {dados.conversas.length} conversas carregadas</p>}{dados.conversas.map(c=>cartao(c,estados[c.estado]))}</aside>
        <section className={styles.painel} aria-label="Conversa selecionada">{!conversa ? <p>Selecione uma conversa para atender.</p> : <>
          <button type="button" className={styles.voltar} onClick={voltarALista}>Voltar às conversas</button>
          <h2 ref={tituloConversa} tabIndex={-1}>Contato · final {conversa.contato_final} · {estados[conversa.estado]}</h2>
          <p>Responsável: {responsavel(conversa, dados.usuarioId)} · Interesse: {dataBr(conversa.interesse.data) || 'data pendente'} · {conversa.interesse.convidados || 'quantidade pendente'} convidados</p>
          {conversa.nao_contatar && <p role="status">Este contato pediu para não receber mensagens. Novos envios estão bloqueados.</p>}
          <div className={styles.acoes}><button disabled={ocupado||conversa.nao_contatar||(conversa.estado==='HUMANO'&&conversa.responsavel_id===dados.usuarioId)} onClick={()=>void agir('assumir')}>Assumir e pausar IA</button><button className={styles.retomarIa} disabled={ocupado||conversa.nao_contatar||!dados.automacaoDisponivel||!dados.ia.ia||!dados.configuracao?.ativo||conversa.estado==='ENCERRADA'||conversa.estado==='IA'} onClick={()=>void agir('retomar')}>Retomar IA</button><button disabled={ocupado||conversa.estado==='ENCERRADA'} onClick={()=>void agir('encerrar')}>Encerrar</button><Link className={styles.primario} href="/clientes">Preparar contratação</Link></div>{motivoRetomar && <p>{motivoRetomar}</p>}
          <div className={styles.historico} aria-label="Histórico da conversa">{!historico.length && <p>Nenhuma mensagem para mostrar.</p>}{historico.map(m=><article key={m.id} className={styles.mensagem} data-direcao={m.direcao}><small>{m.direcao==='ENTRADA'?'Cliente':m.humana?'Atendente':'Assistente virtual'} · {(m.direcao==='ENTRADA'?entrada:saida)[m.estado] || m.estado} · <time dateTime={m.criada_em}>{horario(m.criada_em)}</time></small><p>{m.texto || 'Conteúdo sem texto (mídia ou mensagem longa demais). Consulte o canal original; a análise desse conteúdo ainda não está disponível.'}</p>{m.direcao==='SAIDA' && explicacaoSaida[m.estado] && <p className={styles.explicacao} data-estado={m.estado}>{explicacaoSaida[m.estado]}</p>}</article>)}</div>
          <form onSubmit={e=>{e.preventDefault();if(podeResponder&&texto.trim())void agir('enviar');}}><label htmlFor="resposta-whatsapp">Resposta do atendente</label><textarea id="resposta-whatsapp" maxLength={4000} value={texto} onChange={e=>setTexto(e.target.value)} disabled={!podeResponder} aria-describedby={motivoSemResposta ? 'resposta-motivo' : undefined} />{motivoSemResposta && <p id="resposta-motivo">{motivoSemResposta}</p>}<button className={styles.primario} disabled={!podeResponder||!texto.trim()}>Enviar resposta</button></form>
        </>}</section>
      </div>}
    </>}
  </main>;
}
