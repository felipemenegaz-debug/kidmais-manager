'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { PainelMarketing, LinhaPainel } from '@/lib/marketing/metricas';
import type { OpcaoOrigem } from '@/lib/marketing/origens';
import type { SugestaoDatas } from '@/lib/marketing/sugestoes';
import { dataBr, percentual, reais, receitaContratadaTexto } from '@/lib/marketing/apresentacao';
import { AtribuicaoExplicada } from './AtribuicaoExplicada';
import { CabecalhoMarketing, EstadoCarga, useMarketing } from './comum';
import styles from './marketing.module.css';

type Dados = {
  hoje: string; painel: PainelMarketing; unidades: Array<{ id: string; nome: string }>; origens: OpcaoOrigem[];
  campanhas: Array<{ id: string; nome: string; status: string }>; sugestoes: SugestaoDatas; capacidades: string[];
};

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function nomeDaLinha(l: LinhaPainel, origens: OpcaoOrigem[]) {
  if (l.campanhaId) return l.campanhaNome ?? 'Campanha';
  if (l.origemCodigo === 'SEM_REGISTRO') return 'Origem não registrada';
  if (l.origemCodigo === 'DESCONHECIDA') return 'Desconhecida (sem evidência)';
  return origens.find((o) => o.codigo === l.origemCodigo)?.rotulo ?? l.origemCodigo ?? '—';
}

