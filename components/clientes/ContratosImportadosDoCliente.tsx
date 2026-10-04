'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { ContratoImportadoResumo } from '@/lib/contratos/importados';
import styles from './Clientes.module.css';

const dataBr = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : 'Data não informada');
const SITUACAO: Record<ContratoImportadoResumo['situacaoEvento'], string> = {
  PASSADO: 'Evento realizado (histórico)',
  FUTURO: 'Evento importado — ainda não integrado à agenda',
  SEM_DATA: 'Sem data no documento',
};

/** Contratos históricos importados deste cliente. Somente leitura: nenhuma festa, reserva ou cobrança nasce aqui. */
export default function ContratosImportadosDoCliente({ clienteId }: { clienteId: string }) {
  const [lista, setLista] = useState<ContratoImportadoResumo[] | null>(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    let ativo = true;
    adminFetch(`/api/admin/contratos/importados?clienteId=${encodeURIComponent(clienteId)}`).then((r) => r.json()).then((j) => {
      if (!ativo) return;
      if (j.ok) setLista(j.data as ContratoImportadoResumo[]); else setErro(j.erro || 'Não foi possível carregar os contratos importados.');
    }).catch(() => { if (ativo) setErro('Não foi possível carregar os contratos importados.'); });
    return () => { ativo = false; };
  }, [clienteId]);
  return <article className={`${styles.profileCard} ${styles.fullWidth}`}>
    <div className={styles.cardLabel}>Contratos importados</div>
    {erro && <p role="alert">{erro}</p>}
    {!erro && lista === null && <p>Carregando contratos importados…</p>}
    {lista && lista.length === 0 && <p>Nenhum contrato importado para este cliente.</p>}
    {lista && lista.length > 0 && <ul className={styles.detailBullets}>
      {lista.map((c) => <li key={c.id}>
        <Link href={`/admin/contratos?importacaoId=${c.id}`}>{dataBr(c.data_evento)} · {c.pacote || 'Pacote não informado'}{c.convidados != null ? ` · ${c.convidados} convidados` : ''}</Link>
        <span> · {SITUACAO[c.situacaoEvento]}</span>
      </li>)}
    </ul>}
  </article>;
}
