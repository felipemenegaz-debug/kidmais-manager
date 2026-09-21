'use client';
import { analisarRevisao } from '@/lib/contratos/services/alteracoes';
import { configuracaoModeloOficial } from '../../lib/contratos/documento/oficial/configuracao';
import { useCallback, useEffect, useState, useRef } from 'react';
import type { ContratoSnapshotV1 } from '@/lib/contratos/repositories/models';
import { adminFetch } from '@/lib/http/admin-fetch';
import { formatarFormaPagamento, formatarMoeda, formatarCondicaoPix } from '@/lib/contratos/documento/formatters';
import styles from './admin.module.css';
import Link from 'next/link';
import { retornoFestaSeguro } from '@/lib/festas/apresentacao';
import EdicaoFesta from './EdicaoFesta';
import FinanceiroContrato from './FinanceiroContrato';
import CriarPlanoFinanceiro from './CriarPlanoFinanceiro';
import { contextoCriacao } from './criacao-financeira';
import { contratoApresentacao, type ContextoContrato } from './financeiro-apresentacao';
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
    const [lista, setLista] = useState<ContextoContrato[]>([]), [cid, setCid] = useState(''), [data, setData] = useState<Painel | null>(null), [vid, setVid] = useState('');
    const [note, setNote] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [senha, setSenha] = useState(''), [motivo, setMotivo] = useState(''), [tipo, setTipo] = useState('NOVA_VERSAO'), [key, setKey] = useState('');
    const load = useCallback(async (id: string, selected?: string) => { const res = await adminFetch('/api/admin/contratos/painel?contratoId=' + id); const b = await res.json(); if (!b.ok)
        throw Error(b.erro); const p = b.data as Painel; setData(p); const v = p.versoes.find(x => x.id === selected) || p.versoes.find(x => x.id === p.fluxo?.versao_em_preparacao_id) || p.versoes[0]; setVid(v.id); setNote(v.dados_fonte?.observacoesDocumentais ?? ''); }, []);
    useEffect(() => { adminFetch('/api/admin/contratos/painel').then(r => r.json()).then(async b => { if (!b.ok)
        throw Error(b.erro); setLista(b.data); const solicitado=new URLSearchParams(window.location.search).get('contratoId'); if(solicitado&&b.data.some((c:ContextoContrato)=>c.id===solicitado)){setCid(solicitado);await load(solicitado,new URLSearchParams(window.location.search).get('versaoId')??undefined);} }).catch(e => setError(e.message)); }, [load]);
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
    const docUrl = (id: string) => `/api/admin/contratos/documentos/${id}`;
    return <main className={styles.page}>{retorno&&<Link href={retorno}>Voltar à festa</Link>}<h1>Contratos</h1><p role="alert">{error}</p>
 <label>Contrato <select aria-label="Contrato" value={cid} onChange={async (e) => { setCid(e.target.value); setData(null); setError('');setEditando(false); if(!e.target.value){return;} try {
        await load(e.target.value);
    }
    catch (e) {
        setError(String(e));
    } }}><option value="">Selecione</option>{lista.map(c => <option key={c.id} value={c.id}>{contratoApresentacao(c)}</option>)}</select></label>
 {v && data && <><header className={styles.overview}><span className={styles.badge}>{v.estado_edicao ?? v.status}</span><h2>{v.snapshot.contratante.nomeCompleto}</h2><p>{v.snapshot.evento.data.split('-').reverse().join('/')} · {v.snapshot.evento.pacote.nome} · {v.snapshot.evento.convidados} convidados</p><div className={styles.actions}>{v.estado_edicao==='EM_ELABORACAO' && <button disabled={busy} onClick={()=>{setEditando(!editando);window.location.hash='alteracoes';}}>Editar dados desta revisão</button>}{(podeRevisar||podeSubstituir)&&<a href="#alteracoes"><strong>{podeSubstituir?'Criar nova revisão':'Criar revisão / retificação'}</strong></a>}<a href="#historico">Histórico</a><a href="#alteracoes">Alterações</a><a href="#documentacao">Contrato</a><a href="#financeiro">Financeiro</a></div></header>
 
 <h2 id="historico">Histórico de versões</h2><p>Vigente: {data.versoes.find(x => x.id === data.fluxo?.versao_vigente_id)?.numero_versao ?? (data.fluxo ? 'ainda não concluída' : 'legado')} · Contrato {data.contrato.status}</p>
 <select aria-label="Versão contratual" value={vid} onChange={e => { const n = data.versoes.find(x => x.id === e.target.value)!; setVid(n.id);setEditando(false); setNote(n.dados_fonte?.observacoesDocumentais ?? ''); setKey(''); }}>{data.versoes.map(x => <option key={x.id} value={x.id}>V{x.numero_versao} — {x.status==='ASSINADA'?'ASSINADA':x.estado_edicao ?? `LEGADO / ${x.status}`}</option>)}</select>
 <h2>Dados do contratante</h2><p>{v.snapshot.contratante.nomeCompleto} · {v.snapshot.contratante.email}</p>
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
 {revisaoOperacional && <section className={styles.card}><h2>Agenda da revisão</h2><p>{revisaoOperacional.ocupa_vigente?(!revisaoOperacional.slot_alterado&&['EM_ELABORACAO','CONGELADA'].includes(revisaoOperacional.estado)?'RESERVA CONFIRMADA — data e horário mantidos':'RESERVA CONFIRMADA'):'DATA PROPOSTA — AINDA NÃO RESERVADA'} · data vigente: {revisaoOperacional.data_vigente}</p>{['EM_ELABORACAO','CONGELADA'].includes(revisaoOperacional.estado)&&<>{revisaoOperacional.slot_alterado&&<p>{revisaoOperacional.hold_destino_adquirido_em?'HOLD DE REMARCAÇÃO — DATA PROVISORIAMENTE PROTEGIDA DURANTE REMARCAÇÃO':revisaoOperacional.ocupa_vigente?'DESTINO SEM HOLD — REVALIDAÇÃO OBRIGATÓRIA':'DATA PROPOSTA — AINDA NÃO RESERVADA'} · destino: {revisaoOperacional.data_evento} · {revisaoOperacional.horario_inicio.slice(0,5)}–{revisaoOperacional.horario_fim.slice(0,5)}</p>}<button disabled={busy} onClick={()=>action({acao:'revalidar_destino',revisao:v.revisao})}>Revalidar destino</button><button disabled={busy} onClick={()=>{const m=window.prompt('Motivo do cancelamento da revisão. A versão vigente será preservada.');if(m&&m.trim().length>=3)action({acao:'cancelar_revisao',revisao:v.revisao,motivo:m});}}>Cancelar revisão</button></>}</section>}
 <section id="alteracoes" tabIndex={-1} aria-label="Alterações da contratação" className={styles.anchor}><h2>Alterações da contratação</h2>{(podeRevisar||podeSubstituir) && <section><h3>{podeSubstituir?'Criar nova revisão':'Criar revisão / retificação'}</h3>{podeSubstituir&&<p>Esta versão e a assinatura da Kidmais serão preservadas. O acesso anterior será encerrado. A nova revisão exigirá novo PDF e nova assinatura da Kidmais antes da liberação ao cliente.</p>}<p>Prepare alterações de convidados, pacote, adicionais, buffet, data e condição comercial em uma nova versão. Você pode iniciar por necessidade da Kidmais.</p>{!podeSubstituir&&<select aria-label="Tipo da revisão" value={tipo} onChange={e => setTipo(e.target.value)}><option value="NOVA_VERSAO">Nova versão</option><option value="RETIFICACAO">Retificação documental</option><option value="ADITIVO" disabled>Aditivo — template específico pendente</option></select>}<label>Motivo <input value={motivo} maxLength={500} onChange={e => setMotivo(e.target.value)}/></label>{preparacaoAtiva&&!podeSubstituir?<button disabled={busy} onClick={()=>{setVid(preparacao.id);setNote(preparacao.dados_fonte?.observacoesDocumentais??'');setEditando(false);}}>Abrir revisão em andamento — V{preparacao.numero_versao}</button>:<button disabled={busy || motivo.trim().length < 3} onClick={criarRevisao}>{podeSubstituir?'Criar nova revisão':'Criar revisão / retificação'}</button>}</section>}{v.estado_edicao==='EM_ELABORACAO'&&<button disabled={busy} onClick={()=>setEditando(!editando)}>{editando?'Fechar edição':'Editar dados desta revisão'}</button>}{editando && <EdicaoFesta key={vid} versaoId={vid} revisao={v.revisao} serverError={error} onSave={action} onClose={()=>setEditando(false)}/>}<h3>Alterações desta revisão</h3>{origem&&<p>Versão anterior preservada: V{origem.numero_versao} → Nova versão: V{v.numero_versao} · Status: {v.estado_edicao} · Motivo: {v.motivo_nova_versao} · Criada em: {new Date(v.criado_em).toLocaleString('pt-BR')}</p>}{analise&&<><p>{analise.natureza==='MATERIAL'?'Alteração material':analise.natureza==='DOCUMENTAL'?'Alteração documental / não material':'Nenhuma alteração de conteúdo'}. Esta revisão exige nova assinatura da Kidmais e do cliente para entrar em vigor, inclusive em correções documentais.</p>{analise.alteraAgenda&&<p>A data e o horário vigentes continuam ocupados até a formalização desta revisão. O destino será revalidado; conflitos impedem a troca.</p>}{analise.impactoFinanceiro&&<p>Há impacto financeiro. Recebimentos anteriores são preservados. Após formalização, confira as pendências e ajuste as obrigações futuras pelo fluxo financeiro existente; não há quitação ou estorno automático.</p>}</>}{(analise?.campos ?? v.alteracoes?.campos)?.length ? <div className={styles.tableWrap}><table><thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead><tbody>{(analise?.campos ?? v.alteracoes?.campos ?? []).map(d=><tr key={d.campo}><td>{rotuloCampo(d.campo)}</td><td>{valorDiferenca(d.antes,d.campo)}</td><td>{valorDiferenca(d.depois,d.campo)}</td></tr>)}</tbody></table></div>:<p>Nenhuma diferença registrada nesta elaboração.</p>}</section>
 {!configuracaoModeloOficial(v.snapshot.evento.pacote.codigo)&&<p className={styles.notice}>Este pacote ainda não possui modelo oficial de contrato cadastrado. A preparação pode ser salva; geração do PDF e assinatura dependem da aprovação do modelo correspondente.</p>}<h2 id="documentacao">Campos documentais</h2><label>Observações exclusivamente documentais<textarea value={note} maxLength={2000} disabled={v.estado_edicao !== 'EM_ELABORACAO'} onChange={e => setNote(e.target.value)} style={{ width: '100%', minHeight: 90 }}/></label><p>Não use observações para mudar valores, datas, partes ou obrigações operacionais.</p>
 {v.estado_edicao === 'EM_ELABORACAO' && <><button disabled={busy} onClick={() => action({ acao: 'salvar', revisao: v.revisao, observacoesDocumentais: note })}>Salvar revisão</button> <button disabled={busy} onClick={() => action({ acao: 'gerar_pdf', revisao: v.revisao })}>Gerar PDF da revisão</button></>}
 {revisaoOperacional?.estado==='EM_ELABORACAO'&&<button disabled={busy} onClick={()=>{const m=window.prompt('Motivo da recusa comercial. A reserva e a preparação serão mantidas.');if(m&&m.trim().length>=3)action({acao:'recusar_comercial',revisao:v.revisao,motivo:m,chaveDecisao:crypto.randomUUID()});}}>Recusar condição comercial</button>}
 {!revisaoOperacional&&v.origem_versao_id&&['EM_ELABORACAO','ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE'].includes(v.estado_edicao??'')&&<p>Proposta documental anterior à revisão operacional. <button disabled={busy} onClick={()=>{const m=window.prompt('Motivo para cancelar a proposta documental anterior e preservar a versão vigente.');if(m&&m.trim().length>=3)action({acao:'cancelar_revisao',revisao:v.revisao,motivo:m});}}>Cancelar proposta anterior</button></p>}
 <h2>Documentos — versão {v.numero_versao}</h2>{docs.length === 0 && <p>{v.estado_edicao ? 'Nenhum documento gerado.' : 'Documento anterior disponível no arquivo preservado. Ainda não importado para impressão nesta tela.'}</p>}
 {docs.map(d => <div key={d.id} style={{ padding: '10px 0' }}><a href={docUrl(d.id)} target="_blank" rel="noreferrer">Abrir/imprimir {d.categoria} · revisão {d.revisao} · {d.id.slice(0, 8)}</a> {d.categoria === 'CONTRATO' && d.revisao === v.revisao && v.estado_edicao === 'EM_ELABORACAO' && <button disabled={busy} onClick={() => { if (window.confirm(`Confirmo que revisei o PDF ${d.id} da versão ${v.numero_versao}, revisão ${v.revisao}, e que seus dados refletem as condições oficiais aprovadas.`))
            action({ acao: 'revisar', revisao: v.revisao, documentoId: d.id }); }}>Confirmar revisão deste PDF</button>}</div>)}
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
        } }}>APROVAR E ASSINAR PELA KIDMAIS</button></section>}
 {v.estado_edicao === 'ASSINADA_KIDMAIS' && <button disabled={busy} onClick={() => action({ acao: 'liberar', revisao: v.revisao })}>LIBERAR PARA O CLIENTE</button>}
 {v.estado_edicao === 'AGUARDANDO_CLIENTE' && <p><a href={`/contrato/${cid}`} target="_blank" rel="noreferrer">Abrir acesso público do cliente</a></p>}
 <h2>Assinaturas e comprovantes</h2>{signatures.map(s => <p key={s.id}>{s.parte}: {s.identidade_snapshot.nome} · {new Date(s.assinado_em).toLocaleString('pt-BR')} · <a target="_blank" rel="noreferrer" href={docUrl(s.comprovante_documento_id)}>Comprovante</a></p>)}
 {v.documento_revisado_id && <a target="_blank" rel="noreferrer" href={`/admin/contratos/imprimir?contratoId=${cid}&versaoId=${vid}`}>Imprimir contrato completo — V{v.numero_versao}</a>}
 <section id="financeiro" tabIndex={-1} aria-label="Financeiro" className={`${styles.anchor} ${destino==='#financeiro'?styles.financialAnchor:''}`}>{data.financeiro.length?<FinanceiroContrato key={`${cid}:${data.fluxo?.versao_vigente_id}`} contratoId={cid} onReady={financeiroCarregado}/>:<CriarPlanoFinanceiro key={financeiroKey} contexto={contextoCriacao(data)} onCreated={async()=>{await load(cid,vid);window.location.hash='financeiro';}}/>}</section>
 
 </>}
 </main>;
}
function valorDiferenca(value:unknown,campo=''):string {if(typeof value==='number' && /\.valor[A-Z]/.test(campo))return formatarMoeda(value);if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value))return value.split('-').reverse().join('/');if(value==null || value==='')return 'Não informado';if(Array.isArray(value))return value.length?value.map(x=>typeof x==='object'&&x?'nome' in x?`${x.nome} (${x.quantidade})`:JSON.stringify(x):String(x)).join(', '):'Nenhum';if(typeof value==='object')return Object.values(value).map(x=>valorDiferenca(x)).join(' · ');return String(value);}
function rotuloCampo(campo:string):string {const labels:Record<string,string>={'evento.pacote.nome':'Pacote','evento.convidados':'Convidados','evento.convidadosFaturados':'Convidados faturados','comercial.valorPacoteBase':'Valor base do pacote','comercial.valorPacoteAplicado':'Valor aplicado ao pacote','comercial.valorBaseComercial':'Base comercial','evento.data':'Data','evento.horarioInicio':'Início','evento.horarioFim':'Fim','comercial.valorFinalContrato':'Valor contratual','comercial.valorTabela':'Valor de tabela','comercial.formaPagamentoPretendida':'Forma de pagamento','contratacao.adicionais':'Adicionais','documental.observacoes':'Observações documentais'};return labels[campo] ?? campo.replaceAll('.', ' / ').replace(/([a-z])([A-Z])/g,'$1 $2');}
