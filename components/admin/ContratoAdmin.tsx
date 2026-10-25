'use client';
import { analisarRevisao } from '@/lib/contratos/services/alteracoes';
import { TEXTO_ASSINADO_EM_PAPEL, versaoAssinadaEmPapel } from '@/lib/contratos/assinatura-papel';
import { configuracaoModeloOficial } from '../../lib/contratos/documento/oficial/configuracao';
import { useCallback, useEffect, useState, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ContratoSnapshotV1 } from '@/lib/contratos/repositories/models';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import { formatarFormaPagamento, formatarMoeda, formatarCondicaoPix } from '@/lib/contratos/documento/formatters';
import styles from './contratos-ux.module.css';
import Link from 'next/link';
import { retornoFestaSeguro } from '@/lib/festas/apresentacao';
import EdicaoFesta from './EdicaoFesta';
import CancelarContratoFesta from './CancelarContratoFesta';
import { ContextoKidmais } from './inteligencia/PerguntarKidmais';
import CriarPlanoFinanceiro from './CriarPlanoFinanceiro';
import PagamentosResumo from './PagamentosResumo';
import { contextoCriacao } from './criacao-financeira';
import { contratoApresentacao, type ContextoContrato } from './financeiro-apresentacao';
import { FalhaContrato, MENSAGEM_LINK_INVALIDO, PREFIXO_IMPORTADO, criarSequenciador, mensagemFalhaContrato, opcaoForaDaLista, pedidoDaUrl, urlDaSelecao, valorDaSelecao } from './contrato-url';
import { ETAPAS, chaveConferencia, dataPorExtenso, etapaAtual, faixaHorario, predicados, proximoPasso, referenciasDaTela, rotuloContrato, rotuloVersao, saidaPagamentos, situacaoReserva, tituloFesta } from './contrato-tela';
import { referenciaVigente } from '@/lib/contratos/versao-referencia';
import ContratoImportado from './ContratoImportado';
import OrigemHistoricaContrato from './OrigemHistoricaContrato';
import IntegracaoContrato from './importacao/IntegracaoContrato';
import type { OrigemHistoricaContrato as OrigemHistorica } from '@/lib/contratos/importados';
type Versao = {
    id: string;
    numero_versao: number;
    motivo_nova_versao: string | null;
    criado_em: string;
    gerado_por_usuario_id: string | null;
    status: string;
    estado_edicao: string | null;
    revisao: number;
    origem_versao_id: string | null;
    alteracoes: {campos?:Array<{campo:string;antes:unknown;depois:unknown}>}|null;
    documento_revisado_id: string | null;
    snapshot: ContratoSnapshotV1;
    dados_fonte: {
        observacoesDocumentais?: string;
    } | null;
};
type Doc = {
    id: string;
    contrato_versao_id: string;
    categoria: string;
    revisao: number;
};
type Painel = {
    festaId?: string | null;
    /** Contrato integrado de importação histórica (061): conferência em papel, original e correções. */
    origemHistorica?: OrigemHistorica | null;
    /** Leituras da tela simplificada: salão (093/094) e estado derivado da festa. */
    tela?: { salao: string | null; salaoAlteracao: string | null; estadoFesta: string | null };
    revisoesOperacionais:Array<{id:string;contrato_versao_id:string;estado:string;hold_destino_adquirido_em:string|null;status_fechamento:string;ocupa_vigente:boolean;data_evento:string;data_vigente:string;horario_inicio:string;horario_fim:string;slot_alterado:boolean}>;
    financeiro:Array<{id:string;contrato_versao_id:string;valor_total_contratado:string;status:string}>;
    pendencias:Array<{id:string;motivo:string;versao_nova_id:string}>;
    contrato: {
        fechamento_id: string;
        versao_atual: number;
        id: string;
        status: string;
    };
    fluxo: {
        versao_vigente_id: string | null;
        versao_em_preparacao_id: string | null;
    } | null;
    versoes: Versao[];
    documentos: Doc[];
    assinaturas: Array<{
        id: string;
        contrato_versao_id: string;
        parte: string;
        documento_id: string;
        comprovante_documento_id: string;
        assinado_em: string;
        identidade_snapshot: {
            nome: string;
        };
    }>;
};
const EDICAO_ABERTA = ['EM_ELABORACAO', 'ASSINADA_KIDMAIS', 'AGUARDANDO_CLIENTE'];
const instante = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const tituloDocumento = (categoria: string) => categoria === 'CONTRATO' ? 'Contrato' : categoria === 'COMPROVANTE_ASSINATURA' ? 'Comprovante de assinatura' : categoria.replaceAll('_', ' ').toLowerCase();
export default function ContratoAdmin() {
    const [editando,setEditando]=useState(false);
    const [retorno,setRetorno]=useState<string|null>(null),[destino,setDestino]=useState(''),[financeiroPronto,setFinanceiroPronto]=useState('');
    const posicionado=useRef('');
    const operacaoEmCurso=useRef(false);
    const pedidoRevisao=useRef<{intencao:string;chave:string}|null>(null);
    useEffect(()=>{const atualizar=()=>{setDestino(window.location.hash);setRetorno(retornoFestaSeguro(new URLSearchParams(window.location.search).get('returnTo')));};atualizar();window.addEventListener('hashchange',atualizar);return()=>window.removeEventListener('hashchange',atualizar);},[]);
    const [lista, setLista] = useState<ContextoContrato[]>([]), [mostrarCancelados,setMostrarCancelados]=useState(false), [mostrarImportados,setMostrarImportados]=useState(true), [cid, setCid] = useState(''), [data, setData] = useState<Painel | null>(null);
    const [note, setNote] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [senha, setSenha] = useState(''), [motivo, setMotivo] = useState(''), [tipo, setTipo] = useState('NOVA_VERSAO'), [key, setKey] = useState('');
    const [menuAberto, setMenuAberto] = useState(false), [alterarAberto, setAlterarAberto] = useState(false), [filtroHistorico, setFiltroHistorico] = useState<'TUDO'|'VERSOES'|'ASSINATURAS'>('TUDO');
    // Confirmação positiva da agenda (P3-2): presa a contrato + versão + revisão e a uma geração da interação. Qualquer
    // edição, ação ou troca de contrato invalida; resposta de revalidação de uma geração anterior é descartada.
    const [conferido, setConferido] = useState<{ chave: string; em: Date } | null>(null);
    const chaveAtual = useRef(''), geracaoAtual = useRef(0);
    const invalidarConferencia = () => { geracaoAtual.current++; setConferido(null); };
    // A URL é a fonte da seleção (link do Dashboard/Financeiro/festa/assistente, seletor, voltar/avançar). Ver contrato-url.ts.
    const params = useSearchParams(), pathname = usePathname(), router = useRouter();
    const pedidoUrl = pedidoDaUrl(params);
    const urlContrato = pedidoUrl.tipo === 'contrato' ? pedidoUrl.contratoId : '', urlVersao = pedidoUrl.tipo === 'contrato' ? pedidoUrl.versaoId ?? '' : '', urlInvalida = pedidoUrl.tipo === 'invalido';
    // Contrato importado (`?importacaoId=`): registro somente leitura de `ia_importacoes`, nunca carregado como contrato do Core.
    const urlImportacao = pedidoUrl.tipo === 'importado' ? pedidoUrl.importacaoId : '';
    const sequencia = useRef(criarSequenciador());
    // Só a resposta do último pedido é aplicada: um contrato clicado antes não substitui o atual quando responde atrasado.
    const load = useCallback(async (id: string): Promise<boolean> => { const pedido = sequencia.current.iniciar(); let res: Response, b: { ok: boolean; data?: unknown; erro?: string };
        try { res = await adminFetch('/api/admin/contratos/painel?contratoId=' + id); b = await res.json(); }
        catch (e) { if (!sequencia.current.vigente(pedido)) return false; throw e; }
        if (!sequencia.current.vigente(pedido)) return false;
        if (!b.ok) throw new FalhaContrato(res.status, mensagemFalhaContrato(res.status, b.erro));
        const p = b.data as Painel; setData(p); const { alvo, referencia } = referenciasDaTela(p); setNote((alvo ?? referencia?.versao)?.dados_fonte?.observacoesDocumentais ?? ''); return true; }, []);
    useEffect(() => { let ativo = true; const filtros = new URLSearchParams(); if (mostrarCancelados) filtros.set('incluirCancelados', '1'); if (!mostrarImportados) filtros.set('incluirImportados', '0'); const busca = filtros.toString();
        adminFetch('/api/admin/contratos/painel'+(busca?`?${busca}`:'')).then(r => r.json()).then(b => { if (!b.ok)
        throw Error(b.erro); if (ativo) setLista(b.data); }).catch(e => { if (ativo) setError(e.message); }); return () => { ativo = false; }; }, [mostrarCancelados, mostrarImportados, urlContrato, urlImportacao]);
    // Novo contrato na URL ⇒ a seleção anterior sai na hora (ajuste de estado no render, sem efeito em cascata).
    // Mudar só `versaoId` (consultar/fechar consulta, voltar/avançar) mantém o detalhe já carregado: não há nova leitura.
    const chaveUrl = urlInvalida ? 'invalida' : `${urlContrato}|${urlImportacao}`;
    const [chaveAplicada, setChaveAplicada] = useState<string | null>(null);
    // A confirmação de agenda não sobrevive à navegação entre versões (sem recarregar o detalhe).
    const [versaoAplicada, setVersaoAplicada] = useState(urlVersao);
    if (versaoAplicada !== urlVersao) { setVersaoAplicada(urlVersao); setConferido(null); }
    if (chaveAplicada !== chaveUrl) {
        setChaveAplicada(chaveUrl); setCid(urlContrato); setData(null); setEditando(false); setMenuAberto(false); setAlterarAberto(false); setConferido(null); setError(urlInvalida ? MENSAGEM_LINK_INVALIDO : '');
    }
    // Contrato pedido pela URL: carregado pelo detalhe do tenant mesmo se os filtros da lista o ocultarem.
    useEffect(() => {
        if (!urlContrato) { sequencia.current.iniciar(); return; }
        load(urlContrato).catch(e => { setCid(''); setData(null); setError(e instanceof FalhaContrato ? e.message : 'Não foi possível carregar o contrato. Tente novamente.'); });
    }, [urlContrato, load]);
    // Referências (rev. 3/4): topo e Resumo pela versão de referência; ações sempre sobre o alvo.
    const refs = data ? referenciasDaTela(data) : null;
    const referencia = refs?.referencia ?? null, ref = referencia?.versao ?? null;
    const v = refs?.alvo ?? null, vid = v?.id ?? '';
    const temVigente = !!referencia && referenciaVigente(referencia.origem);
    const pred = data ? predicados(data, v) : null;
    const docs = data?.documentos.filter(d => d.contrato_versao_id === vid) ?? [], signatures = data?.assinaturas.filter(s => s.contrato_versao_id === vid) ?? [];
    // `?versaoId=` de outra versão (nem a de referência, nem o alvo): painel só de leitura.
    const consultada = data && urlVersao && urlVersao !== vid && urlVersao !== ref?.id ? data.versoes.find(x => x.id === urlVersao) ?? null : null;
    const versaoDesconhecida = !!data && !!urlVersao && !data.versoes.some(x => x.id === urlVersao);
    const chaveAgenda = v ? chaveConferencia(cid, v.id, v.revisao) : '';
    useEffect(() => { chaveAtual.current = chaveAgenda; }, [chaveAgenda]);
    // Troca de contrato (inclusive sair e voltar ao mesmo): revalidação pendente da visita anterior não confirma.
    // Troca de contrato ou de versão consultada (inclusive voltar/avançar): revalidação pendente não confirma mais.
    useEffect(() => { geracaoAtual.current++; }, [cid, urlVersao]);
    const financeiroKey=cid+':'+data?.fluxo?.versao_vigente_id;
    const financeiroCarregado=useCallback(()=>setFinanceiroPronto(financeiroKey),[financeiroKey]);
    const menuVisivel = menuAberto || destino === '#cancelar-contrato';
    useEffect(()=>{
        if(!data||!['#financeiro','#alteracoes','#cancelar-contrato'].includes(destino))return;
        const params=new URLSearchParams(window.location.search);
        if(params.get('contratoId')!==cid)return;
        if(destino==='#financeiro'&&data.financeiro.length===1&&financeiroPronto!==financeiroKey)return;
        const chave=cid+':'+vid+destino;
        if(posicionado.current===chave)return;
        if(destino!=='#financeiro'){
            // O contêiner (menu "Mais" ou faixa) já está aberto neste render; foca no próximo quadro.
            const frame=requestAnimationFrame(()=>{const section=document.getElementById(destino.slice(1));if(section){section.focus({preventScroll:true});section.scrollIntoView({block:'start',behavior:'auto'});posicionado.current=chave;}});
            return()=>cancelAnimationFrame(frame);
        }
        // O Router pode restaurar o scroll depois do primeiro paint. Aguardar o
        // Financeiro pronto e corrigir apenas essa janela curta, sem disputar com o usuário.
        let interrompido=false;
        const frames:number[]=[],timers:number[]=[];
        const interacoes=['pointerdown','keydown','wheel','touchstart'] as const;
        const parar=()=>{interrompido=true;frames.forEach(cancelAnimationFrame);timers.forEach(clearTimeout);interacoes.forEach(e=>window.removeEventListener(e,parar));};
        interacoes.forEach(e=>window.addEventListener(e,parar,{passive:true}));
        const posicionar=()=>{
            if(interrompido)return;
            const section=document.getElementById('financeiro');
            if(!section)return;
            const margem=parseFloat(getComputedStyle(section).scrollMarginTop)||0;
            if(document.activeElement!==section||Math.abs(section.getBoundingClientRect().top-margem)>2){
                section.focus({preventScroll:true});section.scrollIntoView({block:'start',behavior:'auto'});
            }
            posicionado.current=chave;
        };
        frames.push(requestAnimationFrame(()=>frames.push(requestAnimationFrame(()=>{
            posicionar();
            timers.push(window.setTimeout(posicionar,180));
            timers.push(window.setTimeout(()=>{posicionar();parar();},500));
        }))));
        return parar;
    },[cid,vid,data,destino,financeiroKey,financeiroPronto]);
    const executar = async (body: Record<string, unknown>):Promise<{ok:boolean;data?:unknown}> => { if (!v || operacaoEmCurso.current)
        return {ok:false}; operacaoEmCurso.current=true; setBusy(true); setError(''); setConferido(null); try {
        const r = await adminFetch(`/api/admin/contratos/versoes/${v.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const b = await r.json();
        if (!b.ok)
            throw Error(b.erro);
        await load(cid);
        return {ok:true,data:b.data};
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Falha na operação.');
        return {ok:false};
    }
    finally {
        operacaoEmCurso.current=false; setBusy(false);
    } };
    const action = async (body: Record<string, unknown>):Promise<boolean> => (await executar(body)).ok;
    async function revalidar(){
        if(!v)return;
        const chave=chaveConferencia(cid,v.id,v.revisao),inicio=geracaoAtual.current;
        const r=await executar({acao:'revalidar_destino',revisao:v.revisao});
        // Só a resposta explícita da revalidação confirma; resposta de outro contexto ou de antes de uma edição é descartada.
        if(r.ok&&(r.data as {revalidado?:boolean}|undefined)?.revalidado===true&&chaveAtual.current===chave&&geracaoAtual.current===inicio)setConferido({chave,em:new Date()});
    }
    async function cancelarContratacao(){
        if(!v||!data)return;
        const motivo=window.prompt('Por que esta contratação será cancelada? O histórico e os documentos serão preservados.');
        if(!motivo||motivo.trim().length<3)return;
        if(!window.confirm(`Cancelar a contratação de ${v.snapshot.contratante.nomeCompleto}? A festa sairá das listas ativas.`))return;
        if(await action({acao:'cancelar_contratacao',motivo:motivo.trim()})){
            const response=await adminFetch('/api/admin/contratos/painel');
            const body=await response.json();if(body.ok)setLista(body.data);
            setCid('');setData(null);
            router.replace(urlDaSelecao(pathname, params, ''), { scroll: false });
        }
    }
    async function cancelarRevisao(){
        if(!v)return;
        const motivo=window.prompt('Por que esta alteração será descartada? O contrato assinado, o histórico e os documentos serão preservados.');
        if(!motivo||motivo.trim().length<3)return;
        if(!window.confirm(`Descartar a alteração (V${v.numero_versao})? As mudanças preparadas nela serão descartadas.`))return;
        await action({acao:'cancelar_revisao',revisao:v.revisao,motivo:motivo.trim()});
    }
    async function criarRevisao(){
        if(!v||!pred)return;
        const intencao=JSON.stringify({versao:v.id,tipo,motivo:motivo.trim()});
        if(pedidoRevisao.current?.intencao!==intencao)pedidoRevisao.current={intencao,chave:crypto.randomUUID()};
        if(await action(pred.podeSubstituir?{acao:'substituir_preparacao',motivo:motivo.trim(),chaveCriacao:pedidoRevisao.current.chave}:{acao:'nova_versao',tipo,motivo:motivo.trim(),chaveCriacao:pedidoRevisao.current.chave})){pedidoRevisao.current=null;setMotivo('');setAlterarAberto(false);setEditando(true);window.history.replaceState(window.history.state,'','#alteracoes');setDestino('#alteracoes');}
    }
    async function assinar(){
        if(!v?.documento_revisado_id)return;
        if (!window.confirm(`APROVAR E ASSINAR PELA KIDMAIS: versão ${v.numero_versao}, revisão ${v.revisao}, PDF ${v.documento_revisado_id}. O conteúdo será congelado.`))
            return; setError(''); try {
            // Renovação anunciada: a reautenticação troca a sessão; sem o anúncio a página seria descartada antes de assinar.
            const auth = await reautenticarSessao(senha);
            setSenha('');
            if (!auth.ok)
                throw Error(auth.erro);
            const id = key || crypto.randomUUID();
            setKey(id);
            await action({ acao: 'assinar', revisao: v.revisao, documentoId: v.documento_revisado_id, chaveIdempotencia: id });
        }
        catch (e) {
            setError(String(e));
        }
    }
    const abas = [{ id: 'geral', rotulo: 'Resumo', hash: '#visao-geral' }, { id: 'documentos', rotulo: 'Documentos', hash: '#documentacao' }, { id: 'financeiro', rotulo: 'Pagamentos', hash: '#financeiro' }, { id: 'historico', rotulo: 'Histórico', hash: '#historico' }];
    const aba = destino === '#documentacao' ? 'documentos' : destino === '#financeiro' ? 'financeiro' : destino === '#historico' ? 'historico' : 'geral';
    function abrirAba(hash: string) {
        // A troca de aba mantém o foco no controle. Links externos continuam usando o scroll de deep link.
        posicionado.current = cid + ':' + vid + hash;
        window.history.replaceState(window.history.state, '', hash);
        setDestino(hash);
    }
    function fecharMenu() {
        setMenuAberto(false);
        if (destino === '#cancelar-contrato') { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search); setDestino(''); }
    }
    function abrirVersao(id: string) { const q = new URLSearchParams(params.toString()); q.set('versaoId', id); router.push(`${pathname}?${q.toString()}#historico`, { scroll: false }); }
    function fecharConsulta() { const q = new URLSearchParams(params.toString()); q.delete('versaoId'); router.push(`${pathname}?${q.toString()}`, { scroll: false }); }
    const docUrl = (id: string) => `/api/admin/contratos/documentos/${id}`;
    // Contrato aberto pelo link mas oculto pelos filtros da lista: aparece no seletor, identificado como tal.
    const foraDaLista = opcaoForaDaLista(lista, cid, data);
    const opcaoUrl = cid && !lista.some(c => c.id === cid) ? (foraDaLista ? `${contratoApresentacao(foraDaLista)} — fora dos filtros da lista` : 'Carregando contrato…') : null;
    const selecaoImportada = urlImportacao ? `${PREFIXO_IMPORTADO}${urlImportacao}` : '';
    const opcaoImportada = urlImportacao && !lista.some(c => c.origem === 'IMPORTACAO' && c.id === urlImportacao) ? 'Contrato importado — fora dos filtros da lista' : null;
    // Faixa: preparação aberta sobre o alvo (alteração de contrato assinado ou contratação inicial).
    const faixa = !!v && EDICAO_ABERTA.includes(v.estado_edicao ?? '') && data?.contrato.status !== 'CANCELADO';
    const alteracao = faixa && temVigente && ref?.id !== v?.id;
    const origem = data?.versoes.find(x => x.id === v?.origem_versao_id);
    const analise = v && origem ? analisarRevisao(origem.snapshot,v.snapshot) : null;
    const pdfDaRevisao = v ? docs.find(d => d.categoria === 'CONTRATO' && d.revisao === v.revisao) ?? null : null;
    const reserva = situacaoReserva(pred?.revisaoOperacional ?? null);
    // Com o editor aberto o rascunho pode ter mudado sem aviso ao pai: nenhuma confirmação vale.
    const conferenciaValida = conferido && !editando && conferido.chave === chaveAgenda ? conferido : null;
    const snap = ref?.snapshot;
    const titulo = snap ? tituloFesta(snap) : null;
    const etapa = etapaAtual(v, temVigente, data?.tela?.estadoFesta ?? null);
    const proximoHistorico = data?.contrato.status === 'CANCELADO' ? 'Contratação cancelada. Consulte os registros preservados.' : data?.origemHistorica && ref?.estado_edicao === 'CONCLUIDA' ? (data.origemHistorica.caminhoFinanceiro === 'CONFERIR_HISTORICO' ? 'Conferir os pagamentos do contrato histórico.' : data.origemHistorica.caminhoFinanceiro === 'PLANO_NA_VERSAO_VIGENTE' ? 'Registrar os pagamentos no Financeiro: criar o plano na versão vigente e lançar os recebimentos com a data real.' : data.origemHistorica.caminhoFinanceiro === 'AGUARDAR_REVISAO' ? 'Concluir ou cancelar a revisão aberta antes de registrar os pagamentos.' : 'Contrato histórico conferido. Mudanças seguem uma nova revisão do contrato.') : null;
    const deltaValor = alteracao && v && ref ? v.snapshot.comercial.valorFinalContrato - ref.snapshot.comercial.valorFinalContrato : 0;
    const saida = data ? saidaPagamentos(data.financeiro.length, data.origemHistorica?.caminhoFinanceiro) : null;
    // Contrato aberto (carregado pela API do tenant) informa o drawer. É só dica: o servidor revalida no tenant comprovado.
    return <main className={styles.page}>{cid&&data&&<ContextoKidmais tela="contrato" entidadeId={cid}/>}{retorno&&<Link href={retorno}>Voltar à festa</Link>}<div className={styles.tituloContratos}><h1>Contratos</h1><Link className={styles.importarContrato} href="/admin/contratos/importar">Importar contrato antigo</Link></div>{error && <p role="alert" className={styles.erroFixo}>{error}</p>}{cid && !data && !error && <p role="status">Carregando contrato…</p>}
 <details><summary>Filtros da lista</summary><label><input type="checkbox" checked={mostrarCancelados} onChange={e=>setMostrarCancelados(e.target.checked)}/> Incluir contratos cancelados</label> <label><input type="checkbox" checked={mostrarImportados} onChange={e=>setMostrarImportados(e.target.checked)}/> Incluir contratos importados</label></details>
 <label>Contrato <select aria-label="Contrato" value={selecaoImportada || cid} onChange={(e) => { router.push(urlDaSelecao(pathname, params, e.target.value), { scroll: false }); }}><option value="">Selecione</option>{lista.map(c => <option key={valorDaSelecao(c)} value={valorDaSelecao(c)}>{contratoApresentacao(c)}</option>)}{opcaoUrl && <option value={cid}>{opcaoUrl}</option>}{opcaoImportada && <option value={selecaoImportada}>{opcaoImportada}</option>}</select></label>
 {urlImportacao && <ContratoImportado key={urlImportacao} importacaoId={urlImportacao} />}
 {data && ref && snap && titulo && pred && <><header className={styles.overview}><div className={styles.hero}><div>
 <div className={styles.chips}><span className={styles.badge}>{rotuloContrato(data.contrato.status)}</span>{data.origemHistorica && <a className={styles.chip} href="#historico" onClick={e=>{e.preventDefault();abrirAba('#historico');}}>Assinado em papel</a>}{referencia?.diagnostico && <span className={styles.chipAlerta}>Conferir</span>}</div>
 <h2>{titulo.titulo}{titulo.idade ? ` · ${titulo.idade}` : ''}</h2>
 <p>{[titulo.aniversariante ? snap.contratante.nomeCompleto : null, dataPorExtenso(snap.evento.data), faixaHorario(snap.evento.horarioInicio, snap.evento.horarioFim), titulo.tema ? `Tema ${titulo.tema}` : null].filter(Boolean).join(' · ')}</p></div>
 <div className={styles.total}><span>{temVigente ? 'Valor do contrato' : 'Valor proposto'}</span><strong>{formatarMoeda(snap.comercial.valorFinalContrato)}</strong>
 <div className={styles.actions}>{pred.podeRevisar && <button type="button" disabled={busy} aria-expanded={alterarAberto} onClick={()=>setAlterarAberto(!alterarAberto)}>Alterar contrato</button>}<button type="button" aria-expanded={menuVisivel} aria-controls="menu-mais" onClick={()=>menuVisivel?fecharMenu():setMenuAberto(true)}>Mais</button></div></div></div>
 {referencia?.diagnostico && <p className={styles.notice}>Contrato sem versão ativa ou assinada — conferir.</p>}
 {menuVisivel && <div id="menu-mais" className={styles.menuMais} role="group" aria-label="Mais ações">
 {data.origemHistorica?.documento && data.origemHistorica.podeVerOriginal && <><a href={`/api/admin/contratos/importados/${data.origemHistorica.importacaoId}/original`} target="_blank" rel="noreferrer">Ver documento original</a><a href={`/api/admin/contratos/importados/${data.origemHistorica.importacaoId}/original?baixar=1`}>Baixar original</a></>}
 {ref.documento_revisado_id && <a target="_blank" rel="noreferrer" href={`/admin/contratos/imprimir?contratoId=${cid}&versaoId=${ref.id}`}>Imprimir contrato completo — V{ref.numero_versao}</a>}
 <p className={styles.discreto}>Referência interna: {cid.slice(0, 8)}</p>
 <div id="cancelar-contrato" tabIndex={-1} className={`${styles.actions} ${styles.anchor}`}>{pred.cancelamento==='FESTA'&&data.festaId ? <CancelarContratoFesta key={data.festaId} festaId={data.festaId} nome={snap.contratante.nomeCompleto} onCancelado={async()=>{await load(cid);setMostrarCancelados(true);}}/> : pred.cancelamento==='CONTRATACAO_INICIAL' ? <button type="button" className={styles.perigo} disabled={busy} onClick={cancelarContratacao}>Cancelar contratação</button> : <p className={styles.discreto}>{data.contrato.status==='CANCELADO'?'Contratação cancelada.':'Cancelamento indisponível para este contrato.'}</p>}</div>
 </div>}
 <ol className={styles.etapas} aria-label="Etapas do contrato">{ETAPAS.map((nome, i) => (i < 5 || etapa.mostrarFesta) && <li key={nome} data-situacao={i === etapa.atual ? 'atual' : i < etapa.concluidas ? 'feita' : 'pendente'} aria-current={i === etapa.atual ? 'step' : undefined}>{nome}</li>)}</ol>
 </header>
 {pred.podeRevisar && (alterarAberto || (destino === '#alteracoes' && !faixa)) && <section id={faixa ? undefined : 'alteracoes'} tabIndex={-1} aria-label="Alterar contrato" className={`${styles.card} ${styles.anchor}`}><h3>Criar revisão / retificação</h3><p>Prepare alterações de convidados, pacote, adicionais, buffet, data e condição comercial em uma nova versão. O contrato assinado continua valendo até as novas assinaturas.</p><select aria-label="Tipo da revisão" value={tipo} onChange={e => setTipo(e.target.value)}><option value="NOVA_VERSAO">Nova versão</option><option value="RETIFICACAO">Retificação documental</option><option value="ADITIVO" disabled>Aditivo — template específico pendente</option></select><label>Motivo <input value={motivo} maxLength={500} onChange={e => setMotivo(e.target.value)}/></label><button type="button" disabled={busy || motivo.trim().length < 3} onClick={criarRevisao}>Criar revisão / retificação</button></section>}
 {faixa && v && <section id="alteracoes" tabIndex={-1} aria-label={alteracao ? 'Alteração em andamento' : 'Contrato em preparação'} className={`${styles.faixa} ${styles.anchor} ${destino === '#alteracoes' ? styles.deepLinkAnchor : ''}`}>
 <h2>{alteracao ? 'Alteração em andamento' : 'Contrato em preparação'} · {rotuloVersao(v)}</h2>
 {alteracao && <p>{(analise?.campos ?? v.alteracoes?.campos ?? []).filter(d => campoNoResumo(d.campo)).slice(0, 4).map(d => `${rotuloCampo(d.campo)}: ${valorDiferenca(d.antes, d.campo)} → ${valorDiferenca(d.depois, d.campo)}`).join(' · ') || 'Nenhuma diferença registrada ainda.'}{deltaValor !== 0 && <strong> · Novo valor {formatarMoeda(v.snapshot.comercial.valorFinalContrato)} ({deltaValor > 0 ? '+' : '−'}{formatarMoeda(Math.abs(deltaValor))})</strong>}</p>}
 <p className={styles.discreto} data-testid="aviso-preparacao">{alteracao ? `O contrato assinado (V${ref.numero_versao}) continua valendo. As mudanças só entram em vigor depois das assinaturas da nova versão.` : 'A contratação passa a valer depois das assinaturas.'}</p>
 {!configuracaoModeloOficial(v.snapshot.evento.pacote.codigo) && <p className={styles.notice}>Este pacote ainda não possui modelo oficial de contrato cadastrado. A preparação pode ser salva; geração do PDF e assinatura dependem da aprovação do modelo correspondente.</p>}
 {reserva && pred.revisaoOperacional && <p className={reserva.alerta ? styles.alertaAgenda : styles.discreto} data-reserva={reserva.tipo}>{reserva.texto}{pred.revisaoOperacional.slot_alterado ? ` · nova data: ${dataPorExtenso(pred.revisaoOperacional.data_evento)}, ${faixaHorario(pred.revisaoOperacional.horario_inicio, pred.revisaoOperacional.horario_fim)}` : ''}{data.tela?.salaoAlteracao ? ` · salão na alteração: ${data.tela.salaoAlteracao}` : ''}</p>}
 {conferenciaValida && <p role="status" className={styles.discreto}>Destino conferido às {conferenciaValida.em.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.</p>}
 <p className={styles.discreto}>Próximo passo: {proximoPasso(v, docs)}</p>
 <div className={styles.actions}>
 {pred.podeGerarPdf && !pdfDaRevisao && <button type="button" data-km-primario disabled={busy} onClick={() => action({ acao: 'gerar_pdf', revisao: v.revisao })}>Preparar documento</button>}
 {pred.podeRevisarPdf && !v.documento_revisado_id && pdfDaRevisao && <><a className={styles.documentButton} href={docUrl(pdfDaRevisao.id)} target="_blank" rel="noreferrer">Ver PDF</a><button type="button" data-km-primario disabled={busy} onClick={() => { if (window.confirm(`Confirmo que revisei o PDF ${pdfDaRevisao.id} da versão ${v.numero_versao}, revisão ${v.revisao}, e que seus dados refletem as condições oficiais aprovadas.`)) action({ acao: 'revisar', revisao: v.revisao, documentoId: pdfDaRevisao.id }); }}>Confirmar revisão do PDF</button></>}
 {pred.podeAssinar && <><label>Confirme sua senha <input type="password" value={senha} autoComplete="current-password" onChange={e => setSenha(e.target.value)}/></label><button type="button" data-km-primario disabled={busy || !senha} onClick={assinar}>Aprovar e assinar pela Kidmais</button></>}
 {pred.podeLiberar && <button type="button" data-km-primario disabled={busy} onClick={() => action({ acao: 'liberar', revisao: v.revisao })}>Liberar para o cliente</button>}
 {pred.podeAbrirPublico && <a className={styles.documentButton} href={`/contrato/${cid}`} target="_blank" rel="noreferrer">Abrir página do cliente ↗</a>}
 {pred.podeEditar && <button type="button" disabled={busy} onClick={() => { invalidarConferencia(); setEditando(!editando); }}>{editando ? 'Fechar edição' : 'Editar dados desta revisão'}</button>}
 {pred.podeRevalidar && <button type="button" disabled={busy} onClick={() => void revalidar()}>Revalidar destino</button>}
 {pred.podeRecusarComercial && <button type="button" disabled={busy} onClick={() => { const m = window.prompt('Motivo da recusa comercial. A reserva e a preparação serão mantidas.'); if (m && m.trim().length >= 3) action({ acao: 'recusar_comercial', revisao: v.revisao, motivo: m, chaveDecisao: crypto.randomUUID() }); }}>Recusar condição comercial</button>}
 {pred.podeCancelarRevisao && <button type="button" disabled={busy} onClick={() => void cancelarRevisao()}>{alteracao ? 'Descartar alteração' : 'Cancelar revisão'}</button>}
 </div>
 {pred.podeSubstituir && <details><summary>Criar nova revisão</summary><p>Esta versão e a assinatura da Kidmais serão preservadas. O acesso anterior será encerrado. A nova revisão exigirá novo PDF e nova assinatura da Kidmais antes da liberação ao cliente.</p><label>Motivo <input value={motivo} maxLength={500} onChange={e => setMotivo(e.target.value)}/></label><button type="button" disabled={busy || motivo.trim().length < 3} onClick={criarRevisao}>Criar nova revisão</button></details>}
 {editando && <EdicaoFesta key={vid} versaoId={vid} revisao={v.revisao} serverError={error} onSave={action} onClose={()=>{invalidarConferencia();setEditando(false);}}/>}
 <details><summary>Ver diferenças</summary>{origem&&<p>Versão anterior preservada: V{origem.numero_versao} → nova versão: V{v.numero_versao} · {rotuloVersao(v)} · motivo: {v.motivo_nova_versao} · criada em {instante(v.criado_em)}</p>}{analise&&<><p>{analise.natureza==='MATERIAL'?'Alteração material':analise.natureza==='DOCUMENTAL'?'Alteração documental / não material':'Nenhuma alteração de conteúdo'}. Esta revisão exige nova assinatura da Kidmais e do cliente para entrar em vigor, inclusive em correções documentais.</p>{analise.alteraAgenda&&<p>A data e o horário vigentes continuam ocupados até a formalização desta revisão. O destino será revalidado; conflitos impedem a troca.</p>}{analise.impactoFinanceiro&&<p>Há impacto financeiro. Recebimentos anteriores são preservados. Após formalização, confira as pendências e ajuste as obrigações futuras pelo fluxo financeiro existente; não há quitação ou estorno automático.</p>}</>}{(analise?.campos ?? v.alteracoes?.campos)?.length ? <div className={styles.tableWrap}><table><thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead><tbody>{(analise?.campos ?? v.alteracoes?.campos ?? []).map(d=><tr key={d.campo}><td>{rotuloCampo(d.campo)}</td><td>{valorDiferenca(d.antes,d.campo)}</td><td>{valorDiferenca(d.depois,d.campo)}</td></tr>)}</tbody></table></div>:<p>Nenhuma diferença registrada nesta elaboração.</p>}</details>
 </section>}
 {!faixa && proximoHistorico && <div className={styles.next}><div><strong>Próximo passo</strong><p>{proximoHistorico}</p></div><a href="#financeiro" onClick={e=>{e.preventDefault();abrirAba('#financeiro');}}>Ver pagamentos</a></div>}
 {versaoDesconhecida && <p className={styles.notice} role="status">Versão não encontrada neste contrato. Mostrando o contrato atual.</p>}
 {consultada && <section className={styles.leitura} aria-label={`Consulta da versão V${consultada.numero_versao}`} data-testid="consulta-versao">
 <div className={styles.hero}><h2>Consultando V{consultada.numero_versao} · {rotuloVersao(consultada)}</h2><button type="button" onClick={fecharConsulta}>Fechar consulta</button></div>
 <p>{dataPorExtenso(consultada.snapshot.evento.data)} · {faixaHorario(consultada.snapshot.evento.horarioInicio, consultada.snapshot.evento.horarioFim)} · {consultada.snapshot.evento.pacote.nome} · {consultada.snapshot.evento.convidados} convidados · {formatarMoeda(consultada.snapshot.comercial.valorFinalContrato)}</p>
 {consultada.motivo_nova_versao && <p className={styles.discreto}>Motivo: {consultada.motivo_nova_versao}</p>}
 <ListaDocumentos docs={data.documentos.filter(d => d.contrato_versao_id === consultada.id)} vazio="Nenhum documento gerado nesta versão." docUrl={docUrl} />
 <Comprovantes v={consultada} assinaturas={data.assinaturas.filter(s => s.contrato_versao_id === consultada.id)} docUrl={docUrl} />
 <DiferencasDaVersao versao={consultada} origem={data.versoes.find(x => x.id === consultada.origem_versao_id) ?? null} />
 </section>}
 <nav className={styles.tabs} role="tablist" aria-label="Conteúdo do contrato">{abas.map((item, indice) => <button key={item.id} type="button" role="tab" id={`aba-${item.id}`} aria-controls={`painel-${item.id}`} aria-selected={aba === item.id} tabIndex={aba === item.id ? 0 : -1} onClick={() => abrirAba(item.hash)} onKeyDown={e => { const alvo = e.key === 'ArrowRight' ? (indice + 1) % abas.length : e.key === 'ArrowLeft' ? (indice + abas.length - 1) % abas.length : e.key === 'Home' ? 0 : e.key === 'End' ? abas.length - 1 : null; if (alvo !== null) { e.preventDefault(); abrirAba(abas[alvo].hash); document.getElementById(`aba-${abas[alvo].id}`)?.focus(); } }}>{item.rotulo}</button>)}</nav>
 <section id="painel-geral" role="tabpanel" aria-labelledby="aba-geral" className={styles.panel} hidden={aba !== 'geral'}>
 <h2>A festa</h2><dl className={styles.dados}>
 {titulo.aniversariante && <div><dt>Aniversariante</dt><dd>{titulo.aniversariante}{titulo.idade ? ` · faz ${titulo.idade} na festa` : ''}</dd></div>}
 {titulo.tema && <div><dt>Tema</dt><dd>{titulo.tema}</dd></div>}
 <div><dt>Data e horário</dt><dd>{dataPorExtenso(snap.evento.data)} · {faixaHorario(snap.evento.horarioInicio, snap.evento.horarioFim)}</dd></div>
 {data.tela?.salao && <div><dt>Salão</dt><dd>{data.tela.salao}</dd></div>}
 <div><dt>Pacote</dt><dd>{snap.evento.pacote.nome} · {snap.evento.convidados} convidados</dd></div></dl>
 <h2>Contratante e pagamento</h2><dl className={styles.dados}>
 <div><dt>Contratante</dt><dd>{snap.contratante.nomeCompleto}{snap.contratante.email ? ` · ${snap.contratante.email}` : ''}</dd></div>
 <div><dt>{temVigente ? 'Valor do contrato' : 'Valor proposto'}</dt><dd><strong>{formatarMoeda(snap.comercial.valorFinalContrato)}</strong> · {formatarFormaPagamento(snap.comercial.formaPagamentoPretendida)}</dd></div>
 {snap.comercial.valorBaseComercial != null && <div><dt>Base</dt><dd>{formatarMoeda(snap.comercial.valorBaseComercial)} · desconto: {snap.comercial.descontoFormaPagamentoPercentual}%</dd></div>}
 {snap.comercial.condicaoPagamento && <><div><dt>Condição proposta</dt><dd>{formatarCondicaoPix(snap.comercial.condicaoPagamento.pretendida)}</dd></div><div><dt>Condição aprovada</dt><dd>{formatarCondicaoPix(snap.comercial.condicaoPagamento.aprovada)} · revisão {snap.comercial.condicaoPagamento.revisaoStatus}</dd></div></>}
 </dl>
 </section>
 <section id="painel-documentos" role="tabpanel" aria-labelledby="aba-documentos" className={styles.panel} hidden={aba !== 'documentos'}>
 <h2 id="documentacao">Documentos</h2>
 {v && !configuracaoModeloOficial(v.snapshot.evento.pacote.codigo) && <p className={styles.notice}>Este pacote ainda não possui modelo oficial de contrato cadastrado. A preparação pode ser salva; geração do PDF e assinatura dependem da aprovação do modelo correspondente.</p>}
 {v?.estado_edicao === 'EM_ELABORACAO' && <details className={styles.documentDetails} open><summary>Observações do documento</summary><label>Observações exclusivamente documentais<textarea value={note} maxLength={2000} onChange={e => { setNote(e.target.value); invalidarConferencia(); }} style={{ width: '100%', minHeight: 90 }}/></label><p>Não use observações para mudar valores, datas, partes ou obrigações operacionais.</p><button type="button" disabled={busy} onClick={() => action({ acao: 'salvar', revisao: v.revisao, observacoesDocumentais: note })}>Salvar revisão</button> <button type="button" disabled={busy} onClick={() => action({ acao: 'gerar_pdf', revisao: v.revisao })}>Gerar PDF da revisão</button></details>}
 {faixa && v && v.id !== ref.id && <><h3>Da alteração · {rotuloVersao(v)}</h3><ListaDocumentos docs={docs} vazio="Nenhum documento gerado nesta alteração." docUrl={docUrl} /><Comprovantes v={v} assinaturas={signatures} docUrl={docUrl} /></>}
 <h3>{temVigente ? `Contrato que vale hoje · V${ref.numero_versao}` : `Contrato em preparação · V${ref.numero_versao}`}</h3>
 <ListaDocumentos docs={data.documentos.filter(d => d.contrato_versao_id === ref.id)} vazio={ref.estado_edicao ? 'Nenhum documento gerado.' : 'Documento anterior disponível no arquivo preservado. Ainda não importado para impressão nesta tela.'} docUrl={docUrl} />
 <Comprovantes v={ref} assinaturas={data.assinaturas.filter(s => s.contrato_versao_id === ref.id)} docUrl={docUrl} />
 <div className={styles.documentList}><article className={styles.documentRow} aria-label="Resumo da contratação"><div><h3>Resumo da contratação</h3><p>Informações comerciais e operacionais</p></div><div className={styles.documentActions}><a className={styles.documentButton} target="_blank" rel="noreferrer" href={`/admin/contratos/resumo?contratoId=${cid}&versaoId=${ref.id}`}>Visualizar resumo</a><a className={styles.documentButton} target="_blank" rel="noreferrer" href={`/admin/contratos/resumo?contratoId=${cid}&versaoId=${ref.id}&baixar=1`}>Baixar PDF do resumo</a><a className={styles.documentButton} target="_blank" rel="noreferrer" href={`/admin/contratos/resumo?contratoId=${cid}&versaoId=${ref.id}&imprimir=1`}>Imprimir resumo</a></div></article></div>
 {ref.documento_revisado_id && <a className={styles.documentButton} target="_blank" rel="noreferrer" href={`/admin/contratos/imprimir?contratoId=${cid}&versaoId=${ref.id}`}>Imprimir contrato completo — V{ref.numero_versao}</a>}
 </section>
 <section id="painel-financeiro" role="tabpanel" aria-labelledby="aba-financeiro" className={styles.panel} hidden={aba !== 'financeiro'}><section id="financeiro" tabIndex={-1} aria-label="Pagamentos" className={`${styles.anchor} ${destino==='#financeiro'?styles.financialAnchor:''}`}>{saida==='CARREGAR'?<PagamentosResumo key={financeiroKey} contratoId={cid} temVigente={temVigente} onReady={financeiroCarregado}/>:saida==='MULTIPLOS'?<p className={styles.notice} role="status">Pagamentos precisam de conferência: há mais de uma obrigação registrada.</p>:saida==='AGUARDAR_REVISAO'?<p role="status">Há uma revisão do contrato em andamento. Conclua ou cancele a revisão para registrar os pagamentos.</p>:saida==='CONFERIR_HISTORICO'&&data.origemHistorica?<IntegracaoContrato key={`fin:${data.origemHistorica.importacaoId}`} importacaoId={data.origemHistorica.importacaoId} modoInicial="financeiro"/>:<CriarPlanoFinanceiro key={financeiroKey} contexto={contextoCriacao(data)} onCreated={async()=>{await load(cid);window.location.hash='financeiro';}}/>}</section></section>
 <section id="painel-historico" role="tabpanel" aria-labelledby="aba-historico" className={styles.panel} hidden={aba !== 'historico'}><h2 id="historico">Histórico</h2>
 <div className={styles.chips} role="group" aria-label="Filtrar histórico">{([['TUDO','Tudo'],['VERSOES','Versões do contrato'],['ASSINATURAS','Assinaturas']] as const).map(([id, rotulo]) => <button key={id} type="button" aria-pressed={filtroHistorico === id} onClick={() => setFiltroHistorico(id)}>{rotulo}</button>)}</div>
 {data.origemHistorica && filtroHistorico !== 'ASSINATURAS' && <OrigemHistoricaContrato origem={data.origemHistorica} />}
 <ol className={styles.linhaTempo}>{[...(filtroHistorico === 'ASSINATURAS' ? [] : data.versoes.map(x => ({ em: x.criado_em, id: 'v' + x.id, conteudo: <><strong>V{x.numero_versao} · {rotuloVersao(x)}</strong>{x.id === ref.id ? ' · vale hoje' : x.id === vid && faixa ? ' · em andamento' : ''}<span className={styles.discreto}> {instante(x.criado_em)}{x.motivo_nova_versao ? ` · motivo: ${x.motivo_nova_versao}` : ''}</span>{x.id !== ref.id && x.id !== vid && <button type="button" onClick={() => abrirVersao(x.id)}>Ver esta versão</button>}</> }))),
 ...(filtroHistorico === 'VERSOES' ? [] : data.assinaturas.map(s => ({ em: s.assinado_em, id: 's' + s.id, conteudo: <><strong>{s.parte === 'CLIENTE' ? 'Cliente' : s.parte === 'KIDMAIS' ? 'Buffet' : s.parte} assinou V{data.versoes.find(x => x.id === s.contrato_versao_id)?.numero_versao}</strong><span className={styles.discreto}> {s.identidade_snapshot.nome} · {instante(s.assinado_em)}</span> <a className={styles.documentButton} target="_blank" rel="noreferrer" href={docUrl(s.comprovante_documento_id)}>Ver comprovante</a></> })))]
 .sort((a, b) => b.em.localeCompare(a.em)).map(item => <li key={item.id}>{item.conteudo}</li>)}</ol></section>
 </>}
 </main>;
}
function ListaDocumentos({ docs, vazio, docUrl }: { docs: Doc[]; vazio: string; docUrl: (id: string) => string }) {
    if (!docs.length) return <p className={styles.discreto}>{vazio}</p>;
    return <div className={styles.documentList}>{docs.map(d => <article key={d.id} className={styles.documentRow}><div><h3>{tituloDocumento(d.categoria)}</h3><p>Revisão {d.revisao}</p></div><div className={styles.documentActions}><a className={styles.documentButton} href={docUrl(d.id)} target="_blank" rel="noreferrer">Visualizar</a><a className={styles.documentButton} href={`${docUrl(d.id)}?baixar=1`}>Baixar PDF</a><a className={styles.documentButton} href={docUrl(d.id)} target="_blank" rel="noreferrer">Abrir para imprimir</a></div></article>)}</div>;
}
function Comprovantes({ v, assinaturas, docUrl }: { v: Versao; assinaturas: Painel['assinaturas']; docUrl: (id: string) => string }) {
    return <details className={styles.documentDetails}><summary>Assinaturas e comprovantes ({assinaturas.length})</summary>{assinaturas.length === 0 && <p>{versaoAssinadaEmPapel(v) ? TEXTO_ASSINADO_EM_PAPEL : 'Nenhuma assinatura registrada nesta versão.'}</p>}{assinaturas.map(s => <p key={s.id}>{s.parte}: {s.identidade_snapshot.nome} · {instante(s.assinado_em)} · <a className={styles.documentButton} target="_blank" rel="noreferrer" href={docUrl(s.comprovante_documento_id)}>Ver comprovante</a></p>)}</details>;
}
/** Diferenças de uma versão consultada em relação à própria origem — só leitura, sem nenhum controle. */
function DiferencasDaVersao({ versao, origem }: { versao: Versao; origem: Versao | null }) {
    const campos = (origem ? analisarRevisao(origem.snapshot, versao.snapshot)?.campos : null) ?? versao.alteracoes?.campos ?? [];
    if (!origem && !campos.length) return <p className={styles.discreto}>Versão original: sem versão anterior para comparar.</p>;
    return <details className={styles.documentDetails}><summary>Diferenças em relação à V{origem?.numero_versao ?? 'anterior'}</summary>{campos.length ? <div className={styles.tableWrap}><table><thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead><tbody>{campos.map(d => <tr key={d.campo}><td>{rotuloCampo(d.campo)}</td><td>{valorDiferenca(d.antes, d.campo)}</td><td>{valorDiferenca(d.depois, d.campo)}</td></tr>)}</tbody></table></div> : <p>Nenhuma diferença registrada.</p>}</details>;
}
function valorDiferenca(value:unknown,campo=''):string {if(typeof value==='number' && /\.valor[A-Z]/.test(campo))return formatarMoeda(value);if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value))return value.split('-').reverse().join('/');if(value==null || value==='')return 'Não informado';if(Array.isArray(value))return value.length?value.map(x=>typeof x==='object'&&x?'nome' in x?`${x.nome} (${x.quantidade})`:JSON.stringify(x):String(x)).join(', '):'Nenhum';if(typeof value==='object')return Object.values(value).map(x=>valorDiferenca(x)).join(' · ');return String(value);}
/** Resumo da faixa: só o que a pessoa reconhece; códigos e ids ficam em "Ver diferenças"; o valor aparece à parte. */
function campoNoResumo(campo:string){return campo!=='documental.observacoes'&&campo!=='comercial.valorFinalContrato'&&!/(^|\.)(codigo|id|[a-zA-Z]+Id)$/.test(campo);}
function rotuloCampo(campo:string):string {const labels:Record<string,string>={'evento.pacote.nome':'Pacote','evento.convidados':'Convidados','evento.convidadosFaturados':'Convidados faturados','comercial.valorPacoteBase':'Valor base do pacote','comercial.valorPacoteAplicado':'Valor aplicado ao pacote','comercial.valorBaseComercial':'Base comercial','evento.data':'Data','evento.horarioInicio':'Início','evento.horarioFim':'Fim','comercial.valorFinalContrato':'Valor contratual','comercial.valorTabela':'Valor de tabela','comercial.formaPagamentoPretendida':'Forma de pagamento','contratacao.adicionais':'Adicionais','documental.observacoes':'Observações documentais'};return labels[campo] ?? campo.replaceAll('.', ' / ').replace(/([a-z])([A-Z])/g,'$1 $2');}
