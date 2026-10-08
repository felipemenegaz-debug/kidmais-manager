'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { ConfiguracaoAtendimento } from '@/lib/whatsapp/atendimento/core';
import type { ConversaLista, EstadoCanal, MensagemLista } from '@/lib/whatsapp/atendimento/service';
import type { ResumoConversa } from '@/lib/whatsapp/atendimento/walle/resumo';
import styles from './atendimento.module.css';
import { MensagensProntas, type MidiaPronta } from './MensagensProntas';
import { resumoEncerramento } from '@/lib/whatsapp/atendimento/encerramento';
import { identificar } from '@/lib/whatsapp/atendimento/identificacao';
import { bloqueioDoCodigo, type BloqueioAtendimento } from '@/lib/whatsapp/atendimento/acesso-tela';

type Dados = { usuarioId: string; conversas: ConversaLista[]; mensagens: MensagemLista[]; configuracao: ConfiguracaoAtendimento | null; automacaoDisponivel: boolean; canal: EstadoCanal; ia: { ia: boolean; orcamento: boolean }; podeConfigurar: boolean; wallE?: { disponivel: boolean; conversaId?: string | null; resumo: ResumoConversa | null } };
type Filtro = 'TODAS' | 'AGUARDANDO_HUMANO' | 'MINHAS' | 'IA' | 'ENCERRADA';
const FILTROS: [Filtro, string][] = [['TODAS', 'Todas'], ['AGUARDANDO_HUMANO', 'Aguardando equipe'], ['MINHAS', 'Com você'], ['IA', 'Com Wall-e'], ['ENCERRADA', 'Encerradas']];
/** Estados em linguagem da equipe: quem está com a conversa agora. */
function rotuloEstado(c: ConversaLista, usuarioId: string) {
  if (c.estado === 'IA') return 'Com Wall-e';
  if (c.estado === 'AGUARDANDO_HUMANO') return 'Aguardando equipe';
  if (c.estado === 'ENCERRADA') return 'Encerrada';
  return c.responsavel_id === usuarioId ? 'Com você' : `Com ${c.responsavel_nome ?? 'outro atendente'}`;
}
const noFiltro = (c: ConversaLista, f: Filtro, usuarioId: string) => f === 'TODAS' || (f === 'MINHAS' ? c.estado === 'HUMANO' && c.responsavel_id === usuarioId : c.estado === f);
const dataBr = (iso: string | null | undefined) => iso ? iso.split('-').reverse().join('/') : null;
const horario = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// O estado da mensagem depende da direção: uma entrada "cancelada" não é uma mensagem perdida.
const saida: Record<string,string> = { PENDENTE: 'Na fila', PROCESSANDO: 'Preparando', ENVIANDO: 'Enviando', SUBMETIDA: 'Enviada ao provedor', ENTREGUE: 'Entregue', FALHOU: 'Não enviada', CANCELADA: 'Não enviada', INCERTO: 'Entrega não confirmada' };
const entrada: Record<string,string> = { PENDENTE: 'Aguardando o Wall-e', PROCESSANDO: 'Wall-e analisando', PROCESSADA: 'Recebida', CANCELADA: 'Sem resposta automática', FALHOU: 'Wall-e não respondeu; encaminhada' };
// O que aconteceu e o que fazer, para saídas que não chegaram (ou podem não ter chegado) ao cliente.
const explicacaoSaida: Record<string,string> = {
  PENDENTE: 'Sai quando o processador rodar. Se ficar mais de 15 minutos na fila, é cancelada e não é enviada.',
  CANCELADA: 'Cancelada antes do envio: conversa assumida, nova mensagem do cliente, material alterado na biblioteca, configuração alterada, janela de 24 horas ou prazo da fila. O cliente não recebeu.',
  FALHOU: 'O provedor recusou ou informou falha. O cliente não recebeu; responda de novo se ainda fizer sentido.',
  INCERTO: 'O provedor não confirmou o envio, e o cliente pode ter recebido. Confira no WhatsApp antes de repetir: não há reenvio automático.',
};
const ANEXO: Record<MidiaPronta['tipo'], { nome: string; anexado: string; botao: string; aviso: string }> = {
  IMAGEM: { nome: 'Foto', anexado: 'anexada', botao: 'Enviar foto', aviso: 'Esta foto mudou ou foi removida na biblioteca depois da prévia e não foi enviada.' },
  VIDEO: { nome: 'Vídeo', anexado: 'anexado', botao: 'Enviar vídeo', aviso: 'Este vídeo mudou ou foi removido na biblioteca depois da prévia e não foi enviado.' },
  DOCUMENTO: { nome: 'PDF', anexado: 'anexado', botao: 'Enviar PDF', aviso: 'Este PDF mudou ou foi removido na biblioteca depois da prévia e não foi enviado.' },
};
const JANELA_MS = 24 * 60 * 60 * 1000;
/** Foto/vídeo/PDF anexado à resposta: preso à conversa de origem (outra conversa não o enxerga nem envia). */
type Anexo = MidiaPronta & { conversaId: string; desatualizado?: boolean };
/** Rascunho POR CONVERSA: texto e anexo ficam com o contato certo ao trocar de conversa e voltar. */
type Rascunho = { texto: string; anexo: Anexo | null };
type Sugestao = { conversaId: string; texto: string; materiais: { prontaId: string; titulo: string; tipo: string }[]; motivos: string[] };
const VAZIO: Rascunho = { texto: '', anexo: null };

