'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './workspace.module.css';
import editor from './catalogo-editor.module.css';

type Registro = { id: string; nome: string; ativo: boolean; categoria_id?: string };
type Catalogo = { categorias: Registro[]; itens: Registro[] };

export default function CatalogoEditor() {
  const [dados, setDados] = useState<Catalogo | null>(null);
  const [erro, setErro] = useState('');
  const [secao, setSecao] = useState<'categorias' | 'itens'>('categorias');
  const [busca, setBusca] = useState('');
  const corresponde = (nome: string) => nome.toLocaleLowerCase('pt-BR').includes(busca.trim().toLocaleLowerCase('pt-BR'));

  useEffect(() => {
    void adminFetch('/api/admin/configuracoes/catalogo').then((r) => r.json()).then((body) => {
      if (!body.ok) throw Error(body.erro);
      setDados({ categorias: body.data.categorias, itens: body.data.itens });
    }).catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao carregar o buffet.'));
  }, []);

  const categorias = dados?.categorias.filter((categoria) => corresponde(categoria.nome) || dados.itens.some((item) => item.categoria_id === categoria.id && corresponde(item.nome))) ?? [];
  const itens = dados?.itens.filter((item) => corresponde(item.nome) || dados.categorias.some((categoria) => categoria.id === item.categoria_id && corresponde(categoria.nome))) ?? [];

  return <main className={styles.page} data-admin-workspace>
    <header className={styles.header}><h1>Itens do Buffet</h1></header>
    <div className={styles.content}>
      <div className={editor.toolbar}>
        <div className={editor.sections} aria-label="Seções do buffet">
          <button type="button" aria-pressed={secao === 'categorias'} onClick={() => { setSecao('categorias'); setBusca(''); }}>Categorias</button>
          <button type="button" aria-pressed={secao === 'itens'} onClick={() => { setSecao('itens'); setBusca(''); }}>Itens</button>
        </div>
        <label>Buscar {secao === 'categorias' ? 'categoria' : 'item'}<input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} /></label>
        {erro && <p role="alert">{erro}</p>}
      </div>
      {secao === 'categorias' && <section aria-label="Categorias">
        <p className={styles.intro}>Salgados, doces, bolo e as outras categorias que entram nos pacotes.</p>
        {categorias.map((categoria) => <article className={styles.card} key={categoria.id}>
          <h2>{categoria.nome}{categoria.ativo ? '' : ' · inativa'}</h2>
          <p className={styles.muted}>{dados?.itens.filter((item) => item.categoria_id === categoria.id).length ?? 0} itens</p>
        </article>)}
        {dados && !categorias.length && <p>Nenhuma categoria encontrada.</p>}
      </section>}
      {secao === 'itens' && <section aria-label="Itens">
        <p className={styles.intro}>Coxinha, brigadeiro e os outros itens de cada categoria.</p>
        <ul className={styles.history}>{itens.map((item) => {
          const categoria = dados?.categorias.find((atual) => atual.id === item.categoria_id);
          return <li key={item.id}><strong>{item.nome}{item.ativo ? '' : ' · inativo'}</strong><span>{categoria?.nome ?? 'Sem categoria'}</span></li>;
        })}</ul>
        {dados && !itens.length && <p>Nenhum item encontrado.</p>}
      </section>}
    </div>
  </main>;
}
