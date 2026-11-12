'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ItemResultado, ResultadosSatisfacao } from '@/lib/satisfacao/resultados';
import { dataBr } from '@/lib/marketing/apresentacao';
import styles from '../marketing/marketing.module.css';
import proprio from './satisfacao.module.css';
import { mensagemDaFalha, podeRepetir, recusada, useLeituraViva } from './leitura';

/**
 * Satisfação › Resultados (PS-4; mockup "Pesquisa de satisfação — telas", tela 2). Período pela data da festa
 * (D-PS4-1), unidades do escopo VER; filtros de grupo/comentário só da lista ("X de Y"). O comentário do cliente é texto
 * (o React escapa; sem links automáticos). Aviso de poucas respostas (D-PS4-4) é só sobre a volatilidade do número.
 */
const ATALHOS = [
  { valor: 'ultimos-3-meses', rotulo: 'Últimos 3 meses' },
  { valor: 'este-mes', rotulo: 'Este mês' },
  { valor: 'mes-passado', rotulo: 'Mês passado' },
  { valor: 'personalizado', rotulo: 'Personalizado' },
];
const ROTULO_ASPECTO = { comida: 'Comida e bebida', equipe: 'Equipe e atendimento', espaco: 'Espaço e decoração' } as const;

export default function SatisfacaoResultados() {
  const [atalho, setAtalho] = useState('ultimos-3-meses');
  const [inicio, setInicio] = useState('');
  const [fim, setFim] = useState('');
  const [unidade, setUnidade] = useState('');
  const [grupo, setGrupo] = useState('');
  const [comComentario, setComComentario] = useState(false);

  // PS4-R4-C2: período personalizado só consulta com as duas datas (antes caía em silêncio no padrão da API).
  const aguardandoDatas = atalho === 'personalizado' && !(inicio && fim);
  const url = useMemo(() => {
    if (aguardandoDatas) return '';
    const q = new URLSearchParams();
    if (atalho === 'personalizado') { q.set('inicio', inicio); q.set('fim', fim); } else q.set('atalho', atalho);
    if (unidade) q.set('unidade', unidade);
    if (grupo) q.set('grupo', grupo);
    if (comComentario) q.set('comComentario', '1');
    return `/api/admin/satisfacao/resultados?${q.toString()}`;
  }, [aguardandoDatas, atalho, inicio, fim, unidade, grupo, comComentario]);
  const { paginas, falha, carregando, anexando, verMais, recarregar } = useLeituraViva<ResultadosSatisfacao>(url);
  const dados = paginas[0] ?? null;
  const itens: ItemResultado[] = paginas.flatMap((p) => p.lista.itens);
  const proximo = paginas.length > 0 ? paginas[paginas.length - 1].lista.proximo : null;

  const c = dados?.cartoes;
  return <div className={styles.pagina} data-satisfacao-resultados>
    <header className={styles.topo}><div><h1>Satisfação</h1><p>Como os clientes avaliaram as festas. O período considera a data da festa.</p></div></header>

    <div className={styles.filtros} role="group" aria-label="Filtros dos resultados">
      <label>Período<select value={atalho} onChange={(e) => setAtalho(e.target.value)}>
        {ATALHOS.map((a) => <option key={a.valor} value={a.valor}>{a.rotulo}</option>)}</select></label>
      {atalho === 'personalizado' && <>
        <label>De<input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} /></label>
        <label>Até<input type="date" value={fim} onChange={(e) => setFim(e.target.value)} /></label></>}
      {dados && (dados.unidades.length > 0 || dados.semUnidade) && <label>Unidade<select value={unidade} onChange={(e) => setUnidade(e.target.value)}>
        <option value="">Todas as minhas unidades</option>
        {dados.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
        {dados.semUnidade && <option value="sem-unidade">Festas sem unidade</option>}</select></label>}
    </div>

    {aguardandoDatas && <p role="status" className={styles.muted} data-aguardando-datas>Escolha as duas datas para ver os resultados do período.</p>}
    {carregando && <p role="status" aria-busy="true" className={styles.muted}>Carregando…</p>}
    {falha && (() => { const m = mensagemDaFalha(falha); return <section className={styles.cartao} role="alert" data-sem-acesso={recusada(falha) ? '' : undefined}><h2>{m.titulo}</h2><p>{m.texto}</p>{podeRepetir(falha) && <button type="button" className={styles.secundario} data-tentar-novamente onClick={recarregar}>Tentar novamente</button>}
      {/* PS4-R4-C1: recusa com uma unidade escolhida (ex.: acesso a ela revogado) — sair do filtro relê o escopo atual. */}
      {recusada(falha) && unidade && <button type="button" className={styles.secundario} data-limpar-unidade onClick={() => setUnidade('')}>Ver todas as minhas unidades</button>}</section>; })()}

    {dados && c && <>
      <p className={styles.muted} data-periodo>Festas de {dataBr(dados.periodo.inicio)} a {dataBr(dados.periodo.fim)}.</p>
      <div className={proprio.cartoes}>
        <div className={styles.kpi} data-cartao="nps"><span>NPS</span><strong>{c.nps === null ? '—' : c.nps}</strong>
          <small>{c.respostas === 0 ? 'Sem respostas no período' : `${c.grupos.promotores} promotores · ${c.grupos.neutros} neutros · ${c.grupos.detratores} detratores`}</small>
          {c.respostas > 0 && c.respostas < 10 && <small className={proprio.aviso} data-poucas-respostas>Poucas respostas: o número muda muito.</small>}</div>
        <div className={styles.kpi} data-cartao="respostas"><span>Respostas</span><strong>{c.respostas}</strong>
          <small>{c.taxa === null ? 'Taxa —' : `${c.taxa.replace('.', ',')}% sobre as pesquisas criadas`}</small></div>
        <div className={styles.kpi} data-cartao="criadas"><span>Pesquisas criadas</span><strong>{c.pesquisasCriadas}</strong>
          <small>{c.aindaNoPrazo} ainda no prazo · {c.semContato} sem contato registrado</small></div>
        {(Object.keys(ROTULO_ASPECTO) as Array<keyof typeof ROTULO_ASPECTO>).map((k) => <div key={k} className={styles.kpi} data-cartao={k}><span>{ROTULO_ASPECTO[k]}</span>
          <strong>{c.aspectos[k].media === null ? '—' : c.aspectos[k].media.replace('.', ',')}</strong><small>{c.aspectos[k].respostas} avaliações (1 a 5)</small></div>)}
        {c.retornosAbertos && <Link className={styles.kpi} href="/admin/satisfacao/retornos" data-cartao="retornos"><span>Retornos abertos</span><strong>{c.retornosAbertos.abertos}</strong>
          <small>{c.retornosAbertos.unidadesComTratar < c.retornosAbertos.unidadesNoFiltro
            ? `nas unidades em que você trata retornos (${c.retornosAbertos.unidadesComTratar} de ${c.retornosAbertos.unidadesNoFiltro})` : 'notas de 0 a 6 aguardando contato'}</small></Link>}
      </div>
      {c.respostas > 0 && <section className={styles.cartao} aria-labelledby="t-distribuicao">
        <h2 id="t-distribuicao">Notas de 0 a 10</h2>
        <ol className={proprio.histograma} data-histograma>{c.histograma.map((q, nota) => <li key={nota} title={`Nota ${nota}: ${q}`}>
          <span className={proprio.barra} data-faixa={nota <= 6 ? 'detrator' : nota <= 8 ? 'neutro' : 'promotor'} style={{ height: `${Math.max(4, Math.round((q / Math.max(...c.histograma, 1)) * 100))}%` }} />
          <b>{nota}</b><small>{q}</small></li>)}</ol>
      </section>}

      <section className={styles.cartao} aria-labelledby="t-respostas">
        <h2 id="t-respostas">Respostas</h2>
        <div className={styles.filtros} role="group" aria-label="Filtros da lista">
          <label>Mostrar<select value={grupo} onChange={(e) => setGrupo(e.target.value)}>
            <option value="">Todas</option><option value="promotores">Promotores (9–10)</option><option value="neutros">Neutros (7–8)</option><option value="detratores">Detratores (0–6)</option></select></label>
          <label className={proprio.check}><input type="checkbox" checked={comComentario} onChange={(e) => setComComentario(e.target.checked)} /> Só com comentário</label>
        </div>
        <p className={styles.muted} data-contagem>{dados.lista.totalFiltrado} de {dados.lista.total} respostas</p>
        {itens.length === 0 ? <p className={styles.vazio}>{dados.lista.total === 0 ? 'Ainda não há respostas neste período.' : 'Nenhuma resposta com estes filtros.'}</p>
          : <ul className={proprio.lista}>{itens.map((r) => <li key={r.id} data-resposta={r.id}>
            <div className={proprio.linhaTopo}><strong data-nota-faixa={r.notaIndicacao <= 6 ? 'detrator' : r.notaIndicacao <= 8 ? 'neutro' : 'promotor'}>Nota {r.notaIndicacao}</strong>
              <span>{r.primeiroNome} · festa em {dataBr(r.dataFesta)}{r.unidade ? ` · ${r.unidade}` : ''}</span>
              {r.retorno && <Link href={`/admin/satisfacao/retornos?estado=${r.retorno.estado}&tarefa=${r.retorno.tarefaId}`} className={styles.selo} data-retorno={r.retorno.estado}>
                {r.retorno.estado === 'ABERTA' ? 'Retorno aberto' : 'Retorno concluído'}</Link>}</div>
            <p className={proprio.aspectos}>Comida {r.notaComida ?? '—'} · Equipe {r.notaEquipe ?? '—'} · Espaço {r.notaEspaco ?? '—'}</p>
            {r.comentario && <p className={proprio.comentario}>“{r.comentario}”</p>}
          </li>)}</ul>}
        {proximo && <button type="button" className={styles.secundario} disabled={anexando} onClick={() => void verMais(proximo)}>{anexando ? 'Carregando…' : 'Ver mais'}</button>}
      </section>
    </>}
  </div>;
}
