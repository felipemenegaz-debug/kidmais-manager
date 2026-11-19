'use client';
import { useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './workspace.module.css';

type Opcao = { nome: string; link: string | null; caminho: string };
type Dados = { completo: Opcao; categorias: Opcao[]; emPreparacao: boolean };

export default function CompartilharCardapio() {
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [dados, setDados] = useState<Dados | null>(null);
  const [escolha, setEscolha] = useState('');
  const [copia, setCopia] = useState<'ok' | 'manual' | null>(null);
  const [erro, setErro] = useState('');
  async function abrir() {
    if (aberto) { setAberto(false); return; }
    setAberto(true);
    setCarregando(true);
    setDados(null); setEscolha(''); setCopia(null); setErro('');
    try {
      const r = await adminFetch('/api/admin/configuracoes/catalogo?compartilhar=1');
      const resposta = await r.json();
      if (r.status === 402 && resposta.codigo === 'ASSINATURA_NECESSARIA') {
        setErro(resposta.erro);
        return;
      }
      if (r.ok && resposta.data?.motivo) {
        setErro(resposta.data.motivo);
        return;
      }
      if (!r.ok || !resposta.data?.completo) throw Error('O cardápio está indisponível para compartilhamento.');
      setDados(resposta.data);
    } catch {
      setErro('O cardápio está indisponível para compartilhamento.');
    } finally { setCarregando(false); }
  }
  const opcao = dados?.categorias.find(c => c.caminho === escolha) ?? dados?.completo;
  async function copiar() {
    if (!opcao?.link) return;
    try { await navigator.clipboard.writeText(opcao.link); setCopia('ok'); }
    catch { setCopia('manual'); }
  }
  return <div>
    <button type="button" aria-expanded={aberto} disabled={carregando} onClick={() => void abrir()}>Compartilhar cardápio</button>
    {aberto && <section aria-label="Compartilhar cardápio">
      {carregando && <p role="status">Carregando cardápio…</p>}
      {erro && <p role="alert">{erro}</p>}
      {dados && opcao && <>
        {dados.emPreparacao && <p role="status">O cardápio está em preparação. Confira as categorias e os itens de escolha dos pacotes ativos antes de compartilhar.</p>}
        <label>Compartilhar<select value={escolha} onChange={e => { setEscolha(e.target.value); setCopia(null); }}>
          <option value="">Cardápio completo</option>
          {dados.categorias.map(c => <option key={c.caminho} value={c.caminho}>{c.nome}</option>)}
        </select></label>
        <div className={styles.actions}>
          <button type="button" onClick={() => void copiar()} disabled={!opcao.link}>Copiar link</button>
          <a href={opcao.link ?? opcao.caminho} target="_blank" rel="noreferrer">Abrir cardápio</a>
        </div>
        {!opcao.link && <p role="status">Configure o endereço público para copiar o link.</p>}
        {copia === 'ok' && <p role="status">Link copiado.</p>}
        {copia === 'manual' && <label>Copie o link manualmente<input readOnly value={opcao.link ?? ''} autoFocus onFocus={e => e.target.select()} /></label>}
      </>}
    </section>}
  </div>;
}
