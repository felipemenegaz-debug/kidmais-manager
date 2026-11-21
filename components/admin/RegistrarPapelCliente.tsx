'use client';
import { dialogo } from '@/components/JanelaConfirmacao';
import { useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { dataCivilBr } from '@/lib/contratos/assinatura-papel';
import { classePrimaria } from './AdminPrimaryButton';
import styles from './contratos-ux.module.css';

/** 'YYYY-MM-DD' de hoje em São Paulo (só para o limite do campo; o banco confere de novo pelo relógio dele). */
const hojeSp = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const AVISO_SEM_COPIA = 'Sem cópia anexada, o registro fica só com a sua declaração.';

/**
 * 124 — "O cliente assinou em papel": só para a Gestão, com a V1 assinada pelo buffet e liberada ao cliente.
 * Confirmação em diálogo, sem pedir senha de novo (D-PAPEL-3). Cópia opcional (D-PAPEL-1), PDF/JPEG/PNG até 25 MB.
 * A chave de idempotência vale para o formulário aberto: repetir o envio reaproveita o mesmo registro.
 */
export default function RegistrarPapelCliente({ versaoId, onRegistrado }: { versaoId: string; onRegistrado: () => Promise<unknown> }) {
  const [data, setData] = useState(''), [observacao, setObservacao] = useState(''), [arquivo, setArquivo] = useState<File | null>(null);
  const [erro, setErro] = useState(''), [enviando, setEnviando] = useState(false);
  const [chave, setChave] = useState(() => crypto.randomUUID());
  const novaChave = () => setChave(crypto.randomUUID());

  async function registrar(gatilho: HTMLButtonElement) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) { setErro('Informe a data em que o cliente assinou.'); return; }
    const texto = `Registrar que o cliente assinou o contrato em papel em ${dataCivilBr(data)}? O contrato passa a ASSINADO e a festa é formalizada.`
      + (arquivo ? '' : `\n\n${AVISO_SEM_COPIA}`);
    if (!await dialogo.confirmar("Registrar assinatura", texto, undefined, gatilho)) return;
    setEnviando(true); setErro('');
    try {
      const form = new FormData();
      form.set('dataDeclarada', data);
      if (observacao.trim()) form.set('observacao', observacao.trim());
      form.set('chaveIdempotencia', chave);
      if (arquivo) form.set('arquivo', arquivo, arquivo.name);
      const r = await adminFetch(`/api/admin/contratos/versoes/${versaoId}/assinatura-papel`, { method: 'POST', body: form });
      const b = await r.json() as { ok: boolean; erro?: string };
      if (!b.ok) throw Error(b.erro || 'Não foi possível registrar a assinatura em papel.');
      novaChave();
      await onRegistrado();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível registrar a assinatura em papel.');
    } finally {
      setEnviando(false);
    }
  }

  // Dados mudaram: outro pedido (nova chave), para nunca reaproveitar a chave com conteúdo diferente.
  const mudar = <T,>(set: (x: T) => void) => (x: T) => { novaChave(); set(x); };

  return <details data-testid="registrar-papel-cliente"><summary>O cliente assinou em papel</summary>
    <p className={styles.discreto}>Use quando o cliente assinou o contrato impresso. A assinatura do buffet e o PDF continuam valendo.</p>
    <label>Data em que o cliente assinou <input type="date" value={data} max={hojeSp()} required onChange={e => mudar(setData)(e.target.value)} /></label>
    <label>Cópia do contrato assinado (opcional) <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={e => mudar(setArquivo)(e.target.files?.[0] ?? null)} /></label>
    {!arquivo && <p className={styles.discreto}>{AVISO_SEM_COPIA}</p>}
    <label>Observação (opcional) <input value={observacao} maxLength={500} onChange={e => mudar(setObservacao)(e.target.value)} /></label>
    {erro && <p className={styles.notice} role="alert">{erro}</p>}
    <button type="button" data-km-primario className={classePrimaria} disabled={enviando || !data} onClick={(evento) => void registrar(evento.currentTarget)}>Registrar assinatura em papel</button>
  </details>;
}

export type RegistroPapelPainel = {
  versaoId: string; dataDeclarada: string; registradoEm?: string; registradoPor?: string | null; observacao?: string | null;
  temArquivo?: boolean; tipo?: string | null; tamanho?: number | null; sha256?: string | null;
};

/** Linha "Cliente: assinado em papel em dd/mm/aaaa" nos comprovantes; detalhes e cópia só chegam para a Gestão. */
export function LinhaPapelCliente({ registro, instante }: { registro: RegistroPapelPainel; instante: (iso: string) => string }) {
  return <p data-testid="papel-cliente">Cliente: assinado em papel em {dataCivilBr(registro.dataDeclarada)}
    {registro.registradoEm && <> · registrado em {instante(registro.registradoEm)}{registro.registradoPor ? ` por ${registro.registradoPor}` : ''}</>}
    {registro.temArquivo === true && <> · <a className={styles.documentButton} href={`/api/admin/contratos/versoes/${registro.versaoId}/assinatura-papel/arquivo`}>Ver digitalização</a></>}
    {registro.temArquivo === false && ' · sem cópia anexada'}
    {registro.observacao ? <> · {registro.observacao}</> : null}
  </p>;
}
