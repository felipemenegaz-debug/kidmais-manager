'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';

type Registro = { id:string; nome:string; ativo:boolean; categoria_id?:string; codigo?:string; categoria?:string };
type Catalogo = { categorias:Registro[]; itens:Registro[]; adicionais:Registro[] };
export default function CatalogoEditor() {
  const [dados,setDados]=useState<Catalogo|null>(null);
  const [erro,setErro]=useState('');
  const [mensagem,setMensagem]=useState('');
  async function carregar() {
    const resposta=await adminFetch('/api/admin/configuracoes/catalogo');
    const body=await resposta.json();
    if(!body.ok)throw Error(body.erro);
    setDados(body.data);
  }
  useEffect(()=>{
    void adminFetch('/api/admin/configuracoes/catalogo').then(r=>r.json()).then(body=>{
      if(!body.ok)throw Error(body.erro);
      setDados(body.data);
    }).catch(e=>setErro(e instanceof Error?e.message:'Falha ao carregar catálogo.'));
  },[]);
  async function salvar(acao:'categoria'|'item'|'adicional',registro:Registro) {
    setErro('');setMensagem('');
    try {
      const resposta=await adminFetch('/api/admin/configuracoes/catalogo',{method:'PATCH',body:JSON.stringify({acao,id:registro.id,nome:registro.nome,ativo:registro.ativo})});
      const body=await resposta.json();if(!body.ok)throw Error(body.erro);
      setMensagem('Alteração salva.');await carregar();
    }catch(e){setErro(e instanceof Error?e.message:'Falha ao salvar.');}
  }
  async function adicionar(categoriaId:string,nome:string) {
    setErro('');setMensagem('');
    try {
      const resposta=await adminFetch('/api/admin/configuracoes/catalogo',{method:'PATCH',body:JSON.stringify({acao:'novo_item',categoriaId,nome})});
      const body=await resposta.json();if(!body.ok)throw Error(body.erro);
      setMensagem('Item adicionado.');await carregar();
    }catch(e){setErro(e instanceof Error?e.message:'Falha ao adicionar.');}
  }
  function editar(lista:keyof Catalogo,id:string,patch:Partial<Registro>){setDados(atual=>atual&&({...atual,[lista]:atual[lista].map(item=>item.id===id?{...item,...patch}:item)}));}
  function linha(registro:Registro,acao:'categoria'|'item'|'adicional',lista:keyof Catalogo){return <div key={registro.id} className={styles.grid}>
    <label>{registro.codigo||'Nome'}<input value={registro.nome} onChange={e=>editar(lista,registro.id,{nome:e.target.value})}/></label>
    <div><label><input type="checkbox" checked={registro.ativo} onChange={e=>editar(lista,registro.id,{ativo:e.target.checked})}/> Ativo</label>
      <button type="button" onClick={()=>void salvar(acao,registro)}>Salvar</button></div>
  </div>;}
  return <main className={styles.page}><h1>Buffet e adicionais</h1>
    <p>Edite nomes e disponibilidade. Itens desativados preservam os registros de contratos anteriores.</p>
    {erro&&<p role="alert">{erro}</p>}{mensagem&&<p role="status">{mensagem}</p>}
    {dados?.categorias.map(categoria=><section key={categoria.id} className={styles.card}>
      <h2>{categoria.nome}</h2>{linha(categoria,'categoria','categorias')}
      {dados.itens.filter(item=>item.categoria_id===categoria.id).map(item=>linha(item,'item','itens'))}
      <form onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const input=form.elements.namedItem('nome') as HTMLInputElement;void adicionar(categoria.id,input.value).then(()=>{input.value='';});}}>
        <label>Novo item<input name="nome" required maxLength={160}/></label><button>Adicionar item</button>
      </form>
    </section>)}
    <section className={styles.card}><h2>Adicionais</h2>{dados?.adicionais.map(adicional=>linha(adicional,'adicional','adicionais'))}</section>
  </main>;
}
