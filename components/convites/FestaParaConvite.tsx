'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import css from './biblioteca.module.css';
type Festa = { id: string; nome: string; data: string; conviteId: string | null };
export default function FestaParaConvite({ vincular = false, busy = false, onEscolher }: { vincular?: boolean; busy?: boolean; onEscolher: (festa: Festa) => void }) {
  const [busca, setBusca] = useState(''), [festas, setFestas] = useState<Festa[]>([]);
  const [erro, setErro] = useState(''), [carregando, setCarregando] = useState(true);
  useEffect(() => {
    let ativo = true;
    const timer = setTimeout(async () => {
      setCarregando(true); setErro('');
      try {
        const r = await adminFetch(`/api/admin/convites/biblioteca?festas=true&busca=${encodeURIComponent(busca)}`, { cache: 'no-store' });
        const j = await r.json(); if (!r.ok) throw new Error(j.erro);
        if (ativo) setFestas(j.data);
      } catch (e) { if (ativo) setErro((e as Error).message); }
      finally { if (ativo) setCarregando(false); }
    }, 250);
    return () => { ativo = false; clearTimeout(timer); };
  }, [busca]);
  return <section className={css.escolha} aria-label="Escolher festa">
    <label>Buscar por aniversariante ou data<input type="search" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Nome ou data (AAAA-MM-DD)" /></label>
    {erro && <p role="alert">{erro}</p>}
    {carregando ? <p role="status">Buscando festas…</p> : <>
      {!festas.length && <p>Nenhuma festa encontrada.</p>}
      <ul>{festas.map(f => <li key={f.id}><div><strong>{f.nome || 'Aniversariante não informado'}</strong><span>{f.data?.slice(0, 10).split('-').reverse().join('/') || 'Data não informada'}</span></div>
        {vincular && f.conviteId ? <Link href={`/admin/convites/${f.conviteId}`}>Abrir convite existente</Link> : <button type="button" disabled={busy || carregando} onClick={() => onEscolher(f)}>{vincular ? 'Selecionar' : f.conviteId ? 'Abrir convite' : 'Usar esta festa'}</button>}
      </li>)}</ul>
      {festas.length === 50 && <p>Mostrando até 50 festas. Refine a busca para encontrar outra.</p>}
    </>}
  </section>;
}
