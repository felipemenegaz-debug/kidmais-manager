'use client';

import { useEffect, useState } from 'react';

type Extra = { id: string; nome: string; preco: number; unidadeCobranca: string };

/** Consulta preços de extras sem atribuir preço base nem liberar contratação da Pizza. */
export default function AdicionaisPizzaConsulta() {
  const [data, setData] = useState('');
  const [convidados, setConvidados] = useState(80);
  const [itens, setItens] = useState<Extra[] | null>(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    if (!data || !Number.isInteger(convidados) || convidados < 1 || convidados > 150) return;
    void fetch(`/api/fechamentos/adicionais?pacote=pizza_party_scienza&data=${encodeURIComponent(data)}&convidados=${convidados}`, { signal: controller.signal, cache: 'no-store' })
      .then(async r => { if (!r.ok) throw Error(); return r.json(); })
      .then(body => { setItens(body.adicionais); setErro(''); })
      .catch(() => { if (!controller.signal.aborted) { setItens(null); setErro('Não foi possível consultar os adicionais.'); } });
    return () => controller.abort();
  }, [data, convidados]);
  return <section aria-label="Adicionais da Pizza Party">
    <h3>Adicionais da Pizza Party</h3>
    <p>Consulte os mesmos preços e faixas dos demais pacotes. O preço base da Pizza Party permanece sob consulta; esta consulta não reserva a data.</p>
    <label>Data pretendida<input type="date" value={data} onChange={e => { setItens(null); setData(e.target.value); }} /></label>
    <label>Convidados para consultar a faixa<input type="number" min={1} max={150} step={1} value={convidados} onChange={e => { setItens(null); setConvidados(Number(e.target.value)); }} /></label>
    {erro && <p role="alert">{erro}</p>}
    {!data && <p>Informe a data para consultar a tabela vigente.</p>}
    {itens && <ul>{itens.map(item => <li key={item.id}>{item.nome}: {item.preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
      {item.unidadeCobranca === 'UNIDADE' ? ' por unidade extra' : item.unidadeCobranca === 'CENTO' ? ' por cento' : ' por contratação'}</li>)}</ul>}
  </section>;
}
