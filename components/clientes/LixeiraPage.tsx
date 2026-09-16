'use client';
import { useEffect,useState } from 'react';
import Link from 'next/link';
import ClienteLixeira,{lerLixeira,type RegistroLixeira} from './ClienteLixeira';
import styles from './Clientes.module.css';
export default function LixeiraPage(){
    const [itens,setItens]=useState<RegistroLixeira[]>([]),[offset,setOffset]=useState(0),[versao,setVersao]=useState(0),[erro,setErro]=useState(''),[carregando,setCarregando]=useState(true);
    useEffect(()=>{let ativo=true;lerLixeira(`/api/admin/clientes/lixeira?offset=${offset}`).then(d=>{if(ativo){setItens(d);setErro('');setCarregando(false);}}).catch(e=>{if(ativo){setErro(e.message);setCarregando(false);}});return()=>{ativo=false;};},[offset,versao]);
    function atualizar(){setCarregando(true);setVersao(v=>v+1);}
    return <main className={styles.page}><div className={styles.shell}><Link href="/clientes">← Clientes</Link><h1>Lixeira / Arquivados</h1><p>Os cadastros e seus vínculos são preservados. Não existe exclusão física automática.</p>
        {erro&&<p role="alert">{erro} <button onClick={atualizar}>Tentar novamente</button></p>}
        {carregando?<p>Carregando…</p>:!erro&&<>{!itens.length&&<p>Nenhum cliente na lixeira ou arquivado.</p>}{itens.map(item=><article key={item.id+item.atualizadoEm} className={styles.profileCard}><h2><Link href={`/clientes/${item.id}`}>{item.nome}</Link></h2><p>{item.contato} {item.email}</p><ClienteLixeira clienteId={item.id} registro={item} onAlterado={atualizar}/>{item.retencao90Dias&&<p>90 dias decorridos: elegível para avaliação de purga futura. Nenhum dado será apagado automaticamente.</p>}</article>)}</>}
        <button className={styles.secondaryButton} disabled={offset===0||carregando} onClick={()=>{setCarregando(true);setOffset(o=>Math.max(0,o-50));}}>Anterior</button><button className={styles.secondaryButton} disabled={itens.length<50||carregando||!!erro} onClick={()=>{setCarregando(true);setOffset(o=>o+50);}}>Próxima página</button>
    </div></main>;
}
