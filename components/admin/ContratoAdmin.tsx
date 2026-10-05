'use client';
import { analisarRevisao } from '@/lib/contratos/services/alteracoes';
import { TEXTO_ASSINADO_EM_PAPEL, versaoAssinadaEmPapel } from '@/lib/contratos/assinatura-papel';
import { configuracaoModeloOficial } from '../../lib/contratos/documento/oficial/configuracao';
import { useCallback, useEffect, useState, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ContratoSnapshotV1 } from '@/lib/contratos/repositories/models';
import { adminFetch } from '@/lib/http/admin-fetch';
import { formatarFormaPagamento, formatarMoeda, formatarCondicaoPix } from '@/lib/contratos/documento/formatters';
import styles from './contratos-ux.module.css';
import Link from 'next/link';
import { retornoFestaSeguro } from '@/lib/festas/apresentacao';
import EdicaoFesta from './EdicaoFesta';
import { ContextoKidmais } from './inteligencia/PerguntarKidmais';
import FinanceiroContrato from './FinanceiroContrato';
import CriarPlanoFinanceiro from './CriarPlanoFinanceiro';
import { contextoCriacao } from './criacao-financeira';
import { contratoApresentacao, type ContextoContrato } from './financeiro-apresentacao';
import { FalhaContrato, MENSAGEM_LINK_INVALIDO, PREFIXO_IMPORTADO, criarSequenciador, mensagemFalhaContrato, opcaoForaDaLista, pedidoDaUrl, urlDaSelecao, valorDaSelecao } from './contrato-url';
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
export default function ContratoAdmin() {
    const [editando,setEditando]=useState(false);
    const [retorno,setRetorno]=useState<string|null>(null),[destino,setDestino]=useState(''),[financeiroPronto,setFinanceiroPronto]=useState('');
    const posicionado=useRef('');
    const operacaoEmCurso=useRef(false);
    const pedidoRevisao=useRef<{intencao:string;chave:string}|null>(null);
    useEffect(()=>{const atualizar=()=>{setDestino(window.location.hash);setRetorno(retornoFestaSeguro(new URLSearchParams(window.location.search).get('returnTo')));};atualizar();window.addEventListener('hashchange',atualizar);return()=>window.removeEventListener('hashchange',atualizar);},[]);
    const [lista, setLista] = useState<ContextoContrato[]>([]), [mostrarCancelados,setMostrarCancelados]=useState(false), [mostrarImportados,setMostrarImportados]=useState(true), [cid, setCid] = useState(''), [data, setData] = useState<Painel | null>(null), [vid, setVid] = useState('');
    const [note, setNote] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [senha, setSenha] = useState(''), [motivo, setMotivo] = useState(''), [tipo, setTipo] = useState('NOVA_VERSAO'), [key, setKey] = useState('');
    // A URL é a fonte da seleção (link do Dashboard/Financeiro/festa/assistente, seletor, voltar/avançar). Ver contrato-url.ts.
    const params = useSearchParams(), pathname = usePathname(), router = useRouter();
    const pedidoUrl = pedidoDaUrl(params);
    const urlContrato = pedidoUrl.tipo === 'contrato' ? pedidoUrl.contratoId : '', urlVersao = pedidoUrl.tipo === 'contrato' ? pedidoUrl.versaoId ?? '' : '', urlInvalida = pedidoUrl.tipo === 'invalido';
    // Contrato importado (`?importacaoId=`): registro somente leitura de `ia_importacoes`, nunca carregado como contrato do Core.
    const urlImportacao = pedidoUrl.tipo === 'importado' ? pedidoUrl.importacaoId : '';
    const sequencia = useRef(criarSequenciador());
    // Só a resposta do último pedido é aplicada: um contrato clicado antes não substitui o atual quando responde atrasado.
    const load = useCallback(async (id: string, selected?: string): Promise<boolean> => { const pedido = sequencia.current.iniciar(); let res: Response, b: { ok: boolean; data?: unknown; erro?: string };
        try { res = await adminFetch('/api/admin/contratos/painel?contratoId=' + id); b = await res.json(); }
        catch (e) { if (!sequencia.current.vigente(pedido)) return false; throw e; }
        if (!sequencia.current.vigente(pedido)) return false;
        if (!b.ok) throw new FalhaContrato(res.status, mensagemFalhaContrato(res.status, b.erro));
        const p = b.data as Painel; setData(p); const v = p.versoes.find(x => x.id === selected) || p.versoes.find(x => x.id === p.fluxo?.versao_em_preparacao_id) || p.versoes[0]; setVid(v.id); setNote(v.dados_fonte?.observacoesDocumentais ?? ''); return true; }, []);
    useEffect(() => { let ativo = true; const filtros = new URLSearchParams(); if (mostrarCancelados) filtros.set('incluirCancelados', '1'); if (!mostrarImportados) filtros.set('incluirImportados', '0'); const busca = filtros.toString();
        adminFetch('/api/admin/contratos/painel'+(busca?`?${busca}`:'')).then(r => r.json()).then(b => { if (!b.ok)
        throw Error(b.erro); if (ativo) setLista(b.data); }).catch(e => { if (ativo) setError(e.message); }); return () => { ativo = false; }; }, [mostrarCancelados, mostrarImportados, urlContrato, urlImportacao]);
    // Nova URL ⇒ a seleção anterior sai na hora (ajuste de estado no render, sem efeito em cascata).
    const chaveUrl = urlInvalida ? 'invalida' : `${urlContrato}|${urlVersao}|${urlImportacao}`;
    const [chaveAplicada, setChaveAplicada] = useState<string | null>(null);
    if (chaveAplicada !== chaveUrl) {
        setChaveAplicada(chaveUrl); setCid(urlContrato); setData(null); setVid(''); setEditando(false); setError(urlInvalida ? MENSAGEM_LINK_INVALIDO : '');
    }
    // Contrato pedido pela URL: carregado pelo detalhe do tenant mesmo se os filtros da lista o ocultarem.
    useEffect(() => {
        if (!urlContrato) { sequencia.current.iniciar(); return; }
        load(urlContrato, urlVersao || undefined).catch(e => { setCid(''); setData(null); setError(e instanceof FalhaContrato ? e.message : 'Não foi possível carregar o contrato. Tente novamente.'); });
    }, [urlContrato, urlVersao, load]);
    const v = data?.versoes.find(x => x.id === vid), docs = data?.documentos.filter(d => d.contrato_versao_id === vid) ?? [], signatures = data?.assinaturas.filter(s => s.contrato_versao_id === vid) ?? [];
    const financeiroKey=cid+':'+data?.fluxo?.versao_vigente_id;
    const financeiroCarregado=useCallback(()=>setFinanceiroPronto(financeiroKey),[financeiroKey]);
    useEffect(()=>{
        if(!v||!data||!['#financeiro','#alteracoes'].includes(destino))return;
        const params=new URLSearchParams(window.location.search);
        if(params.get('contratoId')!==cid||params.get('versaoId')&&params.get('versaoId')!==vid)return;
        if(destino==='#financeiro'&&data.financeiro.length&&financeiroPronto!==financeiroKey)return;
        const chave=cid+':'+vid+destino;
        if(posicionado.current===chave)return;
        if(destino!=='#financeiro'){
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
    },[cid,vid,v,data,destino,financeiroKey,financeiroPronto]);
    const action = async (body: Record<string, unknown>):Promise<boolean> => { if (!v || operacaoEmCurso.current)
        return false; operacaoEmCurso.current=true; setBusy(true); setError(''); try {
        const r = await adminFetch(`/api/admin/contratos/versoes/${v.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const b = await r.json();
        if (!b.ok)
            throw Error(b.erro);
        await load(cid, b.data?.versaoId ?? v.id);
        return true;
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Falha na operação.');
        return false;
    }
    finally {
        operacaoEmCurso.current=false; setBusy(false);
    } };
    async function cancelarContratacao(){
        if(!v||!data)return;
        const motivo=window.prompt('Por que esta contratação será cancelada? O histórico e os documentos serão preservados.');
        if(!motivo||motivo.trim().length<3)return;
        if(!window.confirm(`Cancelar a contratação de ${v.snapshot.contratante.nomeCompleto}? A festa sairá das listas ativas.`))return;
        if(await action({acao:'cancelar_contratacao',motivo:motivo.trim()})){
            const response=await adminFetch('/api/admin/contratos/painel');
            const body=await response.json();if(body.ok)setLista(body.data);
            setCid('');setVid('');setData(null);
            router.replace(urlDaSelecao(pathname, params, ''), { scroll: false });
        }
    }
    const revisaoOperacional=data?.revisoesOperacionais.find(r=>r.contrato_versao_id===vid);
    const vigente = data?.versoes.find(x => x.id === data.fluxo?.versao_vigente_id);
    const preparacao = data?.versoes.find(x => x.id === data.fluxo?.versao_em_preparacao_id
        && ['EM_ELABORACAO', 'ASSINADA_KIDMAIS', 'AGUARDANDO_CLIENTE'].includes(x.estado_edicao ?? ''));
    const revisaoPreparacao = data?.revisoesOperacionais.find(r => r.contrato_versao_id === preparacao?.id);
    const preparacaoAtiva = preparacao && (!revisaoPreparacao || ['EM_ELABORACAO', 'CONGELADA'].includes(revisaoPreparacao.estado));
    const origem = data?.versoes.find(x => x.id === v?.origem_versao_id);
    const analise = v && origem ? analisarRevisao(origem.snapshot,v.snapshot) : null;
    const podeSubstituir = v?.status==='ATIVA' && data?.contrato.status!=='CANCELADO' && data?.fluxo?.versao_em_preparacao_id===v.id && ['ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE'].includes(v.estado_edicao??'');
    const podeRevisar = data?.contrato.status==='ASSINADO' && v?.status==='ASSINADA' && (!data.fluxo || data.fluxo.versao_vigente_id===v.id);
    async function criarRevisao(){
        if(!v)return;
        const intencao=JSON.stringify({versao:v.id,tipo,motivo:motivo.trim()});
        if(pedidoRevisao.current?.intencao!==intencao)pedidoRevisao.current={intencao,chave:crypto.randomUUID()};
        if(await action(podeSubstituir?{acao:'substituir_preparacao',motivo:motivo.trim(),chaveCriacao:pedidoRevisao.current.chave}:{acao:'nova_versao',tipo,motivo:motivo.trim(),chaveCriacao:pedidoRevisao.current.chave})){pedidoRevisao.current=null;setEditando(false);window.location.hash='alteracoes';}
    }
    const abas = [{ id: 'geral', rotulo: 'Visão geral', hash: '#visao-geral' }, { id: 'documentos', rotulo: 'Documentos', hash: '#documentacao' }, { id: 'financeiro', rotulo: 'Financeiro', hash: '#financeiro' }, { id: 'historico', rotulo: 'Histórico', hash: '#historico' }];
    const aba = destino === '#documentacao' ? 'documentos' : destino === '#financeiro' ? 'financeiro' : destino === '#historico' ? 'historico' : 'geral';
    function abrirAba(hash: string) {
        // A troca de aba mantém o foco no controle. Links externos continuam usando o scroll de deep link.
        posicionado.current = cid + ':' + vid + hash;
        window.history.replaceState(window.history.state, '', hash);
        setDestino(hash);
    }
    const proximo = v?.estado_edicao === 'EM_ELABORACAO' ? (v.documento_revisado_id ? 'Assinar pela Kidmais' : docs.some(d => d.categoria === 'CONTRATO' && d.revisao === v.revisao) ? 'Revisar o PDF' : 'Preparar o documento') : v?.estado_edicao === 'ASSINADA_KIDMAIS' ? 'Liberar para o cliente' : v?.estado_edicao === 'AGUARDANDO_CLIENTE' ? 'Acompanhar assinatura do cliente' : 'Conferir documentos e assinaturas';
    const docUrl = (id: string) => `/api/admin/contratos/documentos/${id}`;
    // Contrato aberto pelo link mas oculto pelos filtros da lista: aparece no seletor, identificado como tal.
    const foraDaLista = opcaoForaDaLista(lista, cid, data);
    const opcaoUrl = cid && !lista.some(c => c.id === cid) ? (foraDaLista ? `${contratoApresentacao(foraDaLista)} — fora dos filtros da lista` : 'Carregando contrato…') : null;
    const selecaoImportada = urlImportacao ? `${PREFIXO_IMPORTADO}${urlImportacao}` : '';
    const opcaoImportada = urlImportacao && !lista.some(c => c.origem === 'IMPORTACAO' && c.id === urlImportacao) ? 'Contrato importado — fora dos filtros da lista' : null;
    // Contrato aberto (carregado pela API do tenant) informa o drawer. É só dica: o servidor revalida no tenant comprovado.
    return <main className={styles.page}>{cid&&data&&<ContextoKidmais tela="contrato" entidadeId={cid}/>}{retorno&&<Link href={retorno}>Voltar à festa</Link>}<div className={styles.tituloContratos}><h1>Contratos</h1><Link className={styles.importarContrato} href="/admin/contratos/importar">Importar contrato antigo</Link></div>{error && <p role="alert">{error}</p>}{cid && !data && !error && <p role="status">Carregando contrato…</p>}
 <details><summary>Filtros da lista</summary><label><input type="checkbox" checked={mostrarCancelados} onChange={e=>setMostrarCancelados(e.target.checked)}/> Incluir contratos cancelados</label> <label><input type="checkbox" checked={mostrarImportados} onChange={e=>setMostrarImportados(e.target.checked)}/> Incluir contratos importados</label></details>
 <label>Contrato <select aria-label="Contrato" value={selecaoImportada || cid} onChange={(e) => { router.push(urlDaSelecao(pathname, params, e.target.value), { scroll: false }); }}><option value="">Selecione</option>{lista.map(c => <option key={valorDaSelecao(c)} value={valorDaSelecao(c)}>{contratoApresentacao(c)}</option>)}{opcaoUrl && <option value={cid}>{opcaoUrl}</option>}{opcaoImportada && <option value={selecaoImportada}>{opcaoImportada}</option>}</select></label>
 {urlImportacao && <ContratoImportado key={urlImportacao} importacaoId={urlImportacao} />}
 {v && data && <><header className={styles.overview}><div className={styles.hero}><div><span className={styles.badge}>{v.estado_edicao ?? v.status}</span><h2>{v.snapshot.contratante.nomeCompleto}</h2><p>{v.snapshot.evento.data.split('-').reverse().join('/')} · {v.snapshot.evento.pacote.nome} · {v.snapshot.evento.convidados} convidados</p></div><div className={styles.total}><span>Valor contratual · V{v.numero_versao}</span><strong>{formatarMoeda(v.snapshot.comercial.valorFinalContrato)}</strong></div></div><div className={styles.actions}>{v.estado_edicao==='EM_ELABORACAO' && <button disabled={busy} onClick={()=>{setEditando(!editando);window.location.hash='alteracoes';}}>Editar dados desta revisão</button>}{(podeRevisar||podeSubstituir)&&<a href="#alteracoes"><strong>{podeSubstituir?'Criar nova revisão':'Criar revisão / retificação'}</strong></a>}{data.contrato.status!=='CANCELADO'&&(data.festaId ? <Link href={'/admin/festas/'+data.festaId}>Cancelar contrato na Festa</Link> : data.contrato.status==='AGUARDANDO_ASSINATURA'&&!data.fluxo?.versao_vigente_id&&<button disabled={busy} onClick={cancelarContratacao}>Cancelar contrato</button>)}</div></header>
 {data.origemHistorica && <OrigemHistoricaContrato origem={data.origemHistorica} />}
 <div className={styles.next}><div><strong>Próximo passo</strong><p>{data.contrato.status === 'CANCELADO' ? 'Contratação cancelada. Consulte os registros preservados.' : data.origemHistorica && v?.estado_edicao === 'CONCLUIDA' ? (data.origemHistorica.caminhoFinanceiro === 'CONFERIR_HISTORICO' ? 'Conferir os pagamentos do contrato histórico.' : data.origemHistorica.caminhoFinanceiro === 'PLANO_NA_VERSAO_VIGENTE' ? 'Registrar os pagamentos no Financeiro: criar o plano na versão vigente e lançar os recebimentos com a data real.' : data.origemHistorica.caminhoFinanceiro === 'AGUARDAR_REVISAO' ? 'Concluir ou cancelar a revisão aberta antes de registrar os pagamentos.' : 'Contrato histórico conferido. Mudanças seguem uma nova revisão do contrato.') : proximo}</p></div>{v?.estado_edicao === 'AGUARDANDO_CLIENTE' && data.contrato.status !== 'CANCELADO' ? <a href={`/contrato/${cid}`} target="_blank" rel="noreferrer">Abrir acesso público do cliente ↗</a> : <a href="#documentacao">Ver documentos</a>}</div>
 <label className={styles.version}>Versão em consulta<select aria-label="Versão contratual" value={vid} onChange={e => { const n = data.versoes.find(x => x.id === e.target.value)!; setVid(n.id);setEditando(false); setNote(n.dados_fonte?.observacoesDocumentais ?? ''); setKey(''); }}>{data.versoes.map(x => <option key={x.id} value={x.id}>V{x.numero_versao} — {x.status==='ASSINADA'?'ASSINADA':x.estado_edicao ?? `LEGADO / ${x.status}`}</option>)}</select></label>
 <nav className={styles.tabs} role="tablist" aria-label="Conteúdo do contrato">{abas.map((item, indice) => <button key={item.id} type="button" role="tab" id={`aba-${item.id}`} aria-controls={`painel-${item.id}`} aria-selected={aba === item.id} tabIndex={aba === item.id ? 0 : -1} onClick={() => abrirAba(item.hash)} onKeyDown={e => { const alvo = e.key === 'ArrowRight' ? (indice + 1) % abas.length : e.key === 'ArrowLeft' ? (indice + abas.length - 1) % abas.length : e.key === 'Home' ? 0 : e.key === 'End' ? abas.length - 1 : null; if (alvo !== null) { e.preventDefault(); abrirAba(abas[alvo].hash); document.getElementById(`aba-${abas[alvo].id}`)?.focus(); } }}>{item.rotulo}</button>)}</nav>
 
 <section id="painel-historico" role="tabpanel" aria-labelledby="aba-historico" className={styles.panel} hidden={aba !== 'historico'}><h2 id="historico">Histórico de versões</h2><p>Vigente: {data.versoes.find(x => x.id === data.fluxo?.versao_vigente_id)?.numero_versao ?? (data.fluxo ? 'ainda não concluída' : 'legado')} · Contrato {data.contrato.status}</p>
 <select aria-label="Versão contratual no histórico" value={vid} onChange={e => { const n = data.versoes.find(x => x.id === e.target.value)!; setVid(n.id);setEditando(false); setNote(n.dados_fonte?.observacoesDocumentais ?? ''); setKey(''); }}>{data.versoes.map(x => <option key={x.id} value={x.id}>V{x.numero_versao} — {x.status==='ASSINADA'?'ASSINADA':x.estado_edicao ?? `LEGADO / ${x.status}`}</option>)}</select>
 <ul>{data.versoes.map(x => <li key={x.id}>V{x.numero_versao} · {new Date(x.criado_em).toLocaleString('pt-BR')} · {x.estado_edicao ?? x.status}{x.motivo_nova_versao ? ` · ${x.motivo_nova_versao}` : ''}</li>)}</ul></section>
 <section id="painel-geral" role="tabpanel" aria-labelledby="aba-geral" className={styles.panel} hidden={aba !== 'geral'}><h2>Dados do contratante</h2><p>{v.snapshot.contratante.nomeCompleto} · {v.snapshot.contratante.email}</p>
 <h2>Dados da festa</h2><p>{v.snapshot.evento.data} · {v.snapshot.evento.horarioInicio}–{v.snapshot.evento.horarioFim} · {v.snapshot.evento.pacote.nome} · {v.snapshot.evento.convidados} convidados</p>
 <h2>Condições comerciais e pagamento</h2><p>Valor contratual: <strong>{formatarMoeda(v.snapshot.comercial.valorFinalContrato)}</strong> · {formatarFormaPagamento(v.snapshot.comercial.formaPagamentoPretendida)}</p>
 {v.snapshot.comercial.valorBaseComercial != null && <p>Base: {formatarMoeda(v.snapshot.comercial.valorBaseComercial)} · desconto: {v.snapshot.comercial.descontoFormaPagamentoPercentual}%</p>}
 {v.snapshot.comercial.condicaoPagamento && <><p>Condição proposta: {formatarCondicaoPix(v.snapshot.comercial.condicaoPagamento.pretendida)}</p><p>Condição aprovada: {formatarCondicaoPix(v.snapshot.comercial.condicaoPagamento.aprovada)} · revisão {v.snapshot.comercial.condicaoPagamento.revisaoStatus}</p></>}
 {vigente && v.id !== vigente.id && v.status === 'ASSINADA' && <p>Esta é uma versão histórica. A versão vigente atual é V{vigente.numero_versao}.</p>}
 {vigente && preparacaoAtiva && <p className={styles.notice} data-testid="aviso-preparacao">{preparacao.estado_edicao === 'EM_ELABORACAO'
    ? `A versão V${preparacao.numero_versao} está em elaboração.`
    : preparacao.estado_edicao === 'AGUARDANDO_CLIENTE'
        ? `A versão V${preparacao.numero_versao} está congelada e aguarda a assinatura do cliente.`
        : `A versão V${preparacao.numero_versao} está assinada pela Kidmais e aguarda liberação para o cliente.`} A versão vigente V{vigente.numero_versao} permanece preservada. As alterações de operação só entram em vigor após a conclusão das assinaturas da nova versão.</p>}
 {revisaoOperacional && <section className={styles.card}><h2>Agenda da revisão</h2><p>{revisaoOperacional.ocupa_vigente?(!revisaoOperacional.slot_alterado&&['EM_ELABORACAO','CONGELADA'].includes(revisaoOperacional.estado)?'RESERVA CONFIRMADA — data e horário mantidos':'RESERVA CONFIRMADA'):'DATA PROPOSTA — AINDA NÃO RESERVADA'} · data vigente: {revisaoOperacional.data_vigente}</p>{['EM_ELABORACAO','CONGELADA'].includes(revisaoOperacional.estado)&&<>{revisaoOperacional.slot_alterado&&<p>{revisaoOperacional.hold_destino_adquirido_em?'HOLD DE REMARCAÇÃO — DATA PROVISORIAMENTE PROTEGIDA DURANTE REMARCAÇÃO':revisaoOperacional.ocupa_vigente?'DESTINO SEM HOLD — REVALIDAÇÃO OBRIGATÓRIA':'DATA PROPOSTA — AINDA NÃO RESERVADA'} · destino: {revisaoOperacional.data_evento} · {revisaoOperacional.horario_inicio.slice(0,5)}–{revisaoOperacional.horario_fim.slice(0,5)}</p>}<button disabled={busy} onClick={()=>action({acao:'revalidar_destino',revisao:v.revisao})}>Revalidar destino</button></>}</section>}
 <section id="alteracoes" tabIndex={-1} aria-label="Alterações da contratação" className={`${styles.anchor} ${destino === '#alteracoes' ? styles.deepLinkAnchor : ''}`}><h2>Alterações da contratação</h2>{(podeRevisar||podeSubstituir) && <section><h3>{podeSubstituir?'Criar nova revisão':'Criar revisão / retificação'}</h3>{podeSubstituir&&<p>Esta versão e a assinatura da Kidmais serão preservadas. O acesso anterior será encerrado. A nova revisão exigirá novo PDF e nova assinatura da Kidmais antes da liberação ao cliente.</p>}<p>Prepare alterações de convidados, pacote, adicionais, buffet, data e condição comercial em uma nova versão. Você pode iniciar por necessidade da Kidmais.</p>{!podeSubstituir&&<select aria-label="Tipo da revisão" value={tipo} onChange={e => setTipo(e.target.value)}><option value="NOVA_VERSAO">Nova versão</option><option value="RETIFICACAO">Retificação documental</option><option value="ADITIVO" disabled>Aditivo — template específico pendente</option></select>}<label>Motivo <input value={motivo} maxLength={500} onChange={e => setMotivo(e.target.value)}/></label>{preparacaoAtiva&&!podeSubstituir?<button disabled={busy} onClick={()=>{setVid(preparacao.id);setNote(preparacao.dados_fonte?.observacoesDocumentais??'');setEditando(false);}}>Abrir revisão em andamento — V{preparacao.numero_versao}</button>:<button disabled={busy || motivo.trim().length < 3} onClick={criarRevisao}>{podeSubstituir?'Criar nova revisão':'Criar revisão / retificação'}</button>}</section>}{v.estado_edicao==='EM_ELABORACAO'&&<button disabled={busy} onClick={()=>setEditando(!editando)}>{editando?'Fechar edição':'Editar dados desta revisão'}</button>}{editando && <EdicaoFesta key={vid} versaoId={vid} revisao={v.revisao} serverError={error} onSave={action} onClose={()=>setEditando(false)}/>}<details><summary>Diferenças desta revisão</summary><h3>Alterações desta revisão</h3>{origem&&<p>Versão anterior preservada: V{origem.numero_versao} → Nova versão: V{v.numero_versao} · Status: {v.estado_edicao} · Motivo: {v.motivo_nova_versao} · Criada em: {new Date(v.criado_em).toLocaleString('pt-BR')}</p>}{analise&&<><p>{analise.natureza==='MATERIAL'?'Alteração material':analise.natureza==='DOCUMENTAL'?'Alteração documental / não material':'Nenhuma alteração de conteúdo'}. Esta revisão exige nova assinatura da Kidmais e do cliente para entrar em vigor, inclusive em correções documentais.</p>{analise.alteraAgenda&&<p>A data e o horário vigentes continuam ocupados até a formalização desta revisão. O destino será revalidado; conflitos impedem a troca.</p>}{analise.impactoFinanceiro&&<p>Há impacto financeiro. Recebimentos anteriores são preservados. Após formalização, confira as pendências e ajuste as obrigações futuras pelo fluxo financeiro existente; não há quitação ou estorno automático.</p>}</>}{(analise?.campos ?? v.alteracoes?.campos)?.length ? <div className={styles.tableWrap}><table><thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead><tbody>{(analise?.campos ?? v.alteracoes?.campos ?? []).map(d=><tr key={d.campo}><td>{rotuloCampo(d.campo)}</td><td>{valorDiferenca(d.antes,d.campo)}</td><td>{valorDiferenca(d.depois,d.campo)}</td></tr>)}</tbody></table></div>:<p>Nenhuma diferença registrada nesta elaboração.</p>}</details></section>
 </section><section id="painel-documentos" role="tabpanel" aria-labelledby="aba-documentos" className={styles.panel} hidden={aba !== 'documentos'}>
 <h2 id="documentacao">Documentos da contratação · V{v.numero_versao}</h2>
 {!configuracaoModeloOficial(v.snapshot.evento.pacote.codigo)&&<p className={styles.notice}>Este pacote ainda não possui modelo oficial de contrato cadastrado. A preparação pode ser salva; geração do PDF e assinatura dependem da aprovação do modelo correspondente.</p>}<details className={styles.documentDetails} open={v.estado_edicao === 'EM_ELABORACAO'}><summary>Observações e detalhes dos documentos</summary><label>Observações exclusivamente documentais<textarea value={note} maxLength={2000} disabled={v.estado_edicao !== 'EM_ELABORACAO'} onChange={e => setNote(e.target.value)} style={{ width: '100%', minHeight: 90 }}/></label><p>Não use observações para mudar valores, datas, partes ou obrigações operacionais.</p>
 {v.estado_edicao === 'EM_ELABORACAO' && <><button disabled={busy} onClick={() => action({ acao: 'salvar', revisao: v.revisao, observacoesDocumentais: note })}>Salvar revisão</button> <button disabled={busy} onClick={() => action({ acao: 'gerar_pdf', revisao: v.revisao })}>Gerar PDF da revisão</button></>}
 {revisaoOperacional?.estado==='EM_ELABORACAO'&&<button disabled={busy} onClick={()=>{const m=window.prompt('Motivo da recusa comercial. A reserva e a preparação serão mantidas.');if(m&&m.trim().length>=3)action({acao:'recusar_comercial',revisao:v.revisao,motivo:m,chaveDecisao:crypto.randomUUID()});}}>Recusar condição comercial</button>}
 </details>
 <div className={styles.documentList}>{docs.length === 0 && <p>{v.estado_edicao ? 'Nenhum documento gerado.' : 'Documento anterior disponível no arquivo preservado. Ainda não importado para impressão nesta tela.'}</p>}
 {docs.map(d => <article key={d.id} className={styles.documentRow}><div><h3>{d.categoria === 'CONTRATO' ? 'Contrato' : d.categoria === 'COMPROVANTE_ASSINATURA' ? 'Comprovante de assinatura' : d.categoria.replaceAll('_', ' ')}</h3><p>Revisão {d.revisao} · ref. {d.id.slice(0, 8)}</p></div><div className={styles.documentActions}><a className={styles.documentButton} href={docUrl(d.id)} target="_blank" rel="noreferrer">Visualizar</a><a className={styles.documentButton} href={`${docUrl(d.id)}?baixar=1`}>Baixar PDF</a><a className={styles.documentButton} href={docUrl(d.id)} target="_blank" rel="noreferrer">Abrir para imprimir</a>{d.categoria === 'CONTRATO' && d.revisao === v.revisao && v.estado_edicao === 'EM_ELABORACAO' && <button disabled={busy} onClick={() => { if (window.confirm(`Confirmo que revisei o PDF ${d.id} da versão ${v.numero_versao}, revisão ${v.revisao}, e que seus dados refletem as condições oficiais aprovadas.`))
            action({ acao: 'revisar', revisao: v.revisao, documentoId: d.id }); }}>Confirmar revisão deste PDF</button>}</div></article>)}
 <article className={styles.documentRow} aria-label="Resumo da contratação"><div><h3>Resumo da contratação</h3><p>Informações comerciais e operacionais</p></div><div className={styles.documentActions}><a className={styles.documentButton} target="_blank" rel="noreferrer" href={`/admin/contratos/resumo?contratoId=${cid}&versaoId=${vid}`}>Visualizar resumo</a><a className={styles.documentButton} target="_blank" rel="noreferrer" href={`/admin/contratos/resumo?contratoId=${cid}&versaoId=${vid}&baixar=1`}>Baixar PDF do resumo</a><a className={styles.documentButton} target="_blank" rel="noreferrer" href={`/admin/contratos/resumo?contratoId=${cid}&versaoId=${vid}&imprimir=1`}>Imprimir resumo</a></div></article>
 </div>
 {v.estado_edicao === 'EM_ELABORACAO' && v.documento_revisado_id && <section><h2>Assinatura Kidmais</h2><label>Confirme sua senha <input type="password" value={senha} autoComplete="current-password" onChange={e => setSenha(e.target.value)}/></label><button disabled={busy || !senha} onClick={async () => { if (!window.confirm(`APROVAR E ASSINAR PELA KIDMAIS: versão ${v.numero_versao}, revisão ${v.revisao}, PDF ${v.documento_revisado_id}. O conteúdo será congelado.`))
            return; setError(''); try {
            const res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'reautenticar', senha }) });
            setSenha('');
            const b = await res.json();
            if (!b.ok)
                throw Error(b.erro);
            const id = key || crypto.randomUUID();
            setKey(id);
            await action({ acao: 'assinar', revisao: v.revisao, documentoId: v.documento_revisado_id, chaveIdempotencia: id });
        }
        catch (e) {
            setError(String(e));
        } }}>Aprovar e assinar pela Kidmais</button></section>}
 {v.estado_edicao === 'ASSINADA_KIDMAIS' && <button disabled={busy} onClick={() => action({ acao: 'liberar', revisao: v.revisao })}>Liberar para o cliente</button>}
 <details className={styles.documentDetails}><summary>Assinaturas e comprovantes ({signatures.length})</summary>{signatures.length === 0 && <p>{versaoAssinadaEmPapel(v) ? TEXTO_ASSINADO_EM_PAPEL : 'Nenhuma assinatura registrada nesta versão.'}</p>}{signatures.map(s => <p key={s.id}>{s.parte}: {s.identidade_snapshot.nome} · {new Date(s.assinado_em).toLocaleString('pt-BR')} · <a className={styles.documentButton} target="_blank" rel="noreferrer" href={docUrl(s.comprovante_documento_id)}>Ver comprovante</a></p>)}</details>
 {v.documento_revisado_id && <a className={styles.documentButton} target="_blank" rel="noreferrer" href={`/admin/contratos/imprimir?contratoId=${cid}&versaoId=${vid}`}>Imprimir contrato completo — V{v.numero_versao}</a>}
 </section><section id="painel-financeiro" role="tabpanel" aria-labelledby="aba-financeiro" className={styles.panel} hidden={aba !== 'financeiro'}><section id="financeiro" tabIndex={-1} aria-label="Financeiro" className={`${styles.anchor} ${destino==='#financeiro'?styles.financialAnchor:''}`}>{data.financeiro.length?<FinanceiroContrato key={`${cid}:${data.fluxo?.versao_vigente_id}`} contratoId={cid} onReady={financeiroCarregado}/>:data.origemHistorica?.caminhoFinanceiro==='AGUARDAR_REVISAO'?<p role="status">Há uma revisão do contrato em andamento. Conclua ou cancele a revisão para registrar os pagamentos.</p>:data.origemHistorica?.caminhoFinanceiro==='CONFERIR_HISTORICO'?<IntegracaoContrato key={`fin:${data.origemHistorica.importacaoId}`} importacaoId={data.origemHistorica.importacaoId} modoInicial="financeiro"/>:<CriarPlanoFinanceiro key={financeiroKey} contexto={contextoCriacao(data)} onCreated={async()=>{await load(cid,vid);window.location.hash='financeiro';}}/>}</section></section>
 
 </>}
 </main>;
}
function valorDiferenca(value:unknown,campo=''):string {if(typeof value==='number' && /\.valor[A-Z]/.test(campo))return formatarMoeda(value);if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value))return value.split('-').reverse().join('/');if(value==null || value==='')return 'Não informado';if(Array.isArray(value))return value.length?value.map(x=>typeof x==='object'&&x?'nome' in x?`${x.nome} (${x.quantidade})`:JSON.stringify(x):String(x)).join(', '):'Nenhum';if(typeof value==='object')return Object.values(value).map(x=>valorDiferenca(x)).join(' · ');return String(value);}
function rotuloCampo(campo:string):string {const labels:Record<string,string>={'evento.pacote.nome':'Pacote','evento.convidados':'Convidados','evento.convidadosFaturados':'Convidados faturados','comercial.valorPacoteBase':'Valor base do pacote','comercial.valorPacoteAplicado':'Valor aplicado ao pacote','comercial.valorBaseComercial':'Base comercial','evento.data':'Data','evento.horarioInicio':'Início','evento.horarioFim':'Fim','comercial.valorFinalContrato':'Valor contratual','comercial.valorTabela':'Valor de tabela','comercial.formaPagamentoPretendida':'Forma de pagamento','contratacao.adicionais':'Adicionais','documental.observacoes':'Observações documentais'};return labels[campo] ?? campo.replaceAll('.', ' / ').replace(/([a-z])([A-Z])/g,'$1 $2');}
