'use client';
import Link from 'next/link';
import { useState } from 'react';
import { enviarMarketing, useMarketing } from './comum';
import styles from './marketing.module.css';

/**
 * PS-4 (R5): a fila "Retornos de notas baixas" saiu daqui para Satisfação › Retornos (página própria, também da Equipe
 * com TRATAR). Na regra Pesquisa fica só o atalho; o link do Google continua aqui (D-PS4-3).
 */
export function AtalhoRetornos() {
  return <section className={styles.cartao} aria-labelledby="t-retornos" data-atalho-retornos>
    <h2 id="t-retornos">Retornos de notas baixas</h2>
    <p className={styles.muted}>Os clientes que deram nota de 0 a 6 ficam em Satisfação › Retornos, com o registro de cada contato.</p>
    <Link className={styles.secundario} href="/admin/satisfacao/retornos">Ver retornos em Satisfação</Link>
  </section>;
}

type Links = { empresa: { url: string | null }; unidades: Array<{ estabelecimentoId: string; nome: string; url: string | null }>; exemplos: string[] };

/** PS-3 (B + D): link de avaliação do Google por empresa/unidade, dentro da regra Pesquisa. Só Gestão (403 → nada). */
export function LinksAvaliacao() {
  const { dados, recarregar } = useMarketing<Links>('/api/admin/satisfacao/links');
  const [rascunho, setRascunho] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  if (!dados) return null;
  const linhas = [{ chave: '', estabelecimentoId: null as string | null, nome: dados.unidades.length > 0 ? 'Festas sem unidade' : 'Empresa', url: dados.empresa.url },
    ...dados.unidades.map((u) => ({ chave: u.estabelecimentoId, estabelecimentoId: u.estabelecimentoId, nome: u.nome, url: u.url }))];
  async function enviar(corpo: Record<string, unknown>, ok: string) {
    setOcupado(true); setAviso(null);
    try { await enviarMarketing('/api/admin/satisfacao/links', corpo); setAviso({ tipo: 'ok', texto: ok }); recarregar(); }
    catch (e) { setAviso({ tipo: 'erro', texto: e instanceof Error ? e.message : 'Não foi possível salvar.' }); }
    finally { setOcupado(false); }
  }
  return <div data-links-avaliacao>
    <h3>Link de avaliação do Google</h3>
    <p className={styles.muted}>Depois de responder, o cliente vê o convite “Avaliar no Google”, com o mesmo destaque para qualquer nota. Cada unidade usa o próprio link; unidade sem link fica sem o convite.</p>
    <p className={styles.muted} style={{ overflowWrap: 'anywhere' }}>Formatos aceitos: {dados.exemplos.join(' · ')}</p>
    {aviso && <p className={aviso.tipo === 'ok' ? styles.info : styles.aviso} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>{aviso.texto}</p>}
    {linhas.map((l) => <div key={l.chave} className={styles.filtros}>
      <label className={styles.campo} style={{ flex: '1 1 240px', minWidth: 0 }}>{l.nome}
        <input inputMode="url" style={{ width: '100%', minWidth: 0 }} placeholder="https://search.google.com/local/writereview?placeid=…" value={rascunho[l.chave] ?? l.url ?? ''}
          onChange={(e) => setRascunho({ ...rascunho, [l.chave]: e.target.value })} /></label>
      <button type="button" className={styles.secundario} disabled={ocupado || !(rascunho[l.chave] ?? '').trim()}
        onClick={() => void enviar({ acao: 'salvar', estabelecimentoId: l.estabelecimentoId, url: (rascunho[l.chave] ?? '').trim() }, 'Link salvo.')}>Salvar</button>
      {l.url && <button type="button" className={styles.fantasma} disabled={ocupado}
        onClick={() => { if (window.confirm(`Remover o link de ${l.nome}?`)) void enviar({ acao: 'remover', estabelecimentoId: l.estabelecimentoId }, 'Link removido.'); }}>Remover</button>}
    </div>)}
  </div>;
}