function responsavel(c: ConversaLista, usuarioId: string) {
  if (!c.responsavel_id) return 'Sem responsável';
  return c.responsavel_id === usuarioId ? 'Você' : c.responsavel_nome ?? 'Outro atendente';
}

/**
 * Atendimento: lista de conversas à esquerda, conversa no centro com o campo de resposta sempre visível (anexar,
 * mensagens prontas e enviar ao lado) e o resumo recolhível à direita. A biblioteca abre numa gaveta (nunca entre o
 * histórico e a resposta); cadastro da biblioteca e configuração ficam em telas próprias. Nada sai sem clique em Enviar.
 */
export default function AtendimentoWhatsapp() {
  const [dados,setDados] = useState<Dados | null>(null), [selecionada,setSelecionada] = useState<string | null>(null), [erro,setErro] = useState(''), [bloqueio,setBloqueio] = useState<BloqueioAtendimento | null>(null), [ocupado,setOcupado] = useState(false), [lidoEm,setLidoEm] = useState(0), [statusAcao,setStatusAcao] = useState('');
  const [rascunhos,setRascunhos] = useState<Record<string, Rascunho>>({}), [filtro,setFiltro] = useState<Filtro>('TODAS'), [busca,setBusca] = useState(''), [resumoAberto,setResumoAberto] = useState(false);
  const [sugestao,setSugestao] = useState<Sugestao | null>(null), [pedirPronta,setPedirPronta] = useState<{ id: string; n: number } | null>(null);
  // Muda quando a resposta sai ou o anexo deixa de valer: o aviso "anexada/colocado" da biblioteca some (MensagensProntas).
  const [cicloResposta,setCicloResposta] = useState(0), botaoRemoverAnexo = useRef<HTMLButtonElement>(null);
  const pedidoAtual = useRef(0), tituloConversa = useRef<HTMLHeadingElement>(null), focarConversa = useRef(false), cartoes = useRef(new Map<string, HTMLButtonElement>()), dialogoEncerrar = useRef<HTMLDialogElement>(null), botaoEncerrar = useRef<HTMLButtonElement>(null), campoResposta = useRef<HTMLTextAreaElement>(null), selecionadaAtual = useRef<string | null>(null), caixaHistorico = useRef<HTMLDivElement>(null);
  const carregar = useCallback(async () => {
    const pedido = ++pedidoAtual.current;
    try { const r = await adminFetch('/api/admin/atendimento' + (selecionada ? '?conversaId=' + selecionada : '')); const json = await r.json();
      // Recusa de acesso (empresa ativa divergente, seleção pendente, sem acesso): some com os dados já carregados e diz o que fazer.
      const recusa = r.ok ? null : bloqueioDoCodigo(json?.codigo);
      if (recusa) { if (pedido === pedidoAtual.current) { setDados(null); setBloqueio(recusa); setErro(''); } return; }
      if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível carregar o atendimento.'); if (pedido === pedidoAtual.current) { setDados(json.data); setLidoEm(Date.now()); setErro(''); setBloqueio(null); } }
    catch(e) { if (pedido === pedidoAtual.current) setErro(e instanceof Error ? e.message : 'Não foi possível carregar o atendimento.'); }
  },[selecionada]);
  useEffect(() => { const contador = pedidoAtual; const inicio = window.setTimeout(() => void carregar(),0); const timer = window.setInterval(() => { if (!document.hidden) void carregar(); },10000); return () => { ++contador.current; window.clearTimeout(inicio); window.clearInterval(timer); }; },[carregar]);
  const conversa = dados?.conversas.find(c => c.id === selecionada);
  useEffect(() => { selecionadaAtual.current = selecionada; }, [selecionada]);
  // Resumo aberto por padrão só em tela larga (três colunas); em telas menores ele abre por cima, a pedido.
  useEffect(() => { const t = window.setTimeout(() => { if (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1180px)').matches) setResumoAberto(true); }, 0); return () => window.clearTimeout(t); }, []);
  // Celular e teclado: ao escolher uma conversa, o foco vai para ela (a lista pode ter até 100 itens acima).
  useEffect(() => { if (conversa && focarConversa.current) { focarConversa.current = false; tituloConversa.current?.focus(); tituloConversa.current?.scrollIntoView({ block: 'start' }); } }, [conversa]);
  const rascunhoDe = (id: string | null) => (id && rascunhos[id]) || VAZIO;
  const alterarRascunho = (id: string, fn: (r: Rascunho) => Rascunho) => setRascunhos(todos => ({ ...todos, [id]: fn(todos[id] ?? VAZIO) }));
  const texto = rascunhoDe(selecionada).texto;
  // Só vale o anexo da conversa aberta (segunda trava, além do rascunho por conversa).
  const anexoAtual = selecionada && rascunhoDe(selecionada).anexo?.conversaId === selecionada ? rascunhoDe(selecionada).anexo : null;
  async function agir(acao: 'assumir' | 'retomar' | 'encerrar' | 'enviar') {
    if (!conversa || ocupado) return null;
    setOcupado(true);setErro('');setStatusAcao('');
    // Envio com anexo: o id e a versão da mensagem pronta vistos na prévia e a legenda (opcional); a mídia é lida no servidor.
    const alvo = conversa.id, midia = acao === 'enviar' ? anexoAtual : null, textoEnvio = rascunhoDe(alvo).texto;
    if (midia?.desatualizado) { setOcupado(false); return null; }
    const corpo = acao !== 'enviar' ? {} : midia ? { prontaMidiaId: midia.prontaId, prontaVersao: midia.versao, ...(textoEnvio.trim() ? { texto: textoEnvio } : {}) } : { texto: textoEnvio };
    try { const r = await adminFetch('/api/admin/atendimento',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({acao,conversaId:alvo,versao:Number(conversa.versao),...corpo})}); const json = await r.json();
      // O material mudou depois da prévia: nada foi enviado. O anexo fica marcado (o aviso está nele) e o envio fica
      // bloqueado até remover e revisar de novo; a mídia nunca é trocada em silêncio. Foco em "Remover anexo".
      if (midia && json?.codigo === 'ATENDIMENTO_PRONTA_MIDIA_ALTERADA') { alterarRascunho(alvo, r => r.anexo && r.anexo.prontaId === midia.prontaId ? { ...r, anexo: { ...r.anexo, desatualizado: true } } : r); setCicloResposta(n => n + 1); window.setTimeout(() => botaoRemoverAnexo.current?.focus(), 0); return null; }
      if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível concluir.'); if (acao==='enviar') { alterarRascunho(alvo, () => VAZIO); setCicloResposta(n => n + 1); } await carregar(); return (json.data ?? {}) as { canceladas?: { entradas: number; saidas: number } }; }
    catch(e) {setErro(e instanceof Error ? e.message : 'Não foi possível concluir.'); return null;} finally {setOcupado(false);}
  }
  // Encerrar pede confirmação (diálogo nativo: foco preso, Esc cancela). Abrir/fechar é imperativo: o próprio diálogo
  // é a fonte da verdade. Depois de encerrar, o foco vai explicitamente ao título da conversa.
  // As pendentes são canceladas no servidor, na mesma transação; o histórico fica.
  function abrirConfirmacaoEncerrar() { const d = dialogoEncerrar.current; if (d && !d.open) d.showModal(); }
  async function encerrarConfirmado() {
    const r = await agir('encerrar');
    dialogoEncerrar.current?.close();
    if (r) window.setTimeout(() => tituloConversa.current?.focus(), 0);
    if (r) setStatusAcao(resumoEncerramento(r.canceladas));
  }
  // Só aceita rascunho da conversa aberta (a biblioteca já confere; aqui é a segunda trava, pela conversa vigente).
  // Anexo: substitui o anterior e a legenda vai para o campo; texto puro tira o anexo (a resposta é uma só).
  function usarProntaNaResposta(rascunho: string, origem: string, midia: MidiaPronta | null) { if (origem !== selecionadaAtual.current) return; alterarRascunho(origem, () => ({ texto: rascunho, anexo: midia ? { ...midia, conversaId: origem } : null })); window.setTimeout(() => campoResposta.current?.focus(), 0); }
  function removerAnexo() { if (!selecionada) return; alterarRascunho(selecionada, r => ({ ...r, anexo: null })); setCicloResposta(n => n + 1); window.setTimeout(() => campoResposta.current?.focus(), 0); }
  async function sugerir() {
    if (!conversa || ocupado) return; const alvo = conversa.id; setOcupado(true); setErro('');
    try { const r = await adminFetch('/api/admin/atendimento',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({acao:'sugerir',conversaId:alvo})}); const json = await r.json();
      if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível sugerir agora.'); if (alvo === selecionadaAtual.current) setSugestao({ conversaId: alvo, ...json.data }); }
    catch(e) { setErro(e instanceof Error ? e.message : 'Não foi possível sugerir agora.'); } finally { setOcupado(false); }
  }
  function usarSugestao() { if (!sugestao || sugestao.conversaId !== selecionadaAtual.current) return; alterarRascunho(sugestao.conversaId, r => ({ ...r, texto: sugestao.texto })); setSugestao(null); window.setTimeout(() => campoResposta.current?.focus(), 0); }
  // Trocar de conversa NÃO apaga o rascunho: cada conversa guarda o seu (texto e anexo) até enviar ou limpar.
  function escolher(id: string) {focarConversa.current=true;setSelecionada(id);setStatusAcao('');setSugestao(null);}
  // Celular: lista e conversa são telas separadas. Voltar fecha a conversa (o rascunho dela fica guardado) e devolve o
  // foco ao cartão de onde ela foi aberta.
  function voltarALista() { const anterior = selecionada; setSelecionada(null); setSugestao(null); window.setTimeout(() => { const atual = anterior ? cartoes.current.get(anterior) : undefined; atual?.focus(); atual?.scrollIntoView({ block: 'center' }); }, 0); }
  const usuarioId = dados?.usuarioId ?? '';
  const cartao = (c: ConversaLista) => { const id = identificar(c); const pendente = !!(rascunhos[c.id]?.texto.trim() || rascunhos[c.id]?.anexo); return <li key={c.id}><button className={styles.cardConversa} data-estado={c.estado} ref={el => { if (el) cartoes.current.set(c.id, el); else cartoes.current.delete(c.id); }} aria-pressed={c.id===selecionada} onClick={()=>escolher(c.id)}>
    <strong>{id.titulo}</strong>{id.origemTitulo !== 'NUMERO' && <span>{id.telefone}</span>}{id.ambiguo && <span className={styles.fila}>Vários cadastros com este número</span>}<span className={styles.selo} data-estado={c.estado}>{rotuloEstado(c, usuarioId)}</span><span>{c.atualizada_em ? horario(c.atualizada_em) : ''}{pendente ? ' · rascunho' : ''}</span>
  </button></li>; };
  // Horário da última leitura (atualizada a cada 10 s): a janela é conferida de novo no servidor ao enviar.
  // Só as mensagens da conversa aberta: ao trocar de conversa, o histórico anterior não aparece sob o novo contato.
  const historico = dados?.mensagens.filter(m => m.conversa_id === selecionada) ?? [];
  // Histórico abre e acompanha a mensagem mais recente (conversa aberta ou mensagem nova).
  const ultimaMensagem = historico.at(-1)?.id ?? null;
  useEffect(() => { const caixa = caixaHistorico.current; if (caixa) caixa.scrollTop = caixa.scrollHeight; }, [selecionada, ultimaMensagem]);
  const janelaAberta = conversa ? lidoEm - new Date(conversa.ultima_entrada_em).getTime() < JANELA_MS : false;
  const podeResponder = !!conversa && !ocupado && !conversa.nao_contatar && conversa.estado === 'HUMANO' && conversa.responsavel_id === dados?.usuarioId && !!dados?.automacaoDisponivel && !!dados?.ia.ia && !!dados?.configuracao?.ativo && janelaAberta;
  const aguardando = dados?.conversas.filter(c => c.estado === 'AGUARDANDO_HUMANO').length ?? 0;
  const termo = busca.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const visiveis = (dados?.conversas ?? []).filter(c => noFiltro(c, filtro, usuarioId) && (!termo || `${identificar(c).titulo} ${c.contato}`.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().includes(termo)));
  // Só quando "Devolver ao Wall-e" faria sentido (conversa com a equipe) e está bloqueado por configuração do servidor ou da empresa.
  const motivoRetomar = !conversa || !dados || conversa.nao_contatar || conversa.estado === 'IA' || conversa.estado === 'ENCERRADA' ? '' : !dados.automacaoDisponivel ? 'Devolver ao Wall-e indisponível: o envio está desligado no servidor deste ambiente.' : !dados.ia.ia ? 'Devolver ao Wall-e indisponível: a chave da IA está desligada neste ambiente.' : !dados.configuracao?.ativo ? 'Devolver ao Wall-e indisponível: o atendimento automático da empresa está desligado na configuração.' : '';
  const motivoSemResposta = !conversa || !dados ? '' : conversa.nao_contatar ? 'Este contato pediu para não receber mensagens.' : !dados.automacaoDisponivel ? 'O envio está desligado no servidor deste ambiente.' : !dados.ia.ia ? 'A chave da IA está desligada neste ambiente: a fila não envia respostas agora.' : !dados.configuracao?.ativo ? 'O atendimento da empresa está desligado na configuração: respostas pela fila não saem.' : conversa.estado !== 'HUMANO' || conversa.responsavel_id !== dados.usuarioId ? 'Assuma a conversa para responder.' : !janelaAberta ? 'A janela de 24 horas expirou. Aguarde nova mensagem do cliente.' : '';
  // O resumo é da conversa pedida na última leitura: logo depois de trocar de conversa ele ainda não vale para a nova.
  const resumo = dados?.wallE?.conversaId === selecionada ? dados.wallE.resumo : null;
  const sugestaoAtual = sugestao && sugestao.conversaId === selecionada ? sugestao : null;
  const comEquipe = !!conversa && (conversa.estado === 'HUMANO' || conversa.estado === 'AGUARDANDO_HUMANO');
  return <main className={styles.pagina}>
    <header className={styles.topo}><div><h1>Atendimento</h1><p>Conversas do WhatsApp com o Wall-e e a equipe.</p></div><div className={styles.acoes}><Link href="/admin/atendimento/biblioteca">Biblioteca</Link>{dados?.podeConfigurar && <Link href="/admin/atendimento/configuracao">Configurações</Link>}<button onClick={()=>void carregar()} disabled={ocupado}>Atualizar</button></div></header>
    {bloqueio && <section className={styles.bloqueio} role="alert" aria-labelledby="bloqueio-atendimento" data-bloqueio={bloqueio.tipo}><h2 id="bloqueio-atendimento">{bloqueio.titulo}</h2><p>{bloqueio.orientacao}</p></section>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {statusAcao && <p role="status" className={styles.aviso}>{statusAcao}</p>}
    {!dados && !erro && !bloqueio && <p aria-live="polite">Carregando atendimento…</p>}
    {dados && <>
      <details className={styles.canal}>
        <summary>Situação do canal: {dados.canal.envio && dados.ia.ia && dados.configuracao?.ativo ? 'respondendo' : 'sem respostas automáticas'}{dados.configuracao?.wallE?.ativo && dados.wallE?.disponivel ? ' · Wall-e ligado' : ''}</summary>
        <dl>
          <div data-ligado={dados.canal.receptor}><dt>Receptor do número</dt><dd>{dados.canal.receptor ? `Este ambiente (${dados.canal.ambiente})` : 'Outro ambiente ou nenhum'}</dd></div>
          <div data-ligado={dados.canal.recepcao}><dt>Receber mensagens</dt><dd>{dados.canal.recepcao ? 'Ligado' : 'Desligado'}</dd></div>
          <div data-ligado={dados.canal.envio && dados.ia.ia}><dt>Enviar respostas</dt><dd>{!dados.canal.envio ? 'Desligado' : dados.ia.ia ? 'Ligado' : 'Bloqueado pela chave da IA'}</dd></div>
          <div data-ligado={dados.ia.orcamento}><dt>Orçamento da IA</dt><dd>{dados.ia.orcamento ? 'Definido' : 'Sem teto: a IA não é chamada'}</dd></div>
          <div data-ligado={!!dados.configuracao?.ativo}><dt>Atendimento automático</dt><dd>{dados.configuracao?.ativo ? 'Ligado' : 'Desligado'}</dd></div>
          <div data-ligado={!!(dados.configuracao?.wallE?.ativo && dados.wallE?.disponivel)}><dt>Wall-e</dt><dd>{!dados.wallE?.disponivel ? 'Indisponível neste ambiente' : dados.configuracao?.wallE?.ativo ? 'Ligado' : 'Desligado'}</dd></div>
        </dl>
      </details>
      <div className={styles.layout} data-resumo={resumoAberto && !!conversa ? 'aberto' : 'fechado'} data-conversa={conversa ? 'aberta' : undefined}>
        <aside className={styles.colunaLista} aria-label="Lista de conversas">
          <h2>Conversas</h2>
          {aguardando > 0 && <p className={styles.fila}>{aguardando === 1 ? '1 aguardando equipe' : `${aguardando} aguardando equipe`}</p>}
          <label className={styles.oculto} htmlFor="busca-conversas">Buscar conversa</label><input id="busca-conversas" type="search" placeholder="Buscar nome ou número" value={busca} onChange={e=>setBusca(e.target.value)} />
          <div className={styles.filtrosEstado} role="group" aria-label="Filtrar por situação">{FILTROS.map(([f, rotulo]) => <button key={f} type="button" aria-pressed={filtro===f} onClick={()=>setFiltro(f)}>{rotulo}</button>)}</div>
          {!dados.conversas.length ? <p>Nenhuma conversa recebida.</p> : !visiveis.length ? <p>Nenhuma conversa nesse filtro.</p> : <ul className={styles.listaConversas}>{visiveis.map(cartao)}</ul>}
        </aside>
        <section className={styles.colunaConversa} aria-label="Conversa selecionada">{!conversa ? <p className={styles.vazio}>Selecione uma conversa para atender.</p> : <>
          <div className={styles.cabecalhoConversa}>
            <button type="button" className={styles.voltar} onClick={voltarALista}>Voltar às conversas</button>
            {(() => { const id = identificar(conversa); return <>
              <h2 ref={tituloConversa} tabIndex={-1}>{id.titulo}</h2>
              <p className={styles.subtitulo}><span>{id.telefone}</span><span className={styles.selo} data-estado={conversa.estado}>{rotuloEstado(conversa, dados.usuarioId)}</span></p>
            </>; })()}
            <div className={styles.acoes}><button disabled={ocupado||conversa.nao_contatar||(conversa.estado==='HUMANO'&&conversa.responsavel_id===dados.usuarioId)} onClick={()=>void agir('assumir')}>Assumir</button><button className={styles.retomarIa} disabled={ocupado||conversa.nao_contatar||!dados.automacaoDisponivel||!dados.ia.ia||!dados.configuracao?.ativo||conversa.estado==='ENCERRADA'||conversa.estado==='IA'} onClick={()=>void agir('retomar')}>Devolver ao Wall-e</button><button ref={botaoEncerrar} aria-haspopup="dialog" disabled={ocupado||conversa.estado==='ENCERRADA'} onClick={abrirConfirmacaoEncerrar}>Encerrar</button><button type="button" aria-expanded={resumoAberto} aria-controls="resumo-conversa" onClick={()=>setResumoAberto(v=>!v)}>{resumoAberto ? 'Ocultar resumo' : 'Resumo'}</button></div>
            {motivoRetomar && <p className={styles.nota}>{motivoRetomar}</p>}
            {conversa.nao_contatar && <p role="status">Este contato pediu para não receber mensagens. Novos envios estão bloqueados.</p>}
          </div>
          <div ref={caixaHistorico} className={styles.historico} aria-label="Histórico da conversa">{!historico.length && <p>Nenhuma mensagem para mostrar.</p>}{historico.map(m=><article key={m.id} className={styles.mensagem} data-direcao={m.direcao} data-humana={m.humana || undefined}><small>{m.direcao==='ENTRADA'?'Cliente':m.humana?'Atendente':'Wall-e'} · {(m.direcao==='ENTRADA'?entrada:saida)[m.estado] || m.estado} · <time dateTime={m.criada_em}>{horario(m.criada_em)}</time></small>{m.midia_tipo && (m.midia_url || m.midia_caminho) && <p className={styles.anexo}><strong>{ANEXO[m.midia_tipo].nome}</strong>{m.midia_nome ? ` · ${m.midia_nome}` : ''} · <a href={m.midia_caminho ?? m.midia_url ?? undefined} target="_blank" rel="noopener noreferrer">conferir em nova aba</a></p>}{(m.texto || !m.midia_tipo) && <p>{m.texto || 'Conteúdo sem texto (mídia ou mensagem longa demais). Consulte o canal original; a análise desse conteúdo ainda não está disponível.'}</p>}{m.direcao==='SAIDA' && explicacaoSaida[m.estado] && <p className={styles.explicacao} data-estado={m.estado}>{explicacaoSaida[m.estado]}</p>}</article>)}</div>
          <div className={styles.composer}>
            {anexoAtual && <div className={styles.anexo} role="group" aria-label="Anexo da resposta" data-desatualizado={anexoAtual.desatualizado || undefined}><p><strong>{ANEXO[anexoAtual.tipo].nome}</strong> {ANEXO[anexoAtual.tipo].anexado}: “{anexoAtual.titulo}” · <a href={anexoAtual.url} target="_blank" rel="noopener noreferrer">conferir em nova aba</a></p>{anexoAtual.desatualizado && <p role="alert" className={styles.fila}>{ANEXO[anexoAtual.tipo].aviso} Remova o anexo e abra a prévia de novo para revisar.</p>}<button ref={botaoRemoverAnexo} type="button" onClick={removerAnexo}>Remover anexo</button></div>}
            <form className={styles.formResposta} onSubmit={e=>{e.preventDefault();if(podeResponder&&!anexoAtual?.desatualizado&&(texto.trim()||anexoAtual))void agir('enviar');}}>
              <label htmlFor="resposta-whatsapp" className={styles.oculto}>{anexoAtual ? 'Legenda da resposta (opcional, até 1024 caracteres)' : 'Resposta do atendente'}</label>
              <textarea ref={campoResposta} id="resposta-whatsapp" placeholder={anexoAtual ? 'Legenda (opcional)' : 'Escreva a resposta'} maxLength={anexoAtual ? 1024 : 4000} value={texto} onChange={e=>{ const valor = e.target.value; if (selecionada) alterarRascunho(selecionada, r => ({ ...r, texto: valor })); }} onKeyDown={e=>{ if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); (e.target as HTMLTextAreaElement).form?.requestSubmit(); } }} disabled={!podeResponder} aria-describedby={motivoSemResposta ? 'resposta-motivo' : 'resposta-atalho'} />
              <button className={styles.primario} disabled={!podeResponder||!!anexoAtual?.desatualizado||(!texto.trim()&&!anexoAtual)}>{anexoAtual ? ANEXO[anexoAtual.tipo].botao : 'Enviar resposta'}</button>
            </form>
            {/* Fora do formulário: Enter na busca da biblioteca não envia a resposta. */}
            <div className={styles.ferramentas}><MensagensProntas conversaId={conversa.id} podeUsar={podeResponder} motivoBloqueio={motivoSemResposta} textoAtual={texto} onUsar={usarProntaNaResposta} cicloResposta={cicloResposta} pedirPronta={pedirPronta} /></div>
            {motivoSemResposta ? <p id="resposta-motivo" className={styles.nota}>{motivoSemResposta}</p> : <p id="resposta-atalho" className={`${styles.nota} ${styles.dica}`}>Ctrl + Enter envia. Nada sai sem você.</p>}
          </div>
          <dialog ref={dialogoEncerrar} className={styles.dialogo} aria-labelledby="encerrar-titulo" aria-describedby="encerrar-texto">
            <h2 id="encerrar-titulo">Encerrar atendimento?</h2>
            <p id="encerrar-texto">A conversa será marcada como encerrada e as respostas pendentes serão canceladas. O histórico será mantido.</p>
            <div className={styles.acoes}><button type="button" autoFocus onClick={()=>dialogoEncerrar.current?.close()}>Cancelar</button><button type="button" className={styles.perigo} disabled={ocupado} onClick={()=>void encerrarConfirmado()}>Encerrar atendimento</button></div>
          </dialog>
        </>}</section>
        {conversa && resumoAberto && <aside id="resumo-conversa" className={styles.colunaResumo} aria-label="Resumo da conversa">
          <div className={styles.topoGaveta}><h2>Resumo</h2><button type="button" className={styles.fecharResumo} onClick={()=>setResumoAberto(false)}>Fechar resumo</button></div>
          {resumo?.passagem && conversa.estado !== 'IA' && <div className={styles.passagem}><p><strong>Passado para a equipe:</strong> {resumo.passagem.motivosTexto.join('; ')}</p>{resumo.passagem.pendentes.length > 0 && <p>Falta saber: {resumo.passagem.pendentes.join('; ')}.</p>}</div>}
          <dl className={styles.dadosResumo}>
            <dt>Responsável</dt><dd>{responsavel(conversa, dados.usuarioId)}</dd>
            <dt>Interesse</dt><dd>{resumo?.interesse.length ? resumo.interesse.join(', ') : 'Não informado'}</dd>
            <dt>Data</dt><dd>{dataBr(resumo?.data ?? conversa.interesse.data) ?? 'Não informada'}</dd>
            <dt>Horário</dt><dd>{resumo?.horario ?? 'Não informado'}</dd>
            <dt>Convidados</dt><dd>{(resumo?.convidados ?? conversa.interesse.convidados) ?? 'Não informado'}</dd>
            <dt>Pacote</dt><dd>{resumo?.pacote ?? 'Não escolhido'}</dd>
            {resumo?.unidade && <><dt>Unidade</dt><dd>{resumo.unidade}</dd></>}
            {resumo?.tema && <><dt>Tema</dt><dd>{resumo.tema}</dd></>}
          </dl>
          {!!resumo?.enviados.length && <><h3>Materiais enviados</h3><ul className={styles.listaSimples}>{resumo.enviados.map(e => <li key={e.titulo + e.versao}>{e.titulo} (versão {e.versao})</li>)}</ul></>}
          {(() => { const id = identificar(conversa); return <details className={styles.identificacaoDetalhe}><summary>Identificação do contato</summary>
            {/* Três fontes sempre rotuladas: número do canal, cadastro da empresa e perfil do WhatsApp (não verificado). */}
            <dl className={styles.identificacao} aria-label="Identificação do contato">
              <dt>Número</dt><dd>{id.telefone}</dd>
              <dt>Cadastro</dt><dd className={id.ambiguo ? styles.fila : undefined}>{id.cadastro}</dd>
              <dt>Perfil no WhatsApp</dt><dd className={styles.naoVerificado}>{id.perfil}</dd>
            </dl></details>; })()}
          {dados.wallE?.disponivel && comEquipe && <div className={styles.sugestao}>
            <h3>Sugestão do Wall-e</h3>
            <p className={styles.nota}>Baseada nas fontes oficiais e na última mensagem do cliente. Nada é enviado: você revisa no campo de resposta.</p>
            {!sugestaoAtual && <button type="button" className={styles.retomarIa} aria-disabled={ocupado || undefined} onClick={()=>void sugerir()}>Sugerir resposta</button>}
            {sugestaoAtual && <>
              {sugestaoAtual.texto ? <p className={styles.textoSugestao}>{sugestaoAtual.texto}</p> : <p>Sem sugestão para a última mensagem.</p>}
              {sugestaoAtual.motivos.length > 0 && <p className={styles.fila}>Atenção da equipe: {sugestaoAtual.motivos.join('; ')}.</p>}
              {sugestaoAtual.materiais.map(m => <p key={m.prontaId} className={styles.anexo}>{m.titulo} · <button type="button" onClick={()=>setPedirPronta(p => ({ id: m.prontaId, n: (p?.n ?? 0) + 1 }))}>Preparar anexo</button></p>)}
              <div className={styles.acoes}>{sugestaoAtual.texto && <button type="button" className={styles.primario} disabled={!podeResponder} onClick={usarSugestao}>{texto.trim() ? 'Substituir a resposta' : 'Usar na resposta'}</button>}<button type="button" onClick={()=>setSugestao(null)}>Descartar sugestão</button></div>
              {!podeResponder && motivoSemResposta && <p className={styles.nota}>{motivoSemResposta}</p>}
            </>}
          </div>}
          <Link className={styles.primario} href="/clientes">Preparar contratação</Link>
        </aside>}
      </div>
    </>}
  </main>;
}
