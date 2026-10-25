'use client';
import { useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import FestaParaConvite from './FestaParaConvite';
import css from './biblioteca.module.css';
export default function VincularFesta({ conviteId, revisao, bloqueado, onVinculado }: { conviteId: string; revisao: number; bloqueado: boolean; onVinculado: () => Promise<void> }) {
  const [escolha, setEscolha] = useState<{ id: string; nome: string } | null>(null), [usarDados, setUsarDados] = useState(true);
  const [busy, setBusy] = useState(false), [erro, setErro] = useState('');
  async function vincular() {
    if (!escolha || busy || bloqueado) return;
    setBusy(true); setErro('');
    try {
      const r = await adminFetch('/api/admin/convites/biblioteca', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'vincular', conviteId, festaId: escolha.id, revisao, usarDadosFesta: usarDados }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.erro);
      await onVinculado();
    } catch (e) { setErro((e as Error).message); }
    finally { setBusy(false); }
  }
  return <details className={css.vinculo}><summary>Convite avulso · Vincular a uma festa</summary>
    <p>As imagens, o histórico, o link público e os créditos usados continuam neste convite. Ele volta a rascunho para você conferir e publicar novamente.</p>
    <p>A autorização de IA será renovada para o responsável da festa antes da próxima geração.</p>
    {bloqueado && <p>Salve suas alterações e aguarde qualquer geração em andamento antes de vincular.</p>}
    <FestaParaConvite vincular busy={busy || bloqueado} onEscolher={f => setEscolha(f)} />
    {escolha && <><p>Festa selecionada: <strong>{escolha.nome || 'Sem nome'}</strong></p><label><input type="checkbox" checked={usarDados} disabled={busy} onChange={e => setUsarDados(e.target.checked)} />Usar nome, idade, data e horário cadastrados na festa</label><p>A arte pronta não muda ao atualizar os campos. Confira seus textos antes de publicar.</p><button type="button" disabled={busy || bloqueado} onClick={() => void vincular()}>{busy ? 'Vinculando…' : 'Confirmar vínculo'}</button></>}
    {erro && <p role="alert">{erro}</p>}
  </details>;
}
