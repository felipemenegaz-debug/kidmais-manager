'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { Marcos, OrigemContato } from '@/lib/guarda/marcos';
import { avisoDeSaida, type SaidaContato } from '@/lib/guarda/saidas-contato';
import { formatTelefone } from '@/lib/clientes/utils';
import styles from './Clientes.module.css';

type Guarda = { marcos: Marcos & { clienteId: string }; saidas: SaidaContato[] };
const dataBr = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('/') : '—');
const ORIGEM: Record<OrigemContato, string> = {
  WHATSAPP: 'mensagem no WhatsApp', FORMULARIO_SITE: 'pedido pelo site', PESQUISA: 'resposta à pesquisa', CADASTRO: 'cadastro (sem contato registrado)',
};

/**
 * Guarda dos dados (fase 1, 19/11/2026). SOMENTE LEITURA (G3): mostra as datas que contam para os prazos dos textos
 * legais e as saídas de campanha por contato. Nada é apagado ou alterado por esta tela.
 */
export default function GuardaDoCliente({ clienteId }: { clienteId: string }) {
  const [guarda, setGuarda] = useState<Guarda | null>(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    let ativo = true;
    adminFetch(`/api/admin/clientes/${encodeURIComponent(clienteId)}/guarda`).then((r) => r.json()).then((j) => {
      if (!ativo) return;
      if (j.ok) setGuarda(j.data as Guarda); else setErro(j.erro || 'Não foi possível carregar as datas de guarda.');
    }).catch(() => { if (ativo) setErro('Não foi possível carregar as datas de guarda.'); });
    return () => { ativo = false; };
  }, [clienteId]);

  const m = guarda?.marcos;
  return <article className={`${styles.profileCard} ${styles.fullWidth}`}>
    <div className={styles.cardLabel}>Guarda dos dados</div>
    {erro && <p role="alert">{erro}</p>}
    {!erro && !guarda && <p>Carregando datas de guarda…</p>}
    {guarda && m && <>
      {guarda.saidas.length > 0 && <ul className={styles.detailBullets}>
        {guarda.saidas.map((s) => <li key={`${s.tipo}-${s.valor}`} role="status">
          {s.tipo === 'EMAIL' ? s.valor : formatTelefone(s.valor.length > 11 && s.valor.startsWith('55') ? s.valor.slice(2) : s.valor)}: {avisoDeSaida(s)}
        </li>)}
      </ul>}
      <dl className={styles.detailList}>
        <div><dt>Situação</dt><dd>{m.categoria === 'CONTRATOU' ? 'Já contratou festa' : 'Interessado (nunca contratou)'}</dd></div>
        {m.categoria === 'CONTRATOU' && <div><dt>Última festa</dt><dd>{dataBr(m.ultimaFesta)}</dd></div>}
        {m.ultimoPagamento && <div><dt>Último pagamento</dt><dd>{dataBr(m.ultimoPagamento)}</dd></div>}
        <div><dt>Último contato</dt><dd>{m.ultimoContato ? `${dataBr(m.ultimoContato.dia)} · ${ORIGEM[m.ultimoContato.origem]}` : 'Nenhum registrado'}</dd></div>
        {m.contrato && <div><dt>Contrato guardado até</dt><dd>{dataBr(m.contrato.data)} · {m.contrato.motivo}</dd></div>}
        {m.campanhas && <div><dt>Contato para campanhas até</dt><dd>{dataBr(m.campanhas.data)} · {m.campanhas.motivo}</dd></div>}
        {m.interessado && <div><dt>Dados guardados até</dt><dd>{dataBr(m.interessado.data)} · {m.interessado.motivo}</dd></div>}
      </dl>
      <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 10 }}>Só informação: por enquanto nada é apagado automaticamente. Um novo contato ou uma nova festa renova os prazos.</p>
    </>}
  </article>;
}
