'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { FestaImportada as Dados } from '@/lib/festas/importadas';
import { nomeComIdade } from '@/lib/festas/buffet';
import { horarioResumo } from '@/lib/festas/politica';
import styles from './festa.module.css';

export default function FestaImportada({ importacaoId }: { importacaoId: string }) {
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    let ativo = true;
    adminFetch(`/api/admin/festas?importacaoId=${encodeURIComponent(importacaoId)}`).then(r => r.json()).then(j => {
      if (!ativo) return;
      if (j.ok) setDados(j.data.importada); else setErro(j.erro || 'Não foi possível carregar a festa.');
    }).catch(() => { if (ativo) setErro('Não foi possível carregar a festa.'); });
    return () => { ativo = false; };
  }, [importacaoId]);
  const s = dados?.snapshot;
  return <main className={styles.page}>
    <Link href="/admin/festas?visao=proximas">← Festas</Link>
    <h1>Festa de contrato importado</h1>
    {erro && <p role="alert">{erro}</p>}
    {!dados && !erro && <p>Carregando festa…</p>}
    {dados && s && <>
      <section className={styles.card}>
        <p className={styles.identityLabel}>Contratante</p><h2>{s.contratante.nomeCompleto}</h2>
        <p>{nomeComIdade(s)}</p>
        <p>{s.evento.data.split('-').reverse().join('/')} • {horarioResumo(s) || 'Horário não informado'}</p>
        <p>{s.evento.convidados == null ? 'Convidados não informados' : `${s.evento.convidados} convidados`}</p>
        <p>Tema: {s.evento.tema || 'Não informado'}</p>
        <Link href={`/clientes/${dados.clienteId}`}>Abrir cliente</Link>
      </section>
      <section className={styles.card}><h2>Pacote e buffet do contrato</h2><p>{s.evento.pacote.nome}</p>
        {dados.itens && <p>{dados.itens}</p>}
        {dados.buffet?.itens && <p>{dados.buffet.itens}</p>}
        {dados.buffet?.observacoes && <p>{dados.buffet.observacoes}</p>}
        {dados.buffet?.restricoes && <p>Restrições: {dados.buffet.restricoes}</p>}
        {dados.observacoes && <p>{dados.observacoes}</p>}
      </section>
      <p>Dados confirmados na importação. Checklist, alterações da contratação e registros financeiros ainda não estão disponíveis para contratos importados.</p>
    </>}
  </main>;
}