export default function MarketingVisao() {
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [unidadeId, setUnidadeId] = useState('');
  const consulta = new URLSearchParams({ ...(de ? { de } : {}), ...(ate ? { ate } : {}), ...(unidadeId ? { unidadeId } : {}) }).toString();
  const { dados, falha, carregando, recarregar } = useMarketing<Dados>(`/api/admin/marketing/resumo${consulta ? `?${consulta}` : ''}`);
  const p = dados?.painel;
  return <main className={styles.pagina}>
    <CabecalhoMarketing titulo="Marketing" descricao="Da divulgação ao contrato: contatos, negociações e receita por campanha e origem, com as regras de contagem à vista." />
    <form className={styles.filtros} onSubmit={(e) => e.preventDefault()} aria-label="Filtros do período">
      <label>De<input type="date" value={de || p?.periodo.de || ''} onChange={(e) => setDe(e.target.value)} /></label>
      <label>Até<input type="date" value={ate || p?.periodo.ate || ''} onChange={(e) => setAte(e.target.value)} /></label>
      {dados && dados.unidades.length > 0 && <label>Unidade<select value={unidadeId} onChange={(e) => setUnidadeId(e.target.value)}>
        <option value="">Todas</option>{dados.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
      </select></label>}
    </form>
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {dados && p && <>
      <div className={styles.kpis}>
        <Kpi rotulo="Contatos recebidos" valor={String(p.total.contatos)} detalhe="pelo site e registrados" />
        <Kpi rotulo="Negociações" valor={String(p.total.negociacoes)} detalhe="iniciadas no período" />
        <Kpi rotulo="Contratos assinados" valor={String(p.total.contratos)} detalhe={p.total.cancelamentos ? `${p.total.cancelamentos} cancelado(s) no período` : 'no período'} />
        <Kpi rotulo="Receita contratada" valor={p.total.receitaContratadaSituacao === 'INDISPONIVEL' ? 'indisponível' : reais(p.total.receitaContratadaCentavos)}
          detalhe={p.total.contratosSemValor ? `${p.total.receitaContratadaSituacao === 'PARCIAL' ? 'subtotal conhecido; ' : ''}${p.total.contratosSemValor} contrato(s) sem valor` : 'contratos assinados no período'} />
        <Kpi rotulo="Receita recebida" valor={reais(p.total.receitaRecebidaCentavos)} detalhe="já descontados estornos e devoluções" />
        <Kpi rotulo="Conversão contato → contrato" valor={percentual(p.total.conversao)} detalhe={p.total.contatos ? `${p.total.contatosComContrato} de ${p.total.contatos}` : 'sem contatos no período'} />
      </div>
      {p.negociacoesSemOrigem > 0 && <p className={styles.aviso} role="status">{p.negociacoesSemOrigem} negociação(ões) do período sem origem registrada. <Link href="/admin/marketing/origens">Ver origens dos contatos</Link> — a origem pode ser informada na própria negociação.</p>}
      <section className={styles.cartao} aria-labelledby="t-campanhas">
        <h2 id="t-campanhas">Por campanha e origem</h2>
        {p.linhas.length === 0 ? <p className={styles.vazio}>Nada registrado no período. Crie uma campanha ou informe a origem nas negociações.</p> : <>
          <div className={`${styles.tabelaWrap} ${styles.responsiva}`}><table className={styles.tabela}>
            <thead><tr><th>Campanha / origem</th><th className={styles.num}>Cliques no link</th><th className={styles.num}>Cliques WhatsApp</th><th className={styles.num}>Contatos</th><th className={styles.num}>Negociações</th><th className={styles.num}>Contratos</th><th className={styles.num}>Conversão</th><th className={styles.num}>Receita contratada</th><th className={styles.num}>Receita recebida</th><th className={styles.num}>Orçamento informado</th></tr></thead>
            <tbody>{p.linhas.map((l) => <tr key={l.chave}>
              <td>{nomeDaLinha(l, dados.origens)}{l.campanhaId && <> <span className={styles.seloVioleta}>campanha</span></>}</td>
              <td className={styles.num}>{l.cliquesLink}</td><td className={styles.num}>{l.cliquesWhatsapp}</td><td className={styles.num}>{l.contatos}</td>
              <td className={styles.num}>{l.negociacoes}</td><td className={styles.num}>{l.contratos}{l.cancelamentos ? ` (−${l.cancelamentos} canc.)` : ''}</td>
              <td className={styles.num}>{percentual(l.conversao)}</td><td className={styles.num}>{receitaContratadaTexto(l)}</td><td className={styles.num}>{reais(l.receitaRecebidaCentavos)}</td>
              <td className={styles.num}>{l.orcamentoCentavos === null ? '—' : reais(l.orcamentoCentavos)}</td>
            </tr>)}</tbody>
          </table></div>
          <div className={styles.cards}>{p.linhas.map((l) => <article key={l.chave} className={styles.card}>
            <strong>{nomeDaLinha(l, dados.origens)}</strong>
            <p className={styles.muted}>{l.contatos} contato(s) · {l.negociacoes} negociação(ões) · {l.contratos} contrato(s)</p>
            <p>Contratada {receitaContratadaTexto(l)} · Recebida {reais(l.receitaRecebidaCentavos)}</p>
            <p className={styles.muted}>Conversão {percentual(l.conversao)} · cliques {l.cliquesLink} link / {l.cliquesWhatsapp} WhatsApp</p>
          </article>)}</div>
        </>}
        <details className={styles.definicoes}>
          <summary>Como estes números são contados</summary>
          <dl>
            <dt>Atribuição</dt><dd>Toque único: cada negociação (e o contrato dela) conta para uma só campanha ou origem — a vigente na negociação. Receita nunca é repetida entre campanhas. Atribuição registra de onde o contato veio; não prova que a campanha causou a venda.</dd>
            <dt>Cliques</dt><dd>Clique no link da campanha e no botão de WhatsApp são eventos separados. Clique não é contato nem conversa.</dd>
            <dt>Contatos</dt><dd>Pedidos recebidos pelo site e registros manuais com data de recebimento no período.</dd>
            <dt>Negociações</dt><dd>Negociações iniciadas no período, pela origem registrada nelas.</dd>
            <dt>Contratos</dt><dd>Contratos assinados no período (cancelados aparecem à parte).</dd>
            <dt>Receita contratada</dt><dd>Valor vigente dos contratos assinados no período. Contrato sem valor legível não conta como zero: a receita aparece como subtotal conhecido (com a quantidade sem valor) ou indisponível quando nenhum valor é conhecido.</dd>
            <dt>Receita recebida</dt><dd>Recebimentos confirmados no período menos estornos e devoluções do período.</dd>
            <dt>Conversão</dt><dd>Contatos do período que já têm contrato assinado ÷ contatos do período. Sem contato no período: indisponível.</dd>
            <dt>Sem evidência</dt><dd>Contato sem link de campanha fica como “desconhecida”; nada é estimado.</dd>
          </dl>
        </details>
        <AtribuicaoExplicada />
      </section>
      <section className={styles.cartao} aria-labelledby="t-datas">
        <h2 id="t-datas">Datas vagas para divulgar <span className={styles.selo}>sugestão</span></h2>
        <p className={styles.muted}>Lido da agenda atual{dados.sugestoes.escopo === 'EMPRESA' && unidadeId ? ' (agenda da empresa: esta unidade não tem agenda própria)' : ''}. Nada é reservado, bloqueado ou precificado por aqui.</p>
        {!dados.sugestoes.disponivel ? <p className={styles.vazio}>{dados.sugestoes.motivo}</p>
          : dados.sugestoes.datas.length === 0 ? <p className={styles.vazio}>{dados.sugestoes.motivo ?? 'Nenhuma data livre nos próximos dias.'}</p>
            : <><ul className={styles.datas}>{dados.sugestoes.datas.slice(0, 24).map((d) => <li key={d.data} data-fds={d.fimDeSemana}>{DIAS[d.diaSemana]} {dataBr(d.data)} · {d.horariosLivres} horário(s)</li>)}</ul>
              <p className={styles.muted}>Fins de semana em destaque. Para divulgar, <Link href="/admin/marketing/campanhas">crie uma campanha</Link> com o período desejado.</p></>}
      </section>
    </>}
  </main>;
}

function Kpi({ rotulo, valor, detalhe }: { rotulo: string; valor: string; detalhe: string }) {
  return <div className={styles.kpi}><span>{rotulo}</span><strong className={valor === 'indisponível' ? styles.indisponivel : undefined}>{valor}</strong><small>{detalhe}</small></div>;
}
