'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';

type Atual = { nome: string; publicadoEm: string } | null;
export default function TabelaPacotesPdf() {
  const [atual,setAtual]=useState<Atual>(null),[arquivo,setArquivo]=useState<File|null>(null);
  const [erro,setErro]=useState(''),[mensagem,setMensagem]=useState(''),[enviando,setEnviando]=useState(false);
  useEffect(()=>{adminFetch('/api/admin/configuracoes/tabela-pacotes').then(r=>r.json()).then(b=>{
    if(!b.ok)throw Error(b.erro);setAtual(b.data);
  }).catch(e=>setErro(e instanceof Error?e.message:'Não foi possível carregar a tabela.'));},[]);
  async function enviar(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault();if(!arquivo)return;
    setEnviando(true);setErro('');setMensagem('');
    try {
      const form=new FormData();form.set('arquivo',arquivo);
      const res=await adminFetch('/api/admin/configuracoes/tabela-pacotes',{method:'POST',body:form});
      const body=await res.json();if(!body.ok)throw Error(body.erro);
      setAtual({nome:body.data.nome,publicadoEm:body.data.publicadoEm});setArquivo(null);
      setMensagem('Nova tabela publicada. A versão anterior deixou de ser exibida aos clientes.');
    }catch(error){setErro(error instanceof Error?error.message:'Falha ao publicar PDF.');}
    finally{setEnviando(false);}
  }
  return <main className={styles.page}><h1>Tabela de pacotes e preços</h1>
    <p>O cliente poderá abrir o PDF durante o Fechamento. Sempre haverá no máximo uma tabela publicada.</p>
    <p role="alert">{erro}</p><p role="status">{mensagem}</p>
    {atual?<section className={styles.card}><h2>Tabela atual</h2><p>{atual.nome} · Publicada em {new Date(atual.publicadoEm).toLocaleString('pt-BR')}</p><a href="/api/fechamentos/tabela-pacotes" target="_blank" rel="noreferrer">Visualizar PDF</a></section>:<p>Nenhuma tabela publicada.</p>}
    <form onSubmit={enviar}><label>Substituir por PDF<input type="file" accept="application/pdf,.pdf" required onChange={e=>setArquivo(e.target.files?.[0]??null)}/></label><p>Até 10 MB. A tabela atual permanece disponível se o envio falhar.</p><button disabled={enviando||!arquivo}>{enviando?'Enviando…':'Publicar tabela'}</button></form>
  </main>;
}
