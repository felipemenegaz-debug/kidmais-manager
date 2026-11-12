'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { listarParaRevisao, type ItemParaRevisao } from './cliente-importacao';
import styles from './importacao.module.css';
import real from './importacao-real.module.css';

const dataBr = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : 'Data da festa não lida');
const envio = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};

/**
 * Contratos aguardando revisão (L1): revisões abertas e arquivos lidos sem revisão, das festas mais próximas para as
 * mais distantes. Resolve o contrato lido que ficava "perdido" quando a pessoa saía da tela.
 */
export default function ListaAguardando({ atualizar, onRevisar }: { atualizar: number; onRevisar(item: ItemParaRevisao): void }) {
  const [estado, setEstado] = useState<{ itens: ItemParaRevisao[]; proximo: string | null; erro: string | null; carregando: boolean }>({ itens: [], proximo: null, erro: null, carregando: true });
  useEffect(() => {
    let ativo = true;
    void listarParaRevisao(adminFetch).then((r) => {
      if (!ativo) return;
      setEstado(r.ok ? { itens: r.dados.itens, proximo: r.dados.proximo, erro: null, carregando: false } : { itens: [], proximo: null, erro: r.mensagem, carregando: false });
    });
    return () => { ativo = false; };
  }, [atualizar]);

  async function mais() {
    if (!estado.proximo) return;
    setEstado({ ...estado, carregando: true });
    const r = await listarParaRevisao(adminFetch, estado.proximo);
    setEstado(r.ok ? { itens: [...estado.itens, ...r.dados.itens], proximo: r.dados.proximo, erro: null, carregando: false } : { ...estado, erro: r.mensagem, carregando: false });
  }

  if (!estado.carregando && !estado.erro && !estado.itens.length) return null;
  return <section className={`${styles.painel} ${real.lote}`} aria-labelledby="aguardando-titulo" aria-busy={estado.carregando}>
    <h2 id="aguardando-titulo" className={styles.titulo}>Contratos aguardando revisão</h2>
    {estado.erro && <p className={styles.erro} role="alert">{estado.erro}</p>}
    <ul className={real.loteLista}>
      {estado.itens.map((i) => <li key={i.documentoId} className={real.loteItem}>
        <div className={real.loteNome}>
          <strong>{i.contratante ?? i.arquivo}</strong>
          <span>{dataBr(i.dataFesta)} · {i.arquivo} · enviado em {envio(i.enviadoEm)}</span>
        </div>
        <span className={real.loteEstado} data-estado={i.grupo === 'REVISAO' ? 'PRONTO' : 'LIDO'}>{i.grupo === 'REVISAO' ? 'Em revisão' : 'Lido, revisão não aberta'}</span>
        <div className={real.loteAcoes}>
          <button type="button" className={styles.linkBotao} onClick={() => onRevisar(i)} aria-label={`Revisar ${i.contratante ?? i.arquivo}`}>Revisar</button>
        </div>
      </li>)}
    </ul>
    {estado.proximo && <button type="button" className={styles.fantasma} disabled={estado.carregando} onClick={() => void mais()}>Mostrar mais</button>}
  </section>;
}
