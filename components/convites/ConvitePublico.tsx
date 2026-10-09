'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { temas, type Conteudo } from '@/lib/convites/domain';
import ConviteArte from './ConviteArte';
import styles from './publico.module.css';
export default function ConvitePublico({ token }: { token: string }) {
  const [conteudo, setConteudo] = useState<Conteudo | null>(null), [erro, setErro] = useState(''), [aviso, setAviso] = useState('');
  const [busy, setBusy] = useState(false), [nome, setNome] = useState(''), [presenca, setPresenca] = useState(true), [adultos, setAdultos] = useState(1), [criancas, setCriancas] = useState(0);
  const [efeitosPausados, setEfeitosPausados] = useState(false);
  const chave = useRef('');
  const endpoint = `/api/convites/publico/${encodeURIComponent(token)}`;
  useEffect(() => {
    const controller = new AbortController();
    try { const k = `convite-rsvp:${token}`; chave.current = localStorage.getItem(k) || crypto.randomUUID(); localStorage.setItem(k, chave.current); }
    catch { chave.current = crypto.randomUUID(); }
    void fetch(endpoint, { cache: 'no-store', signal: controller.signal }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.erro); setConteudo(j.data.conteudo); }).catch(e => { if (!controller.signal.aborted) setErro(e.message); });
    return () => controller.abort();
  }, [endpoint, token]);
  const tema = conteudo ? temas[conteudo.tema] : null;
  const cores = tema ? { '--convite-fundo': tema.fundo, '--convite-tinta': tema.tinta, '--convite-destaque': tema.destaque } as CSSProperties : undefined;
  return <main className={styles.publico} data-tema={conteudo?.tema} data-efeitos-pausados={efeitosPausados} style={cores}>
    {!conteudo && <div className={styles.estado}>{erro ? <p role="alert" className={styles.erro}>{erro}</p> : <p role="status">Preparando um convite especial…</p>}</div>}
    {conteudo && <>
      <div className={styles.enfeites} aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span key={i}>{tema?.simbolo}</span>)}</div>
      <header className={styles.cabecalho}><p className={styles.sobretitulo}>UM CONVITE ESPECIAL</p><h1>Vamos celebrar juntos.</h1><p>Um dia para criar boas memórias.</p>
        {conteudo.confirmarPresenca && <a className={styles.atalho} href="#confirmar-presenca">Confirmar presença ↓</a>}
        <button type="button" className={styles.controleEfeitos} aria-pressed={efeitosPausados} onClick={() => setEfeitosPausados(v => !v)}>{efeitosPausados ? 'Ativar efeitos' : 'Pausar efeitos'}</button>
      </header>
      <div className={styles.colunas} data-com-rsvp={conteudo.confirmarPresenca}>
      <section className={styles.arte} aria-label="Convite da festa"><div className={`${styles.moldura} ${styles.bordaAnimada}`}><ConviteArte conteudo={conteudo} arte={conteudo.arteId ? `${endpoint}?arte=1` : undefined} /></div>
      <a className={styles.mapa} href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${conteudo.local} ${conteudo.endereco}`)}`} target="_blank" rel="noreferrer">Como chegar ↗</a></section>
      {conteudo.confirmarPresenca && <form id="confirmar-presenca" aria-labelledby="titulo-presenca" className={`${styles.painel} ${styles.bordaAnimada}`} onSubmit={async e => {
        e.preventDefault(); const form = e.currentTarget; setBusy(true); setErro(''); setAviso('');
        try {
          const site = new FormData(form).get('site') || '';
          const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chave: chave.current, nome, presenca, adultos, criancas, site }) });
          const j = await r.json(); if (!r.ok) throw new Error(j.erro); setAviso('Resposta salva! Você pode atualizar sua resposta neste dispositivo.');
        } catch (err) { setErro((err as Error).message); } finally { setBusy(false); }
      }}><span className={styles.selo} aria-hidden="true">{tema?.simbolo}</span><p className={styles.sobretitulo}>VAMOS NOS ENCONTRAR?</p><h2 id="titulo-presenca">Confirme sua presença</h2><p>Uma resposta por família. Informe o total de pessoas que irão à festa.</p><fieldset disabled={busy} className={styles.formulario}><label>Seu nome<input required maxLength={100} minLength={2} value={nome} onChange={e => setNome(e.target.value)} autoComplete="name" /></label><label>Sua resposta<select value={presenca ? 'sim' : 'nao'} onChange={e => setPresenca(e.target.value === 'sim')}><option value="sim">Sim, vamos comemorar!</option><option value="nao">Não poderemos ir</option></select></label>
        {presenca && <div className={styles.campos}><label>Adultos<input required type="number" min={0} max={20} value={adultos} onChange={e => setAdultos(Number(e.target.value))} /></label><label>Crianças<input required type="number" min={0} max={20} value={criancas} onChange={e => setCriancas(Number(e.target.value))} /></label></div>}
        <div className={styles.isca} aria-hidden="true"><label>Site<input name="site" tabIndex={-1} autoComplete="off" /></label></div><button className={styles.primario} type="submit">{busy ? 'Enviando…' : 'Enviar resposta'}</button></fieldset><small>Sua resposta será vista pelo organizador e pelo buffet.</small>{erro && <p role="alert" className={styles.erro}>{erro}</p>}{aviso && <p role="status" className={styles.aviso}>{aviso}</p>}</form>}
      </div>
      <footer className={styles.rodape}>Um momento especial, organizado com KidMais.</footer>
    </>}
  </main>;
}
