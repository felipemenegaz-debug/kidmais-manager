'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';
import editor from './catalogo-editor.module.css';

type Registro = { id:string; nome:string; ativo:boolean; categoria_id?:string; codigo?:string; categoria?:string };
type Vinculo = { pacote_id:string;adicional_id:string;modalidade:'INCLUSO'|'EXTRA'|'INDISPONIVEL' };
type RegraBuffet = {pacote_id:string;categoria_id:string;ativo:boolean;escolhas_max:number};
type Catalogo = { categorias:Registro[]; itens:Registro[]; adicionais:Registro[];pacotes:{id:string;nome:string}[];vinculos:Vinculo[];regras:RegraBuffet[] };
export default function CatalogoEditor() {
  const [dados,setDados]=useState<Catalogo|null>(null);
  const [erro,setErro]=useState('');
  const [mensagem,setMensagem]=useState('');
  const [secao,setSecao]=useState<'buffet'|'adicionais'>('buffet');
  const [busca,setBusca]=useState('');
  const corresponde=(nome:string)=>nome.toLocaleLowerCase('pt-BR').includes(busca.trim().toLocaleLowerCase('pt-BR'));
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
  async function configurar(acao:'vinculo_adicional'|'nova_categoria'|'regra_buffet',dadosAcao:Record<string,string|boolean|number>){
    setErro('');setMensagem('');
    try {
      const resposta=await adminFetch('/api/admin/configuracoes/catalogo',{method:'PATCH',body:JSON.stringify({acao,...dadosAcao})});
      const body=await resposta.json();if(!body.ok)throw Error(body.erro);
      setMensagem('Configuração salva.');await carregar();
    }catch(e){setErro(e instanceof Error?e.message:'Falha ao salvar configuração.');}
  }
  function editar(lista:'categorias'|'itens'|'adicionais',id:string,patch:Partial<Registro>){setDados(atual=>atual&&({...atual,[lista]:atual[lista].map(item=>item.id===id?{...item,...patch}:item)}));}
  function linha(registro:Registro,acao:'categoria'|'item'|'adicional',lista:'categorias'|'itens'|'adicionais'){return <div key={registro.id} className={styles.grid}>
    <label>{registro.codigo||'Nome'}<input value={registro.nome} onChange={e=>editar(lista,registro.id,{nome:e.target.value})}/></label>
    <div><label><input type="checkbox" checked={registro.ativo} onChange={e=>editar(lista,registro.id,{ativo:e.target.checked})}/> Ativo</label>
      <button type="button" onClick={()=>void salvar(acao,registro)}>Salvar</button></div>
  </div>;}
  return <main className={styles.page}><h1>Buffet e adicionais</h1>
    <p>Edite nomes e disponibilidade. Itens desativados preservam os registros de contratos anteriores.</p>
    <div className={editor.toolbar}>
      <div className={editor.sections} aria-label="Seções do catálogo">
        <button type="button" aria-pressed={secao==='buffet'} onClick={()=>{setSecao('buffet');setBusca('');}}>Buffet</button>
        <button type="button" aria-pressed={secao==='adicionais'} onClick={()=>{setSecao('adicionais');setBusca('');}}>Adicionais</button>
      </div>
      <label>Buscar {secao==='buffet'?'categoria ou item':'adicional'}<input type="search" value={busca} onChange={e=>setBusca(e.target.value)}/></label>
      {erro&&<p role="alert">{erro}</p>}{mensagem&&<p role="status">{mensagem}</p>}
    </div>
    <div hidden={secao!=='buffet'}>
    <details><summary>Adicionar categoria de buffet</summary><form className={editor.content} onSubmit={e=>{e.preventDefault();const input=e.currentTarget.elements.namedItem('nome') as HTMLInputElement;void configurar('nova_categoria',{nome:input.value}).then(()=>{input.value='';});}}>
      <label>Nova categoria de buffet<input name="nome" required maxLength={160}/></label><button>Adicionar categoria</button>
    </form></details>
    {dados?.categorias.map(categoria=><details key={categoria.id} hidden={!corresponde(categoria.nome)&&!dados.itens.some(item=>item.categoria_id===categoria.id&&corresponde(item.nome))}>
      <summary>{categoria.nome} · {dados.itens.filter(item=>item.categoria_id===categoria.id).length} itens</summary><div className={editor.content}>
      {linha(categoria,'categoria','categorias')}
      {dados.itens.filter(item=>item.categoria_id===categoria.id).map(item=>linha(item,'item','itens'))}
      <form onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const input=form.elements.namedItem('nome') as HTMLInputElement;void adicionar(categoria.id,input.value).then(()=>{input.value='';});}}>
        <label>Novo item<input name="nome" required maxLength={160}/></label><button>Adicionar item</button>
      </form>
      <details><summary>Disponibilidade por pacote</summary><div className={styles.grid}>
        {dados.pacotes.map(pacote=>{
          const regra=dados.regras.find(r=>r.pacote_id===pacote.id&&r.categoria_id===categoria.id);
          return <form key={pacote.id} onSubmit={e=>{
            e.preventDefault();const form=e.currentTarget;
            const ativo=(form.elements.namedItem('ativo') as HTMLInputElement).checked;
            const max=Number((form.elements.namedItem('max') as HTMLInputElement).value);
            void configurar('regra_buffet',{pacoteId:pacote.id,categoriaId:categoria.id,ativo,max});
          }}><strong>{pacote.nome}</strong><label><input type="checkbox" name="ativo" defaultChecked={regra?.ativo??false} key={`${regra?.ativo??false}-${categoria.id}-${pacote.id}`}/> Disponível</label>
            <label>Até quantas escolhas<input name="max" type="number" required min={1} max={30} defaultValue={regra?.escolhas_max??1} key={regra?.escolhas_max??1}/></label>
            <button>Salvar regra</button></form>;
        })}</div></details>
    </div></details>)}
    {dados&&!dados.categorias.some(categoria=>corresponde(categoria.nome)||dados.itens.some(item=>item.categoria_id===categoria.id&&corresponde(item.nome)))&&<p>Nenhuma categoria ou item encontrado.</p>}
    </div>
    <section hidden={secao!=='adicionais'}><h2>Adicionais</h2><p>Para cada pacote, marque incluso, extra ou indisponível. Apenas extras ativos com preço vigente aparecem para o cliente.</p>
      {dados?.adicionais.map(adicional=><details key={adicional.id} hidden={!corresponde(adicional.nome)}><summary>{adicional.nome}</summary><div className={editor.content}>
        {linha(adicional,'adicional','adicionais')}
        <div className={styles.grid}>{dados.pacotes.map(pacote=><label key={pacote.id}>{pacote.nome}
          <select value={dados.vinculos.find(v=>v.pacote_id===pacote.id&&v.adicional_id===adicional.id)?.modalidade??'INDISPONIVEL'}
            onChange={e=>void configurar('vinculo_adicional',{pacoteId:pacote.id,adicionalId:adicional.id,modalidade:e.target.value})}>
            <option value="INDISPONIVEL">Indisponível</option><option value="INCLUSO">Incluso</option><option value="EXTRA">Extra pago</option>
          </select>
        </label>)}</div>
      </div></details>)}
      {dados&&!dados.adicionais.some(adicional=>corresponde(adicional.nome))&&<p>Nenhum adicional encontrado.</p>}
      </section>
  </main>;
}
