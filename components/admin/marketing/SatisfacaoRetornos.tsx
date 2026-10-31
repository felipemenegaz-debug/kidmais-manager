'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { PainelRetornos } from '@/lib/satisfacao/tarefas';
import { dataBr, dataHoraBr } from '@/lib/marketing/apresentacao';
import { enviarMarketing, useMarketing } from './comum';
import styles from './marketing.module.css';

/**
 * PS-3 (plano D + D-PS3-3): cartão "Retornos de notas baixas" SÓ da Gestão, com carregamento próprio
 * (/api/admin/satisfacao/tarefas), independente da regra Pesquisa e da API de Marketing. A Equipe não tem tela na PS-3
 * (a API responde pelo escopo dela; a tela vem no menu Satisfação da PS-4). Sem a 111 ou sem acesso: nada aparece.
 * O comentário do cliente é texto (o React escapa); não se promete anonimização.
 */
export function RetornosNotasBaixas() {
  const [unidadeId, setUnidadeId] = useState('');
  const { dados, recarregar } = useMarketing<PainelRetornos>(`/api/admin/satisfacao/tarefas${unidadeId ? `?unidadeId=${unidadeId}` : ''}`);
  const [observacoes, setObservacoes] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  if (!dados?.gestao) return null;
  const abertas = dados.tarefas.filter((t) => t.estado === 'ABERTA');
  const concluidas = dados.tarefas.filter((t) => t.estado === 'CONCLUIDA');
  async function concluir(id: string) {
    setOcupado(id); setAviso(null);
    try {
      await enviarMarketing(`/api/admin/satisfacao/tarefas/${id}/concluir`, { observacao: observacoes[id]?.trim() || null });
      setAviso({ tipo: 'ok', texto: 'Retorno registrado.' });
      recarregar();
    } catch (e) { setAviso({ tipo: 'erro', texto: e instanceof Error ? e.message : 'Não foi possível concluir.' }); }
    finally { setOcupado(null); }
  }
  const semResponsavel = dados.unidades.filter((u) => u.semResponsavel && u.abertas > 0);
  return <section className={styles.cartao} aria-labelledby="t-retornos" data-retornos-notas-baixas>
    <h2 id="t-retornos">Retornos de notas baixas ({abertas.length})</h2>
    <p className={styles.muted}>Clientes que deram nota de 0 a 6 na pesquisa de satisfação. Entre em contato e registre o retorno.</p>
    {dados.unidades.length > 0 && <div className={styles.filtros}><label>Unidade<select value={unidadeId} onChange={(e) => setUnidadeId(e.target.value)}>
      <option value="">Todas</option>{dados.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome} ({u.abertas})</option>)}</select></label>
      {!unidadeId && (dados.abertasSemUnidade ?? 0) > 0 && <span className={styles.muted}>{dados.abertasSemUnidade} sem unidade.</span>}</div>}
    {semResponsavel.length > 0 && <p className={styles.aviso} role="note">Sem responsável pelos retornos: {semResponsavel.map((u) => u.nome).join(', ')}. Por enquanto a Gestão trata essas unidades.</p>}
    {aviso && <p className={aviso.tipo === 'ok' ? styles.info : styles.aviso} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>{aviso.texto}</p>}
    {abertas.length === 0 ? <p className={styles.vazio}>Nenhum retorno pendente.</p> : <ul className={styles.historico}>{abertas.map((t) => <li key={t.id} data-tarefa={t.id}>
      <strong>Nota {t.notaIndicacao}</strong> · {t.cliente} · festa em {dataBr(t.dataFesta)}{t.unidade ? ` · ${t.unidade}` : ''} · <Link href={`/clientes/${t.clienteId}`}>cliente</Link>
      {t.comentario && <><br /><span style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>“{t.comentario}”</span></>}
      <label className={styles.campo}>Como foi o retorno (opcional)
        <textarea rows={2} maxLength={1000} value={observacoes[t.id] ?? ''} onChange={(e) => setObservacoes({ ...observacoes, [t.id]: e.target.value })} /></label>
      <button type="button" className={styles.secundario} disabled={ocupado !== null} onClick={() => void concluir(t.id)}>{ocupado === t.id ? 'Salvando…' : 'Concluir retorno'}</button>
    </li>)}</ul>}
    {concluidas.length > 0 && <details><summary>Concluídos ({concluidas.length})</summary><ul className={styles.historico}>{concluidas.map((t) => <li key={t.id}>
      Nota {t.notaIndicacao} · {t.cliente} · concluído em {t.concluidaEm ? dataHoraBr(t.concluidaEm) : '—'}{t.observacao ? ` · ${t.observacao}` : ''}</li>)}</ul></details>}
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
