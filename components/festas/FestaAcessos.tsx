'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {adminFetch} from '@/lib/http/admin-fetch';
import {erroHumano} from '@/lib/festas/ux';
import styles from './festa.module.css';
import layout from './acessos.module.css';

type Conta={id:string;nome:string;email:string;nivelSistema:string;ativo:boolean};
type PerfilFesta={id:string;nome:string;nivelSistema:string;perfil:string};
type ContasData={usuarioId:string;usuarios:Conta[]};
type PerfissData={usuarioId:string;usuarios:PerfilFesta[]};

export default function FestaAcessos(){
 const [contas,setContas]=useState<ContasData|null>(null);
 const [perfis,setPerfis]=useState<PerfissData|null>(null);
 const [erro,setErro]=useState('');
 const [notice,setNotice]=useState('');
 const [user,setUser]=useState<PerfilFesta|null>(null);
 const [alvoDesativar,setAlvoDesativar]=useState<Conta|null>(null);
 const [perfil,setPerfil]=useState('EQUIPE');
 const [nivel,setNivel]=useState<'GESTAO'|'EQUIPE'>('EQUIPE');
 const [busy,setBusy]=useState(false);
 const editor=useRef<HTMLElement>(null);
 const desativarRef=useRef<HTMLElement>(null);

 const carregar=useCallback(async()=>{
  const [contasRes,perfisRes]=await Promise.all([
   adminFetch('/api/admin/configuracoes/usuarios'),
   adminFetch('/api/admin/festas?recurso=perfis'),
  ]);
  const contasJson=await contasRes.json();
  const perfisJson=await perfisRes.json();
  if(!contasJson.ok){setErro(erroHumano(contasJson.erro));return;}
  if(!perfisJson.ok){setErro(erroHumano(perfisJson.erro));return;}
  setContas(contasJson.data);
  setPerfis(perfisJson.data);
 },[]);

 useEffect(()=>{
  let active=true;
  Promise.all([
   adminFetch('/api/admin/configuracoes/usuarios'),
   adminFetch('/api/admin/festas?recurso=perfis'),
  ]).then(async([contasRes,perfisRes])=>{
   if(!active)return;
   const contasJson=await contasRes.json();
   const perfisJson=await perfisRes.json();
   if(!active)return;
   if(!contasJson.ok){setErro(erroHumano(contasJson.erro));return;}
   if(!perfisJson.ok){setErro(erroHumano(perfisJson.erro));return;}
   setContas(contasJson.data);
   setPerfis(perfisJson.data);
  }).catch(()=>{if(active)setErro('Não foi possível carregar os acessos.');});
  return()=>{active=false;};
 },[]);
 useEffect(()=>{if(user){editor.current?.scrollIntoView({block:'nearest'});editor.current?.focus();}},[user]);
 useEffect(()=>{if(alvoDesativar){desativarRef.current?.scrollIntoView({block:'nearest'});desativarRef.current?.focus();}},[alvoDesativar]);

 async function salvarFesta(e:React.FormEvent<HTMLFormElement>){
  e.preventDefault();if(!user)return;
  const fd=new FormData(e.currentTarget);
  setBusy(true);setErro('');
  try{
   const r=await adminFetch('/api/admin/festas?recurso=perfis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuarioId:user.id,perfil,confirmarProprioAcesso:fd.has('proprio')})});
   const j=await r.json();
   if(!j.ok){setErro(erroHumano(j.erro));return;}
   setNotice('Acesso às Festas atualizado. O papel no sistema permanece o mesmo.');
   setUser(null);
   await carregar();
  }catch{setErro('Não foi possível salvar. Confira os acessos antes de repetir.');}
  finally{setBusy(false);}
 }

 async function criar(e:React.FormEvent<HTMLFormElement>){
  e.preventDefault();
  const form=e.currentTarget;
  const fd=new FormData(form);
  const senha=String(fd.get('senha')??'');
  const confirmacao=String(fd.get('confirmacao')??'');
  if(senha!==confirmacao){setErro('A senha e a confirmação não conferem.');return;}
  setBusy(true);setErro('');
  try{
   const r=await adminFetch('/api/admin/configuracoes/usuarios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    acao:'criar',
    nome:String(fd.get('nome')??''),
    email:String(fd.get('email')??''),
    nivel,
    senha,
    confirmacao,
   })});
   const j=await r.json();
   if(!j.ok){setErro(erroHumano(j.erro));return;}
   setNotice('Conta criada com o acesso às Festas do nível escolhido.');
   form.reset();
   setNivel('EQUIPE');
   await carregar();
  }catch{setErro('Não foi possível criar a conta. Confira os dados e tente novamente.');}
  finally{setBusy(false);}
 }

 async function desativar(e:React.FormEvent<HTMLFormElement>){
  e.preventDefault();if(!alvoDesativar)return;
  setBusy(true);setErro('');
  try{
   const r=await adminFetch('/api/admin/configuracoes/usuarios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'desativar',usuarioId:alvoDesativar.id,confirmar:true})});
   const j=await r.json();
   if(!j.ok){setErro(erroHumano(j.erro));return;}
   setNotice('Conta desativada. Sessões encerradas; o histórico foi preservado.');
   setAlvoDesativar(null);
   await carregar();
  }catch{setErro('Não foi possível desativar a conta. Atualize a lista e tente novamente.');}
  finally{setBusy(false);}
 }

 const ativas=contas?.usuarios.filter(u=>u.ativo)??[];
 const desativadas=contas?.usuarios.filter(u=>!u.ativo)??[];

 return <main className={styles.page}>
  <Link href="/admin/configuracoes">Voltar às configurações</Link>
  <h1>Usuários e acessos</h1>
  {erro&&<p role="alert" className={styles.warning}>{erro}</p>}
  {notice&&<p role="status" className={styles.success}>{notice}</p>}
  {contas&&perfis&&<>
   <p>O nível escolhido na criação define o papel administrativo e o acesso inicial às Festas. Depois, alterar o acesso às Festas não muda o papel.</p>
   <section className={styles.card} aria-labelledby="criar-titulo">
    <h2 id="criar-titulo">Criar usuário</h2>
    <form onSubmit={criar}>
     <fieldset disabled={busy}>
      <label>Nome<input name="nome" autoComplete="name" required maxLength={120}/></label>
      <label>E-mail<input name="email" type="email" autoComplete="username" required maxLength={254}/></label>
      <fieldset>
       <legend>Papel no sistema</legend>
       <label><input name="nivel" type="radio" checked={nivel==='GESTAO'} onChange={()=>setNivel('GESTAO')} aria-label="Papel no sistema: Gestão"/>Gestão</label>
       <label><input name="nivel" type="radio" checked={nivel==='EQUIPE'} onChange={()=>setNivel('EQUIPE')} aria-label="Papel no sistema: Equipe"/>Equipe</label>
      </fieldset>
      <label>Senha inicial<input name="senha" type="password" autoComplete="new-password" required minLength={8} maxLength={128}/></label>
      <label>Confirme a senha inicial<input name="confirmacao" type="password" autoComplete="new-password" required minLength={8} maxLength={128}/></label>
     </fieldset>
     <div className={styles.actions}><button className={styles.primary} disabled={busy}>Criar conta</button></div>
    </form>
   </section>

   <table className={layout.lista}>
    <caption className={layout.caption}>Contas ativas</caption>
    <thead><tr><th>Usuário</th><th>E-mail</th><th>Papel no sistema</th><th>Ação</th></tr></thead>
    <tbody>{ativas.map(u=><tr key={u.id}>
     <th scope="row">{u.nome}</th>
     <td>{u.email}</td>
     <td>{u.nivelSistema}</td>
     <td>{u.id===contas.usuarioId
      ? <span className={styles.muted}>Sua conta</span>
      : <button type="button" aria-label={'Desativar conta de '+u.nome} disabled={busy} onClick={()=>{setAlvoDesativar(u);setUser(null);setNotice('');setErro('');}}>Desativar</button>}</td>
    </tr>)}</tbody>
   </table>

   <table className={layout.lista}>
    <caption className={layout.caption}>Contas desativadas</caption>
    <thead><tr><th>Usuário</th><th>E-mail</th><th>Papel no sistema</th><th>Situação</th></tr></thead>
    <tbody>{desativadas.length===0
     ? <tr><td colSpan={4}>Nenhuma conta desativada.</td></tr>
     : desativadas.map(u=><tr key={u.id}><th scope="row">{u.nome}</th><td>{u.email}</td><td>{u.nivelSistema}</td><td>Desativada</td></tr>)}</tbody>
   </table>

   <table className={layout.lista}>
    <caption className={layout.caption}>Acesso às Festas</caption>
    <thead><tr><th>Usuário</th><th>Papel no sistema</th><th>Acesso às Festas</th><th>Ação</th></tr></thead>
    <tbody>{perfis.usuarios.map(u=><tr key={u.id}>
     <th scope="row">{u.nome}</th>
     <td>{u.nivelSistema}</td>
     <td>{u.perfil}</td>
     <td><button type="button" aria-label={'Alterar acesso de '+u.nome} disabled={busy} onClick={()=>{setUser(u);setPerfil(u.perfil==='Gestão'?'GESTAO':'EQUIPE');setAlvoDesativar(null);setNotice('');setErro('');}}>Alterar</button></td>
    </tr>)}</tbody>
   </table>

   {user&&<section ref={editor} tabIndex={-1} aria-label="Alterar acesso" className={styles.card}>
    <h2>Alterar acesso às Festas</h2>
    <p>Nome: <strong>{user.nome}</strong></p>
    <p>Papel no sistema: <strong>{user.nivelSistema}</strong> — esta alteração não muda o papel.</p>
    <form onSubmit={salvarFesta}>
     <fieldset disabled={busy}>
      <legend>Acesso às Festas</legend>
      <label><input name="perfil" type="radio" checked={perfil==='GESTAO'} onChange={()=>setPerfil('GESTAO')}/>Gestão</label>
      <label><input name="perfil" type="radio" checked={perfil==='EQUIPE'} onChange={()=>setPerfil('EQUIPE')}/>Equipe</label>
     </fieldset>
     {user.id===perfis.usuarioId&&<label><input name="proprio" type="checkbox" required disabled={busy}/>Você está alterando seu próprio nível de acesso. Deseja continuar?</label>}
     <div className={styles.actions}>
      <button type="button" disabled={busy} onClick={()=>setUser(null)}>Cancelar</button>
      <button className={styles.primary} disabled={busy}>Salvar</button>
     </div>
    </form>
   </section>}

   {alvoDesativar&&<section ref={desativarRef} tabIndex={-1} aria-label="Desativar conta" className={styles.card}>
    <h2>Desativar conta</h2>
    <p>Nome: <strong>{alvoDesativar.nome}</strong></p>
    <p>A pessoa perde o login. Sessões abertas são encerradas. Registros e auditoria permanecem.</p>
    <form onSubmit={desativar}>
     <label><input name="confirmar" type="checkbox" required disabled={busy}/>Confirmo desativar a conta de {alvoDesativar.nome}.</label>
     <div className={styles.actions}>
      <button type="button" disabled={busy} onClick={()=>setAlvoDesativar(null)}>Cancelar</button>
      <button className={styles.primary} disabled={busy}>Desativar conta</button>
     </div>
    </form>
   </section>}
  </>}
 </main>;
}
