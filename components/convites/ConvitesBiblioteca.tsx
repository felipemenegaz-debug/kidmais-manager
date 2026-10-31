'use client';
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/http/admin-fetch';
import FestaParaConvite from './FestaParaConvite';
import css from './biblioteca.module.css';
type Item = { id: string; festaId: string | null; nome: string; data: string; publicado: boolean; temArte: boolean };
export default function ConvitesBiblioteca() {
  const router = useRouter();
  const [filtro, setFiltro] = useState('todos'), [pagina, setPagina] = useState(1);
  const [dados, setDados] = useState<{ itens: Item[]; proxima: boolean } | null>(null);
  const [erro, setErro] = useState(''), [busy, setBusy] = useState(false), [carregando, setCarregando] = useState(true), [novo, setNovo] = useState(false);
  const intencao = useRef(''), criando = useRef(false), dialogo = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (novo) dialogo.current?.showModal(); else dialogo.current?.close(); }, [novo]);
  useEffect(() => {
    let ativo = true;
    void (async () => {
      setCarregando(true); setErro('');
      try {
        const r = await adminFetch(`/api/admin/convites/biblioteca?filtro=${filtro}&pagina=${pagina}`, { cache: 'no-store' });
        const j = await r.json(); if (!r.ok) throw new Error(j.erro);
        if (ativo) setDados(j.data);
      } catch (e) { if (ativo) { setDados(null); setErro((e as Error).message); } }
      finally { if (ativo) setCarregando(false); }
    })();
    return () => { ativo = false; };
  }, [filtro, pagina]);
  async function criar() {
    if (criando.current) return;
    criando.current = true; setBusy(true); setErro('');
    intencao.current ||= crypto.randomUUID();
    try {
      const r = await adminFetch('/api/admin/convites/biblioteca', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'criar', id: intencao.current }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.erro);
      router.push(`/admin/convites/${j.data.id}`);
    } catch (e) { setErro((e as Error).message); }
    finally { setBusy(false); criando.current = false; }
  }
  return <main className={css.pagina}>
    <header className={css.cabecalho}><div><p>CONVITES</p><h1>Meus convites</h1><p>Crie, personalize e acompanhe os convites do buffet.</p></div><button className={css.primario} onClick={() => setNovo(true)}>Criar convite</button></header>
    {!novo && erro && <p role="alert">{erro}</p>}
    <nav className={css.filtros} aria-label="Filtrar convites">{[['todos', 'Todos'], ['avulsos', 'Avulsos'], ['vinculados', 'Vinculados a festas']].map(([v, l]) => <button key={v} aria-pressed={filtro === v} onClick={() => { setFiltro(v); setPagina(1); }}>{l}</button>)}</nav>
    {carregando ? <p role="status">Carregando convites…</p> : dados && <>
      {!dados.itens.length && <section className={css.vazio}><h2>Seus convites aparecem aqui</h2><p>Comece um convite avulso ou escolha uma festa cadastrada para aproveitar os dados do aniversariante.</p><button onClick={() => setNovo(true)}>Criar meu primeiro convite</button></section>}
      <div className={css.grade}>{dados.itens.map(c => <Link className={css.card} key={c.id} href={`/admin/convites/${c.id}`}>
        <div className={css.arte}>{c.temArte ? <img loading="lazy" src={`/api/admin/convites/miniatura?conviteId=${c.id}`} alt={`Arte de ${c.nome || 'convite sem nome'}`} /> : <span aria-hidden="true">✉</span>}</div>
        <div className={css.detalhes}><span>{c.publicado ? 'Publicado' : 'Rascunho'} · {c.festaId ? 'Vinculado' : 'Avulso'}</span><h2>{c.nome || 'Convite sem nome'}</h2><p>{c.data ? c.data.split('-').reverse().join('/') : 'Data a definir'}</p><strong>Editar convite →</strong></div>
      </Link>)}</div>
      {(pagina > 1 || dados.proxima) && <nav className={css.paginacao} aria-label="Páginas de convites"><button disabled={pagina === 1} onClick={() => setPagina(p => p - 1)}>Anterior</button><span>Página {pagina}</span><button disabled={!dados.proxima} onClick={() => setPagina(p => p + 1)}>Próxima</button></nav>}
    </>}
    <dialog className={css.dialogo} ref={dialogo} onCancel={() => setNovo(false)}><div className={css.cabecalho}><h2>Criar convite</h2><button aria-label="Fechar" disabled={busy} onClick={() => setNovo(false)}>✕</button></div>
      {erro && <p role="alert">{erro}</p>}
      <section className={css.avulso}><div><h3>Começar sem uma festa</h3><p>Preencha os dados e crie sua arte. Você pode vincular uma festa depois.</p></div><button className={css.primario} disabled={busy} onClick={() => void criar()}>{busy ? 'Criando…' : 'Criar avulso'}</button></section>
      <h3>Ou escolher uma festa cadastrada</h3><p>Nome, idade, data e horário vêm do cadastro da festa.</p>
      <FestaParaConvite busy={busy} onEscolher={f => router.push(f.conviteId ? `/admin/convites/${f.conviteId}` : `/admin/festas/${f.id}/convite`)} />
    </dialog>
  </main>;
}
