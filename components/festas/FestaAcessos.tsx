'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {adminFetch} from '@/lib/http/admin-fetch';
import {erroHumano} from '@/lib/festas/ux';
import layout from './acessos.module.css';
import {AdminPrimaryButton} from '@/components/admin/AdminPrimaryButton';
import {VoltarConfiguracoes} from '@/components/admin/VoltarConfiguracoes';

type Conta={id:string;nome:string;email:string;nivelSistema:string;ativo:boolean;podeAssinar?:boolean};
type PerfilFesta={id:string;nome:string;nivelSistema:string;perfil:string};
type Convite={id:string;email:string;nomeSugerido:string|null;nivel:string;situacao:'PENDENTE'|'EXPIRADO'|'ACEITO'|'CANCELADO';expiraEm:string};
// E1: convites == null quando o ambiente ainda não tem convites (063); criacaoDireta = senha definida pela Gestão ainda permitida.
type ContasData={usuarioId:string;usuarios:Conta[];convites?:Convite[]|null;criacaoDireta?:boolean};
type Envio={enviado:boolean;destino:string;motivo?:string};
type Modo='convite'|'senha';

function avisoEnvio(envio:Envio){
 return envio.enviado
  ?'Convite enviado para '+envio.destino+'. Ele vale por 7 dias; a pessoa define a própria senha ao aceitar.'
  :'Convite criado, mas o e-mail não foi enviado: '+(envio.motivo??'motivo desconhecido')+' Use “Reenviar” quando o envio estiver disponível.';
}

function dataCurta(iso:string){
 const d=new Date(iso);
 return Number.isNaN(d.getTime())?'':d.toLocaleDateString('pt-BR');
}
type PerfissData={usuarioId:string;usuarios:PerfilFesta[]};
type Aba='ativas'|'desativadas';

function iniciais(nome:string){
 const partes=nome.trim().split(/\s+/).filter(Boolean);
 const a=partes[0]?.[0]??'';
 const b=partes[1]?.[0]??'';
 return (a+b).toUpperCase()||'?';
}

function acessoFestas(conta:Conta,perfis:PerfilFesta[]){
 return perfis.find(p=>p.id===conta.id)?.perfil??(conta.ativo?'Sem acesso':'—');
}

