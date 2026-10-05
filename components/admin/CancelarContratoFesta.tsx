'use client';
import { useState, useRef } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';

export default function CancelarContratoFesta({ festaId, nome, onCancelado }: { festaId: string; nome: string; onCancelado(): Promise<void> }) {
  const [aberto, setAberto] = useState(false), [motivo, setMotivo] = useState(''), [confirmado, setConfirmado] = useState(false);
  const [erro, setErro] = useState(''), [busy, setBusy] = useState(false);
  const [contexto, setContexto] = useState<{ revisao: number; versaoId: string; pode: boolean } | null>(null);
  const pedido = useRef<{ motivo: string; chave: string } | null>(null), enviando = useRef(false);
  async function abrir() {
    setAberto(true); setBusy(true); setErro(''); setContexto(null);
    try {
      const r = await adminFetch('/api/admin/festas?id=' + festaId); const b = await r.json();
      if (!b.ok) throw Error(b.erro);
      setContexto({ revisao: b.data.festa.revisao, versaoId: b.data.contrato.versao_id, pode: b.data.capacidades.includes('FESTA_CORRIGIR') });
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível consultar a contratação.'); }
    finally { setBusy(false); }
  }
  async function cancelar() {
    if (!contexto?.pode || !confirmado || motivo.trim().length < 3 || enviando.current) return;
    enviando.current = true; setBusy(true); setErro('');
    if (pedido.current?.motivo !== motivo.trim()) pedido.current = { motivo: motivo.trim(), chave: crypto.randomUUID() };
    try {
      const r = await adminFetch('/api/admin/festas?id=' + festaId, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'cancelar_contratacao', revisao: contexto.revisao, versaoId: contexto.versaoId, ...pedido.current }) });
      const b = await r.json(); if (!b.ok) throw Error(b.erro);
      await onCancelado(); setAberto(false);
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível confirmar. Consulte o contrato antes de repetir.'); }
    finally { enviando.current = false; setBusy(false); }
  }
  return <div><button disabled={busy} onClick={() => void abrir()}>Cancelar contrato</button>
    {aberto && <section role="dialog" aria-modal="false" aria-label="Cancelar contrato" style={{ padding: 20, border: '1px solid #e98080', borderRadius: 12, marginTop: 16 }}>
      <h3>Cancelar contrato de {nome}</h3><p>A reserva será liberada. O documento original, o histórico e os recebimentos serão preservados. Eventuais devoluções serão tratadas no Financeiro.</p>
      {contexto && !contexto.pode ? <p role="alert">Seu acesso não permite cancelar. Solicite a um usuário com perfil Gestão da Festa.</p> : <>
        <label>Motivo do cancelamento<textarea value={motivo} maxLength={4000} disabled={busy} onChange={e => setMotivo(e.target.value)} /></label>
        <label><input type="checkbox" checked={confirmado} disabled={busy} onChange={e => setConfirmado(e.target.checked)} />Confirmo o cancelamento desta contratação.</label>
        <button disabled={busy || !contexto?.pode || !confirmado || motivo.trim().length < 3} onClick={() => void cancelar()}>Confirmar cancelamento</button>
      </>}
      {erro && <p role="alert">{erro}</p>}<button disabled={busy} onClick={() => setAberto(false)}>Voltar</button>
    </section>}
  </div>;
}
