'use client';
import { useEffect,useRef,useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './Clientes.module.css';

export type RegistroLixeira={id:string;nome:string;status:string;atualizadoEm:string;situacao:string;contato:string|null;email:string|null;quando:string|null;responsavel:string|null;motivo:string|null;retencao90Dias:boolean};
export async function lerLixeira(url:string,init?:RequestInit) {
    const r=await adminFetch(url,init),b=await r.json();
    if(!r.ok||!b.ok)throw Error(b.erro??'Não foi possível atualizar a lixeira.');
    return b.data;
}
export default function ClienteLixeira({clienteId,registro,onAlterado}:{clienteId:string;registro?:RegistroLixeira;onAlterado?:()=>void}) {
    const [item,setItem]=useState<RegistroLixeira|null>(registro??null),[etapa,setEtapa]=useState(0),[modo,setModo]=useState('EXCLUIR'),[motivo,setMotivo]=useState(''),[erro,setErro]=useState(''),[busy,setBusy]=useState(false);
    const pedido=useRef<{intencao:string;chave:string}|null>(null),executando=useRef(false);
    const endpoint=`/api/admin/clientes/${encodeURIComponent(clienteId)}/lixeira`;
    const motivoRef=useRef<HTMLTextAreaElement>(null);
    function validarMotivo(){
        if(motivo.trim().length>=3)return true;
        setErro('Informe o motivo com pelo menos 3 caracteres para continuar.');
        motivoRef.current?.focus();return false;
    }
    useEffect(()=>{if(registro)return;let ativo=true;lerLixeira(endpoint).then(d=>{if(ativo)setItem(d);}).catch(e=>{if(ativo)setErro(e.message);});return()=>{ativo=false;};},[endpoint,registro]);
    async function confirmar(){
        if(!item||executando.current)return;
        if(!validarMotivo())return;
        const acao=item.status==='INATIVO'?'RESTAURAR':modo;
        if(acao!=='RESTAURAR'&&etapa!==2)return;
        const body={acao,motivo:motivo.trim(),atualizadoEm:item.atualizadoEm,...(acao!=='RESTAURAR'?{confirmarRemocao:true,confirmarHistorico:true}:{})};
        const intencao=JSON.stringify(body);if(pedido.current?.intencao!==intencao)pedido.current={intencao,chave:crypto.randomUUID()};
        executando.current=true;setBusy(true);setErro('');
        try {await lerLixeira(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,chave:pedido.current.chave})});setItem(await lerLixeira(endpoint));setEtapa(0);setMotivo('');pedido.current=null;onAlterado?.();}
        catch(e){setErro(e instanceof Error?e.message:'Falha na operação.');}finally{executando.current=false;setBusy(false);}
    }
    return <section className={styles.lixeiraPanel} aria-label="Situação do cadastro">
        {erro&&<p role="alert">{erro} <button type="button" onClick={()=>{lerLixeira(endpoint).then(d=>{setItem(d);setErro('');setEtapa(0);}).catch(e=>setErro(e.message));}}>Recarregar situação</button></p>}
        {item&&<><strong>{item.situacao}</strong>{item.status==='INATIVO'&&<p>Histórico e vínculos preservados. {item.quando?new Date(item.quando).toLocaleString('pt-BR'):'Data de arquivamento não registrada'} · {item.responsavel??'Responsável não registrado'} · {item.motivo??'Cadastro inativo anterior à lixeira'}</p>}
        {etapa===0&&item.status!=='MESCLADO'&&<button className={styles.secondaryButton} type="button" onClick={()=>setEtapa(1)}>{item.status==='INATIVO'?'Restaurar cliente':'Excluir / Arquivar cliente'}</button>}
        {etapa>0&&<div role="group" aria-label="Confirmação de alteração do cadastro">
            {item.status==='ATIVO'&&etapa===1&&<><p>Deseja realmente remover este cliente da lista ativa?</p><label>Ação <select value={modo} onChange={e=>setModo(e.target.value)}><option value="EXCLUIR">Excluir — cadastro errado, teste ou duplicado</option><option value="ARQUIVAR">Arquivar — cliente legítimo inativo</option></select></label></>}
            {item.status==='INATIVO'&&<p>Restaurar este cliente com o mesmo ID e histórico?</p>}
            <label className={styles.textareaField}>Motivo obrigatório (mínimo de 3 caracteres) <textarea ref={motivoRef} required minLength={3} maxLength={500} value={motivo} disabled={busy||etapa===2} onChange={e=>setMotivo(e.target.value)}/></label>
            {etapa===2&&<div aria-label="Resumo da confirmação"><p>Cliente: <strong>{item.nome}</strong></p><p>Ação: {modo==='EXCLUIR'?'Excluir logicamente':'Arquivar'}</p><p>Motivo: {motivo.trim()}</p></div>}
            {etapa===2&&<p>{modo==='EXCLUIR'?'Este cliente será movido para a lixeira e poderá ser restaurado. O histórico de contratos, pagamentos, festas e fechamentos será preservado.':'Este cliente será arquivado e poderá ser restaurado. O histórico de contratos, pagamentos, festas e fechamentos será preservado.'}</p>}
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>{setEtapa(0);setErro('');setMotivo('');pedido.current=null;}}>Cancelar</button>
            {item.status==='ATIVO'&&etapa===1?<button type="button" className={styles.primaryButton} disabled={busy} onClick={()=>{if(validarMotivo()){setErro('');setEtapa(2);}}}>Continuar para segunda confirmação</button>:<button type="button" className={styles.primaryButton} disabled={busy} onClick={confirmar}>{busy?'Salvando…':item.status==='INATIVO'?'Restaurar cliente':modo==='EXCLUIR'?'Confirmar exclusão lógica':'Confirmar arquivamento'}</button>}
        </div>}</>}
    </section>;
}
