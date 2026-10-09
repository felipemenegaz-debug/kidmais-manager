'use client';
import { useState } from 'react';
import { csvPresencas, resumoPresencas, type RespostaPresenca } from '@/lib/convites/presencas';

export default function ConvitePresencas({ respostas, contratados, ui, busy, atualizar }: {
  respostas: RespostaPresenca[]; contratados: number | null; ui: Record<string, string>; busy: boolean; atualizar: () => void;
}) {
  const [busca, setBusca] = useState(''), [filtro, setFiltro] = useState('todas');
  const resumo = resumoPresencas(respostas, contratados);
  const pessoasDiferenca = `${Math.abs(resumo.diferenca ?? 0)} ${Math.abs(resumo.diferenca ?? 0) === 1 ? 'pessoa' : 'pessoas'}`;
  const normalizar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const lista = respostas.filter(r => normalizar(r.nome).includes(normalizar(busca.trim())) && (filtro === 'todas' || r.presenca === (filtro === 'sim')));
  function exportar() {
    const url = URL.createObjectURL(new Blob([csvPresencas(lista)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'confirmacoes-convite.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className={ui.painel} aria-labelledby="titulo-confirmacoes">
    <p className={ui.sobretitulo}>QUEM VEM COMEMORAR</p><h2 id="titulo-confirmacoes">Confirmações de presença</h2>
    <div className={ui.indicadores}>
      <div><strong>{resumo.total}</strong><span>Pessoas confirmadas</span></div>
      <div><strong>{resumo.adultos} / {resumo.criancas}</strong><span>Adultos / crianças</span></div>
      <div><strong>{resumo.familias}</strong><span>Famílias confirmadas</span></div>
      <div><strong>{contratados ?? '—'}</strong><span>Convidados previstos no contrato</span></div>
    </div>
    {contratados != null && <div className={ui.comparacao}>
      <progress max={Math.max(1, contratados)} value={Math.min(resumo.total, contratados)} aria-label={`${resumo.total} pessoas confirmadas; ${contratados} convidados previstos no contrato`} />
      <p>{resumo.diferenca! > 0 ? `${pessoasDiferenca} acima da quantidade prevista. Confira com o buffet.` : resumo.diferenca === 0 ? 'As confirmações atingiram a quantidade prevista no contrato.' : `${pessoasDiferenca} abaixo da quantidade prevista no contrato.`}</p>
    </div>}
    <small>Comparação para planejamento, sem alterar contrato ou cobrança. As confirmações somam todas as crianças; cortesias e convidados pagantes seguem as regras do contrato.</small>
    <div className={ui.acoes}><button type="button" disabled={busy} onClick={atualizar}>Atualizar confirmações</button><button type="button" disabled={!lista.length} onClick={exportar}>Exportar lista filtrada (CSV)</button></div>
    <label>Buscar família<input type="search" maxLength={100} value={busca} onChange={e => setBusca(e.target.value)} placeholder="Digite um nome" /></label>
    <div className={ui.acoes} role="group" aria-label="Filtrar confirmações">{[['todas', 'Todas'], ['sim', 'Confirmadas'], ['nao', 'Não vão']].map(([id, nome]) => <button type="button" key={id} aria-pressed={filtro === id} onClick={() => setFiltro(id)}>{nome}</button>)}</div>
    <p>{lista.length} de {respostas.length} respostas · {resumo.recusas} {resumo.recusas === 1 ? 'família não vai' : 'famílias não vão'}</p>
    {lista.length ? <div className={ui.tabela}><table><thead><tr><th>Família</th><th>Resposta</th><th>Adultos</th><th>Crianças</th><th>Total</th></tr></thead><tbody>{lista.map((r, n) => <tr key={n}><td>{r.nome}</td><td>{r.presenca ? 'Confirmada' : 'Não vai'}</td><td>{r.presenca ? r.adultos : 0}</td><td>{r.presenca ? r.criancas : 0}</td><td>{r.presenca ? r.adultos + r.criancas : 0}</td></tr>)}</tbody></table></div> : <p>{respostas.length ? 'Nenhuma resposta corresponde ao filtro.' : 'As confirmações aparecerão aqui depois de compartilhar o convite.'}</p>}
    <small>Uma resposta por família e dispositivo, sem verificação de identidade. Esta lista mostra quem respondeu; ainda não acompanha famílias que não responderam.</small>
  </section>;
}
