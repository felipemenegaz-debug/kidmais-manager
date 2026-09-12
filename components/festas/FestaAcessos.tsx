'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {adminFetch} from '@/lib/http/admin-fetch';
import {erroHumano} from '@/lib/festas/ux';
import styles from './festa.module.css';
import layout from './acessos.module.css';
type Usuario={id:string;nome:string;perfil:string};
export default function FestaAcessos(){
 const [data,setData]=useState<{usuarioId:string;usuarios:Usuario[]}|null>(null),[erro,setErro]=useState(''),[notice,setNotice]=useState(''),[user,setUser]=useState<Usuario|null>(null),[perfil,setPerfil]=useState('EQUIPE'),[busy,setBusy]=useState(false);
 const editor=useRef<HTMLElement>(null);
 const carregar=useCallback(async()=>{const r=await adminFetch('/api/admin/festas?recurso=perfis'),j=await r.json();if(j.ok)setData(j.data);else setErro(erroHumano(j.erro));},[]);
 useEffect(()=>{let active=true;adminFetch('/api/admin/festas?recurso=perfis').then(r=>r.json()).then(j=>{if(active){if(j.ok)setData(j.data);else setErro(erroHumano(j.erro));}}).catch(()=>{if(active)setErro('Não foi possível carregar os acessos.');});return()=>{active=false;};},[]);
 useEffect(()=>{if(user){editor.current?.scrollIntoView({block:'nearest'});editor.current?.focus();}},[user]);
 async function salvar(e:React.FormEvent<HTMLFormElement>){e.preventDefault();if(!user)return;const fd=new FormData(e.currentTarget);setBusy(true);setErro('');try{const r=await adminFetch('/api/admin/festas?recurso=perfis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuarioId:user.id,perfil,confirmarProprioAcesso:fd.has('proprio')})}),j=await r.json();if(!j.ok){setErro(erroHumano(j.erro));return;}setNotice('Acesso atualizado.');setUser(null);await carregar();}catch{setErro('Não foi possível salvar. Confira os acessos antes de repetir.');}finally{setBusy(false);}}
 return <main className={styles.page}><Link href="/admin/festas">Voltar às festas</Link><h1>Usuários e acessos</h1>{erro&&<p role="alert" className={styles.warning}>{erro}</p>}{notice&&<p role="status" className={styles.success}>{notice}</p>}
 {data&&<><p>Gestão cuida das decisões e correções. Equipe cuida do trabalho diário.</p>
 <table className={layout.lista}><caption className={layout.caption}>Acesso às Festas</caption><thead><tr><th>Usuário</th><th>Acesso</th><th>Ação</th></tr></thead><tbody>{data.usuarios.map(u=><tr key={u.id}><th scope="row">{u.nome}</th><td>{u.perfil}</td><td><button aria-label={'Alterar acesso de '+u.nome} disabled={busy} onClick={()=>{setUser(u);setPerfil(u.perfil==='Gestão'?'GESTAO':'EQUIPE');setNotice('');setErro('');}}>Alterar</button></td></tr>)}</tbody></table>
 <p>A criação de novos usuários é feita pelo provisionamento administrativo no terminal.</p>
 {user&&<section ref={editor} tabIndex={-1} aria-label="Alterar acesso" className={styles.card}><h2>Alterar acesso</h2><p>Nome: <strong>{user.nome}</strong></p><form onSubmit={salvar}><fieldset disabled={busy}><legend>Nível de acesso</legend><label><input name="perfil" type="radio" checked={perfil==='GESTAO'} onChange={()=>setPerfil('GESTAO')}/>Gestão</label><label><input name="perfil" type="radio" checked={perfil==='EQUIPE'} onChange={()=>setPerfil('EQUIPE')}/>Equipe</label></fieldset>{user.id===data.usuarioId&&<label><input name="proprio" type="checkbox" required disabled={busy}/>Você está alterando seu próprio nível de acesso. Deseja continuar?</label>}<div className={styles.actions}><button type="button" disabled={busy} onClick={()=>setUser(null)}>Cancelar</button><button className={styles.primary} disabled={busy}>Salvar</button></div></form></section>}</>}
 </main>;
}