export default function FestaAcessos(){
 const [contas,setContas]=useState<ContasData|null>(null);
 const [perfis,setPerfis]=useState<PerfissData|null>(null);
 const [erro,setErro]=useState('');
 const [notice,setNotice]=useState('');
 const [user,setUser]=useState<PerfilFesta|null>(null);
 const [alvoDesativar,setAlvoDesativar]=useState<Conta|null>(null);
 const [criarAberto,setCriarAberto]=useState(false);
 const [aba,setAba]=useState<Aba>('ativas');
 const [busca,setBusca]=useState('');
 const [menuId,setMenuId]=useState<string|null>(null);
 const [perfil,setPerfil]=useState('EQUIPE');
 const [nivel,setNivel]=useState<'GESTAO'|'EQUIPE'>('EQUIPE');
 const [modo,setModo]=useState<Modo>('convite');
 const [emailErro,setEmailErro]=useState('');
 const [senhaErro,setSenhaErro]=useState('');
 const [verSenha,setVerSenha]=useState(false);
 const [compacto,setCompacto]=useState(false);
 const [busy,setBusy]=useState(false);
 const editor=useRef<HTMLElement>(null);
 const desativarRef=useRef<HTMLElement>(null);
 const criarRef=useRef<HTMLElement>(null);
 const menuRef=useRef<HTMLDivElement>(null);
 const nomeRef=useRef<HTMLInputElement>(null);

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

 useEffect(()=>{if(user){editor.current?.focus();}},[user]);
 useEffect(()=>{if(alvoDesativar){desativarRef.current?.focus();}},[alvoDesativar]);
 useEffect(()=>{if(criarAberto){nomeRef.current?.focus();}},[criarAberto]);

 useEffect(()=>{
  const aberto=Boolean(user||alvoDesativar||criarAberto);
  document.body.style.overflow=aberto?'hidden':'';
  return()=>{document.body.style.overflow='';};
 },[user,alvoDesativar,criarAberto]);

 useEffect(()=>{
  if(!menuId)return;
  function fechar(ev:MouseEvent){
   if(menuRef.current&&!menuRef.current.contains(ev.target as Node))setMenuId(null);
  }
  document.addEventListener('mousedown',fechar);
  return()=>document.removeEventListener('mousedown',fechar);
 },[menuId]);

 useEffect(()=>{
  const mq=window.matchMedia('(max-width:800px)');
  const aplicar=()=>setCompacto(mq.matches);
  aplicar();
  mq.addEventListener('change',aplicar);
  return()=>mq.removeEventListener('change',aplicar);
 },[]);

 useEffect(()=>{
  function tecla(ev:KeyboardEvent){
   if(ev.key!=='Escape'||busy)return;
   if(menuId){setMenuId(null);return;}
   if(alvoDesativar){setAlvoDesativar(null);return;}
   if(user){setUser(null);return;}
   if(criarAberto){
    setCriarAberto(false);
    setEmailErro('');
    setSenhaErro('');
    setNivel('EQUIPE');
    setVerSenha(false);
   }
  }
  document.addEventListener('keydown',tecla);
  return()=>document.removeEventListener('keydown',tecla);
 },[menuId,alvoDesativar,user,criarAberto,busy]);

 useEffect(()=>{
  const root=criarAberto?criarRef.current:user?editor.current:alvoDesativar?desativarRef.current:null;
  if(!root)return;
  function trap(ev:KeyboardEvent){
   if(ev.key!=='Tab'||!root)return;
   const lista=[...root.querySelectorAll<HTMLElement>('a,button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el=>!el.hasAttribute('disabled')&&el.getAttribute('aria-hidden')!=='true');
   if(!lista.length)return;
   const first=lista[0],last=lista[lista.length-1];
   if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus();}
   else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus();}
  }
  root.addEventListener('keydown',trap);
  return()=>root.removeEventListener('keydown',trap);
 },[criarAberto,user,alvoDesativar]);

 function fecharCriar(){
  if(busy)return;
  setCriarAberto(false);
  setEmailErro('');
  setSenhaErro('');
  setNivel('EQUIPE');
  setVerSenha(false);
 }

 function abrirCriar(){
  setModo(convitesDisponiveis?'convite':'senha');
  setCriarAberto(true);
  setUser(null);
  setAlvoDesativar(null);
  setMenuId(null);
  setErro('');
  setEmailErro('');
  setSenhaErro('');
 }

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
  setEmailErro('');
  setSenhaErro('');
  if(senha!==confirmacao){setSenhaErro('A senha e a confirmação não conferem.');return;}
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
   if(!j.ok){
    const humano=erroHumano(j.erro);
    if(r.status===409){setEmailErro(humano);return;}
    setErro(humano);
    return;
   }
   // F2: a resposta é a mesma para e-mail novo ou já usado no Kidmais; a tela não diz qual foi o caso.
   setNotice('Acesso a esta empresa concedido. Se a pessoa já usa o Kidmais, ela entra com a senha que já tem.');
   form.reset();
   fecharCriar();
   setAba('ativas');
   await carregar();
  }catch{setErro('Não foi possível criar a conta. Confira os dados e tente novamente.');}
  finally{setBusy(false);}
 }

 // E1: convite por e-mail. A pessoa define a própria senha (conta nova) ou confirma com a senha que já tem.
 async function convidar(e:React.FormEvent<HTMLFormElement>){
  e.preventDefault();
  const form=e.currentTarget;
  const fd=new FormData(form);
  const nome=String(fd.get('nome')??'').trim();
  setEmailErro('');
  setBusy(true);setErro('');
  try{
   const r=await adminFetch('/api/admin/configuracoes/usuarios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    acao:'convidar',
    email:String(fd.get('email')??''),
    nome:nome||null,
    nivel,
   })});
   const j=await r.json();
   if(!j.ok){
    const humano=erroHumano(j.erro);
    if(r.status===409){setEmailErro(humano);return;}
    setErro(humano);
    return;
   }
   setNotice(avisoEnvio(j.data.envio));
   form.reset();
   fecharCriar();
   await carregar();
  }catch{setErro('Não foi possível criar o convite. Confira os dados e tente novamente.');}
  finally{setBusy(false);}
 }

 async function alterarConvite(convite:Convite,acao:'reenviar-convite'|'cancelar-convite'){
  setBusy(true);setErro('');setNotice('');
  try{
   const r=await adminFetch('/api/admin/configuracoes/usuarios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao,conviteId:convite.id})});
   const j=await r.json();
   if(!j.ok){setErro(erroHumano(j.erro));return;}
   setNotice(acao==='cancelar-convite'?'Convite cancelado. O link enviado deixou de valer.':avisoEnvio(j.data.envio));
   await carregar();
  }catch{setErro('Não foi possível atualizar o convite. Atualize a lista e tente novamente.');}
  finally{setBusy(false);}
 }

 // 057: assinar contratos em nome DESTA empresa (capability da membership). Não é acesso de plataforma.
 async function alternarAssinatura(conta:Conta){
  setMenuId(null);setBusy(true);setErro('');setNotice('');
  try{
   const conceder=!conta.podeAssinar;
   const r=await adminFetch('/api/admin/configuracoes/usuarios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'assinatura',usuarioId:conta.id,conceder})});
   const j=await r.json();
   if(!j.ok){setErro(erroHumano(j.erro));return;}
   setNotice(conceder?'Esta pessoa pode assinar contratos em nome desta empresa.':'Esta pessoa não assina mais contratos em nome desta empresa.');
   await carregar();
  }catch{setErro('Não foi possível alterar a assinatura de contratos. Atualize a lista e tente novamente.');}
  finally{setBusy(false);}
 }

 async function desativar(e:React.FormEvent<HTMLFormElement>){
  e.preventDefault();if(!alvoDesativar)return;
  setBusy(true);setErro('');
  try{
   const r=await adminFetch('/api/admin/configuracoes/usuarios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'remover',usuarioId:alvoDesativar.id,confirmar:true})});
   const j=await r.json();
   if(!j.ok){setErro(erroHumano(j.erro));return;}
   setNotice('Acesso a esta empresa removido. A conta, o histórico e o acesso a outras empresas foram preservados.');
   setAlvoDesativar(null);
   setAba('desativadas');
   await carregar();
  }catch{setErro('Não foi possível remover o acesso. Atualize a lista e tente novamente.');}
  finally{setBusy(false);}
 }

 const convitesDisponiveis=Array.isArray(contas?.convites);
 const criacaoDireta=contas?.criacaoDireta!==false;
 const pendentes=(contas?.convites??[]).filter(c=>c.situacao==='PENDENTE'||c.situacao==='EXPIRADO');
 const lista=contas?.usuarios??[];
 const termo=busca.trim().toLowerCase();
 const daAba=lista.filter(u=>aba==='ativas'?u.ativo:!u.ativo);
 const filtradas=daAba.filter(u=>!termo||u.nome.toLowerCase().includes(termo)||u.email.toLowerCase().includes(termo));
 const festaPorId=perfis?.usuarios??[];

 function acoes(conta:Conta){
  if(!conta.ativo)return null;
  const festa=festaPorId.find(p=>p.id===conta.id)??{id:conta.id,nome:conta.nome,nivelSistema:conta.nivelSistema,perfil:'Sem acesso'};
  const propria=conta.id===contas?.usuarioId;
  return <div className={layout.menuWrap} ref={menuId===conta.id?menuRef:undefined}>
   <button type="button" className={layout.iconBtn} aria-haspopup="menu" aria-expanded={menuId===conta.id} aria-label={'Ações de '+conta.nome} disabled={busy} onClick={()=>setMenuId(id=>id===conta.id?null:conta.id)}>
    <span aria-hidden="true">⋮</span>
   </button>
   {menuId===conta.id&&<div className={layout.menu} role="menu">
    <button type="button" role="menuitem" aria-label={'Alterar acesso de '+conta.nome} disabled={busy} onClick={()=>{setUser(festa);setPerfil(festa.perfil==='Gestão'?'GESTAO':'EQUIPE');setAlvoDesativar(null);setCriarAberto(false);setMenuId(null);setNotice('');setErro('');}}>Alterar acesso às Festas</button>
    {conta.nivelSistema==='Gestão'&&<button type="button" role="menuitem" aria-label={(conta.podeAssinar?'Retirar assinatura de contratos de ':'Permitir assinar contratos: ')+conta.nome} disabled={busy} onClick={()=>{void alternarAssinatura(conta);}}>{conta.podeAssinar?'Retirar assinatura de contratos':'Permitir assinar contratos'}</button>}
    {!propria&&<button type="button" role="menuitem" className={layout.menuDanger} aria-label={'Remover desta empresa: '+conta.nome} disabled={busy} onClick={()=>{setAlvoDesativar(conta);setUser(null);setCriarAberto(false);setMenuId(null);setNotice('');setErro('');}}>Remover desta empresa</button>}
   </div>}
  </div>;
 }

 function cartao(conta:Conta){
  const propria=conta.id===contas?.usuarioId;
  return <li key={conta.id}>
   <article className={conta.ativo?layout.card:layout.cardMuted}>
    <div className={layout.cardHead}>
     <span className={conta.ativo?layout.avatar:layout.avatarMuted} aria-hidden="true">{iniciais(conta.nome)}</span>
     <div className={layout.identidade}>
      <p className={layout.nome}>{conta.nome}{propria&&<span className={layout.voce}>Você</span>}</p>
      <p className={layout.email}>{conta.email}</p>
     </div>
     {acoes(conta)}
    </div>
    <dl className={layout.tiles}>
     <div className={conta.ativo?layout.tile:layout.tileMuted}><dt>Papel nesta empresa</dt><dd>{conta.nivelSistema}</dd></div>
     <div className={conta.ativo?layout.tile:layout.tileMuted}><dt>Acesso Festas</dt><dd>{acessoFestas(conta,festaPorId)}</dd></div>
     <div className={conta.ativo?layout.tile:layout.tileMuted}><dt>Assina contratos</dt><dd>{conta.ativo&&conta.podeAssinar?'Sim, por esta empresa':'Não'}</dd></div>
    </dl>
    {!conta.ativo&&<p className={layout.situacao}><span className={layout.pontoMuted} aria-hidden="true"/>Removida desta empresa</p>}
   </article>
  </li>;
 }

 const avisoDesativadas=<p className={layout.info}><span className={layout.infoIcon} aria-hidden="true">i</span>Estas pessoas não acessam mais esta empresa. A conta, os registros anteriores e o acesso a outras empresas foram mantidos. Readmitir ou excluir definitivamente uma pessoa removida ainda não está disponível por esta tela.</p>;

 return <main className={layout.shell}>
  <VoltarConfiguracoes/>
  <div className={layout.topo}>
   <div>
    <h1>Usuários e acessos</h1>
    <p className={layout.intro}>Aqui aparecem só as pessoas desta empresa. O papel nesta empresa é separado do acesso às Festas, e o acesso a outras empresas não muda por aqui.</p>
   </div>
   <AdminPrimaryButton className={layout.cta} disabled={busy||!contas||(!convitesDisponiveis&&!criacaoDireta)} onClick={abrirCriar}>+ Adicionar pessoa</AdminPrimaryButton>
  </div>
  {erro&&<p role="alert" className={layout.alerta}>{erro}</p>}
  {notice&&<p role="status" className={layout.sucesso}><span><span className={layout.check} aria-hidden="true">✓</span>{notice}</span><button type="button" className={layout.fecharNotice} aria-label="Dispensar aviso" onClick={()=>setNotice('')}>×</button></p>}
  {contas&&perfis&&<>
   {!compacto&&aba==='desativadas'&&avisoDesativadas}
   <section className={layout.painel} aria-labelledby="lista-titulo">
    <h2 id="lista-titulo" className={layout.srOnly}>Lista de pessoas</h2>
    <div className={layout.ferramentas}>
     <div className={layout.abas} role="tablist" aria-label="Situação das contas">
      <button type="button" role="tab" aria-selected={aba==='ativas'} className={aba==='ativas'?layout.abaAtiva:layout.aba} onClick={()=>setAba('ativas')}>Ativas</button>
      <button type="button" role="tab" aria-selected={aba==='desativadas'} className={aba==='desativadas'?layout.abaAtiva:layout.aba} onClick={()=>setAba('desativadas')}>Removidas</button>
     </div>
     <label className={layout.busca}>
      <span className={layout.srOnly}>Buscar por nome ou e-mail</span>
      <span className={layout.lupa} aria-hidden="true"/>
      <input value={busca} onChange={e=>setBusca(e.target.value)} placeholder="Buscar por nome ou e-mail" autoComplete="off"/>
      {busca&&<button type="button" className={layout.limparInput} aria-label="Limpar busca" onClick={()=>setBusca('')}>×</button>}
     </label>
    </div>
    {compacto&&aba==='desativadas'&&avisoDesativadas}
    {filtradas.length===0
     ? <div className={layout.vazio}>
      <span className={layout.vazioIcone} aria-hidden="true"/>
      <p className={layout.vazioTitulo}>{termo?(compacto?'Nenhum resultado':'Nenhum resultado encontrado'):'Nenhuma pessoa nesta lista.'}</p>
      {termo
       ? <p>Não encontramos ninguém com o termo “{busca.trim()}”.{compacto?'':' Tente buscar por outro nome ou e-mail.'}</p>
       : <p>{aba==='desativadas'?'Nenhuma pessoa removida desta empresa.':'Ainda não há pessoas ativas para exibir.'}</p>}
      {termo&&<button type="button" className={layout.ghost} onClick={()=>setBusca('')}>Limpar busca</button>}
     </div>
     : compacto
      ? <ul className={layout.cards}>{filtradas.map(cartao)}</ul>
      : <div className={layout.tabelaWrap}>
       <table className={layout.lista}>
        <caption className={layout.srOnly}>{aba==='ativas'?'Contas ativas':'Pessoas removidas desta empresa'}</caption>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Papel nesta empresa</th><th>Acesso às Festas</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>{filtradas.map(conta=>{
         const propria=conta.id===contas.usuarioId;
         return <tr key={conta.id} className={conta.ativo?undefined:layout.linhaMuted}>
          <th scope="row"><span className={conta.ativo?layout.avatarSm:layout.avatarSmMuted} aria-hidden="true">{iniciais(conta.nome)}</span>{conta.nome}{propria&&<span className={layout.voce}>Sua conta</span>}</th>
          <td>{conta.email}</td>
          <td><span className={conta.ativo?layout.pill:layout.pillMuted}>{conta.nivelSistema}</span></td>
          <td><span className={conta.ativo?layout.pill:layout.pillMuted}>{acessoFestas(conta,festaPorId)}</span></td>
          <td>{conta.ativo?<span className={layout.ativa}><span className={layout.pontoAtivo} aria-hidden="true"/>Ativa</span>:<span className={layout.desativada}><span className={layout.pontoMuted} aria-hidden="true"/>Removida</span>}</td>
          <td>{acoes(conta)}</td>
         </tr>;
        })}</tbody>
       </table>
      </div>}
   </section>
   {pendentes.length>0&&<section className={layout.painel} aria-labelledby="convites-titulo">
    <h2 id="convites-titulo">Convites pendentes</h2>
    <p className={layout.muted}>A pessoa só entra nesta empresa quando aceita o convite. Reenviar gera um link novo e invalida o anterior.</p>
    <ul className={layout.cards}>{pendentes.map(c=><li key={c.id}>
     <article className={layout.card}>
      <div className={layout.cardHead}>
       <span className={layout.avatar} aria-hidden="true">{iniciais(c.nomeSugerido??c.email)}</span>
       <div className={layout.identidade}>
        <p className={layout.nome}>{c.nomeSugerido??c.email}</p>
        <p className={layout.email}>{c.email}</p>
       </div>
      </div>
      <dl className={layout.tiles}>
       <div className={layout.tile}><dt>Papel nesta empresa</dt><dd>{c.nivel}</dd></div>
       <div className={layout.tile}><dt>Situação</dt><dd>{c.situacao==='EXPIRADO'?'Expirado':'Aguardando aceite até '+dataCurta(c.expiraEm)}</dd></div>
      </dl>
      <div className={layout.modalActions}>
       <button type="button" className={layout.ghost} disabled={busy} aria-label={'Reenviar convite para '+c.email} onClick={()=>{void alterarConvite(c,'reenviar-convite');}}>Reenviar</button>
       <button type="button" className={layout.perigo} disabled={busy} aria-label={'Cancelar convite para '+c.email} onClick={()=>{void alterarConvite(c,'cancelar-convite');}}>Cancelar convite</button>
      </div>
     </article>
    </li>)}</ul>
   </section>}
  </>}

  {criarAberto&&<div className={layout.overlay} onMouseDown={e=>{if(e.target===e.currentTarget)fecharCriar();}}>
   <section ref={criarRef} tabIndex={-1} className={layout.drawer} aria-labelledby="criar-titulo" role="dialog" aria-modal="true">
    <header className={layout.drawerHead}>
     <h2 id="criar-titulo">Adicionar pessoa</h2>
     <button type="button" className={layout.iconBtn} aria-label="Fechar" disabled={busy} onClick={fecharCriar}>×</button>
    </header>
    <form className={layout.drawerForm} onSubmit={modo==='convite'?convidar:criar}>
     <div className={layout.drawerBody}>
      <fieldset disabled={busy}>
       {convitesDisponiveis&&criacaoDireta&&<fieldset className={layout.niveis}>
        <legend>Como adicionar</legend>
        <label className={modo==='convite'?layout.nivelAtivo:layout.nivel}>
         <span><strong>Convidar por e-mail</strong><small>Recomendado. A pessoa aceita e define a própria senha; quem já usa o Kidmais confirma com a senha que tem.</small></span>
         <input name="modo" type="radio" checked={modo==='convite'} onChange={()=>{setModo('convite');setSenhaErro('');}} aria-label="Como adicionar: convidar por e-mail"/>
        </label>
        <label className={modo==='senha'?layout.nivelAtivo:layout.nivel}>
         <span><strong>Definir senha agora</strong><small>Use só enquanto o envio de e-mail não estiver disponível.</small></span>
         <input name="modo" type="radio" checked={modo==='senha'} onChange={()=>setModo('senha')} aria-label="Como adicionar: definir senha agora"/>
        </label>
       </fieldset>}
       <label>{modo==='convite'?'Nome (opcional)':'Nome completo'}<input ref={nomeRef} name="nome" autoComplete="name" required={modo==='senha'} maxLength={120} placeholder="Ex: Maria Souza"/></label>
       <label className={emailErro?layout.campoErro:undefined}>E-mail
        <input name="email" type="email" autoComplete="username" required maxLength={254} placeholder="maria.souza@exemplo.com" aria-invalid={Boolean(emailErro)} aria-describedby={emailErro?'email-erro':undefined} onChange={()=>setEmailErro('')}/>
        {emailErro&&<span id="email-erro" role="alert">{emailErro}</span>}
       </label>
       <fieldset className={layout.niveis}>
        <legend>Papel no sistema</legend>
        <label className={nivel==='EQUIPE'?layout.nivelAtivo:layout.nivel}>
         <span><strong>Equipe</strong><small>Pode consultar e operar as festas. Não administra usuários e acessos.</small></span>
         <input name="nivel" type="radio" checked={nivel==='EQUIPE'} onChange={()=>setNivel('EQUIPE')} aria-label="Papel no sistema: Equipe"/>
        </label>
        <label className={nivel==='GESTAO'?layout.nivelAtivo:layout.nivel}>
         <span><strong>Gestão</strong><small>Tem acesso completo às festas e pode administrar usuários e acessos.</small></span>
         <input name="nivel" type="radio" checked={nivel==='GESTAO'} onChange={()=>setNivel('GESTAO')} aria-label="Papel no sistema: Gestão"/>
        </label>
       </fieldset>
       <p className={layout.muted}>O nível escolhido também define o acesso inicial às Festas. Depois, alterar o acesso às Festas não muda o papel.</p>
       {modo==='senha'&&<>
       <label className={layout.senha}>Senha inicial
        <span className={layout.senhaCampo}>
         <input name="senha" type={verSenha?'text':'password'} autoComplete="new-password" required minLength={8} maxLength={128}/>
         <button type="button" className={layout.olho} aria-pressed={verSenha} aria-label={verSenha?'Ocultar senha':'Mostrar senha'} onClick={()=>setVerSenha(v=>!v)}>👁</button>
        </span>
       </label>
       <label className={senhaErro?layout.campoErro:undefined}>Confirmar senha
        <input name="confirmacao" type={verSenha?'text':'password'} autoComplete="new-password" required minLength={8} maxLength={128} aria-invalid={Boolean(senhaErro)} aria-describedby={senhaErro?'senha-erro':undefined}/>
        {senhaErro&&<span id="senha-erro" role="alert">{senhaErro}</span>}
       </label>
       <p className={layout.dica}><span className={layout.infoIcon} aria-hidden="true">i</span>Você define a senha inicial para quem ainda não usa o Kidmais. Quem já usa continua com a própria senha.</p>
       </>}
      </fieldset>
     </div>
     <div className={layout.drawerActions}>
      <AdminPrimaryButton type="submit" className={layout.cta} carregando={busy}>{modo==='convite'?'Enviar convite':'Adicionar pessoa'}</AdminPrimaryButton>
      <button type="button" className={layout.ghost} disabled={busy} onClick={fecharCriar}>Cancelar</button>
     </div>
    </form>
   </section>
  </div>}

  {user&&<div className={layout.overlay} onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setUser(null);}}>
   <section ref={editor} tabIndex={-1} aria-label="Alterar acesso" className={layout.drawer} role="dialog" aria-modal="true">
    <header className={layout.drawerHead}>
     <h2>Alterar acesso às Festas</h2>
     <button type="button" className={layout.iconBtn} aria-label="Fechar" disabled={busy} onClick={()=>setUser(null)}>×</button>
    </header>
    <form className={layout.drawerForm} onSubmit={salvarFesta}>
     <div className={layout.drawerBody}>
      <p>Nome: <strong>{user.nome}</strong></p>
      <p>Papel no sistema: <strong>{user.nivelSistema}</strong> — esta alteração não muda o papel.</p>
      <fieldset disabled={busy} className={layout.niveis}>
       <legend>Acesso às Festas</legend>
       <label className={perfil==='EQUIPE'?layout.nivelAtivo:layout.nivel}><span><strong>Equipe</strong><small>Pode consultar e operar as festas.</small></span><input name="perfil" type="radio" checked={perfil==='EQUIPE'} onChange={()=>setPerfil('EQUIPE')}/></label>
       <label className={perfil==='GESTAO'?layout.nivelAtivo:layout.nivel}><span><strong>Gestão</strong><small>Tem acesso completo às festas.</small></span><input name="perfil" type="radio" checked={perfil==='GESTAO'} onChange={()=>setPerfil('GESTAO')}/></label>
      </fieldset>
      {user.id===perfis?.usuarioId&&<label><input name="proprio" type="checkbox" required disabled={busy}/>Você está alterando seu próprio nível de acesso. Deseja continuar?</label>}
     </div>
     <div className={layout.drawerActions}>
      <AdminPrimaryButton type="submit" className={layout.cta} carregando={busy}>Salvar</AdminPrimaryButton>
      <button type="button" className={layout.ghost} disabled={busy} onClick={()=>setUser(null)}>Cancelar</button>
     </div>
    </form>
   </section>
  </div>}

  {alvoDesativar&&<div className={`${layout.overlay} ${layout.dim}`} onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setAlvoDesativar(null);}}>
   <section ref={desativarRef} tabIndex={-1} aria-label="Remover desta empresa" className={layout.modal} role="dialog" aria-modal="true" aria-labelledby="desativar-titulo">
    <div className={layout.modalIcon} aria-hidden="true">⊘</div>
    <h2 id="desativar-titulo">Remover {alvoDesativar.nome} desta empresa?</h2>
    <p className={layout.email}>{alvoDesativar.email}</p>
    <p className={layout.aviso}>A pessoa perde o acesso a esta empresa. A conta continua existindo, o acesso a outras empresas não muda e os registros anteriores serão mantidos.</p>
    <form onSubmit={desativar}>
     <div className={layout.modalActions}>
      <button type="button" className={layout.ghost} disabled={busy} onClick={()=>setAlvoDesativar(null)}>Cancelar</button>
      <button className={layout.perigo} disabled={busy}>Remover desta empresa</button>
     </div>
    </form>
   </section>
  </div>}
 </main>;
}
