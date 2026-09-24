'use client';

import { useEffect, useState } from 'react';
import { LIMITES_PIZZA_PARTY, erroConvidadosPizzaParty } from '../../lib/comercial/pacotes-v1';
import styles from './FechamentoWizard.module.css';

type Extra = { id: string; nome: string; preco: number; unidadeCobranca: string };

/** Consulta preços de extras sem atribuir preço base nem liberar contratação da Pizza. */
export default function AdicionaisPizzaConsulta() {
  const [data, setData] = useState('');
  const [convidados, setConvidados] = useState<number>(LIMITES_PIZZA_PARTY.minimo);
  const [itens, setItens] = useState<Extra[] | null>(null);
  const [erro, setErro] = useState('');
  const erroQuantidade = erroConvidadosPizzaParty('PIZZA_PARTY', convidados);
  useEffect(() => {
    const controller = new AbortController();
    if (!data || erroQuantidade) return;
    void fetch(`/api/fechamentos/adicionais?pacote=pizza_party_scienza&data=${encodeURIComponent(data)}&convidados=${convidados}`, { signal: controller.signal, cache: 'no-store' })
      .then(async r => { if (!r.ok) throw Error(); return r.json(); })
      .then(body => { if (!controller.signal.aborted) { setItens(body.adicionais); setErro(''); } })
      .catch(() => { if (!controller.signal.aborted) { setItens(null); setErro('Não foi possível consultar os adicionais.'); } });
    return () => controller.abort();
  }, [data, convidados, erroQuantidade]);
  return <section className={styles.consultPanel} aria-label="Adicionais da Pizza Party">
    <h3>Adicionais da Pizza Party</h3>
    <p>Consulte os mesmos preços e faixas dos demais pacotes. O preço base da Pizza Party permanece sob consulta; esta consulta não reserva a data.</p>
    <p>Pizza Party: mínimo de 20 e máximo de 100 convidados.</p>
    <label className={styles.field}>Data pretendida<input type="date" value={data} onChange={e => { setItens(null); setData(e.target.value); }} /></label>
    <label className={styles.field}>Convidados para consultar a faixa<input type="number" min={LIMITES_PIZZA_PARTY.minimo} max={LIMITES_PIZZA_PARTY.maximo} step={1} value={convidados} onChange={e => { setItens(null); setErro(''); setConvidados(Number(e.target.value)); }} /></label>
    {(erroQuantidade || erro) && <p role="alert">{erroQuantidade || erro}</p>}
    {!data && <p>Informe a data para consultar a tabela vigente.</p>}
    {!erroQuantidade && itens?.length === 0 && <p>Nenhum adicional com preço vigente para essa data e quantidade.</p>}
    {!erroQuantidade && itens && <ul>{itens.map(item => <li key={item.id}>{item.nome}: {item.preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
      {item.unidadeCobranca === 'UNIDADE' ? ' por unidade extra' : item.unidadeCobranca === 'CENTO' ? ' por cento' : ' por contratação'}</li>)}</ul>}
  </section>;
}
