'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { FORMAS, reaisDe, type FormaFinanceira } from '@/lib/financeiro/calculos';
import styles from './financeiro.module.css';

type Resumo = { recebidoMesCentavos: number; aReceberCentavos: number; aPagarCentavos: number; emAtrasoCentavos: number; saldoPrevistoCentavos: number; pagoMesCentavos: number };
type Recebivel = { id: string; cliente: string; pacote: string; festaId: string | null; parcela: number; vencimento: string; valorCentavos: number; recebidoCentavos: number; saldoCentavos: number; forma: string; status: string; diasAtraso: number };
type Conta = { id: string; descricao: string; favorecido: string | null; categoria: string; categoriaId: string; vencimento: string; valorCentavos: number; saldoCentavos: number; pagoCentavos: number; status: string; forma: string | null };
type Categoria = { id: string; nome: string };
type Fluxo = { saldoInicialCentavos: number; entradasCentavos: number; saidasCentavos: number; saldoFinalCentavos: number; linhas: Array<{ data: string; descricao: string; entrada: number; saida: number; saldo: number; tipo: string }> };
type Relatorio = { faturamentoCentavos: number; recebidoCentavos: number; aReceberCentavos: number; aPagarCentavos: number; inadimplenciaCentavos: number; despesas: Array<{ categoria: string; centavos: number }>; pacotes: Array<{ pacote: string; centavos: number }> };

export type TelaFinanceira = 'visao' | 'receber' | 'pagar' | 'fluxo' | 'relatorios';

const ROTULOS: Record<FormaFinanceira, string> = {
  PIX: 'PIX', CARTAO_CREDITO: 'Cartão de crédito', CARTAO_DEBITO: 'Cartão de débito', BOLETO: 'Boleto', DINHEIRO: 'Dinheiro', TRANSFERENCIA: 'Transferência', OUTRO: 'Outro',
};

function classe(status: string) {
  if (status === 'Vencido') return styles.vencido;
  if (status === 'Pago' || status === 'Reembolsado') return styles.pago;
  return styles.aberto;
}

export type AmostraFinanceira = {
  resumo: Resumo;
  recebiveis: Recebivel[];
  contas: Conta[];
  categorias: Categoria[];
  alertas: string[];
  fluxo: Fluxo;
  relatorio: Relatorio;
};

export default function FinanceiroTelas({ tela, amostra }: { tela: TelaFinanceira; amostra?: AmostraFinanceira }) {
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(!amostra);
  const [resumo, setResumo] = useState<Resumo | null>(amostra?.resumo ?? null);
  const [recebiveis, setRecebiveis] = useState<Recebivel[]>(amostra?.recebiveis ?? []);
  const [contas, setContas] = useState<Conta[]>(amostra?.contas ?? []);
  const [categorias, setCategorias] = useState<Categoria[]>(amostra?.categorias ?? []);
  const [alertas, setAlertas] = useState<string[]>(amostra?.alertas ?? []);
  const [fluxo, setFluxo] = useState<Fluxo | null>(amostra?.fluxo ?? null);
  const [relatorio, setRelatorio] = useState<Relatorio | null>(amostra?.relatorio ?? null);
  const [filtro, setFiltro] = useState('Todos');
  const [busca, setBusca] = useState('');
  const [periodo, setPeriodo] = useState('mes');
  const [dialogo, setDialogo] = useState<'receber' | 'pagar' | 'nova' | null>(null);
  const [alvo, setAlvo] = useState<Recebivel | Conta | null>(null);
  const [aviso, setAviso] = useState('');

  async function carregar() {
    if (amostra) return;
    setCarregando(true);
    setErro('');
    const hoje = new Date();
    const fim = hoje.toISOString().slice(0, 10);
    const inicio = periodo === 'anterior'
      ? new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1).toISOString().slice(0, 10)
      : periodo === '30' ? new Date(hoje.getTime() - 29 * 86400000).toISOString().slice(0, 10) : `${fim.slice(0, 7)}-01`;
    const rotas: Record<TelaFinanceira, string> = {
      visao: '/api/admin/financeiro',
      receber: '/api/admin/financeiro/contas-receber',
      pagar: '/api/admin/financeiro/contas-pagar',
      fluxo: `/api/admin/financeiro/fluxo-caixa?inicio=${inicio}&fim=${fim}`,
      relatorios: '/api/admin/financeiro/relatorios',
    };
    try {
      const corpo = await (await adminFetch(rotas[tela])).json();
      if (!corpo.ok) { setErro(corpo.erro || 'Não foi possível carregar o financeiro.'); return; }
      const data = corpo.data;
      if (tela === 'visao') { setResumo(data.resumo); setRecebiveis(data.recebimentos); setContas(data.pagamentos); setAlertas(data.alertas); }
      if (tela === 'receber') { setRecebiveis(data.recebiveis); setResumo(data.resumo); }
      if (tela === 'pagar') { setContas(data.contas); setCategorias(data.categorias); }
      if (tela === 'fluxo') setFluxo(data);
      if (tela === 'relatorios') setRelatorio(data);
    } catch {
      setErro('Não foi possível carregar o financeiro.');
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    if (amostra) return;
    let ativo = true;
    const hoje = new Date();
    const fim = hoje.toISOString().slice(0, 10);
    const inicio = periodo === 'anterior'
      ? new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1).toISOString().slice(0, 10)
      : periodo === '30' ? new Date(hoje.getTime() - 29 * 86400000).toISOString().slice(0, 10) : `${fim.slice(0, 7)}-01`;
    const rotas: Record<TelaFinanceira, string> = {
      visao: '/api/admin/financeiro',
      receber: '/api/admin/financeiro/contas-receber',
      pagar: '/api/admin/financeiro/contas-pagar',
      fluxo: `/api/admin/financeiro/fluxo-caixa?inicio=${inicio}&fim=${fim}`,
      relatorios: '/api/admin/financeiro/relatorios',
    };
    adminFetch(rotas[tela]).then((resposta) => resposta.json()).then((corpo) => {
      if (!ativo) return;
      if (!corpo.ok) { setErro(corpo.erro || 'Não foi possível carregar o financeiro.'); setCarregando(false); return; }
      const data = corpo.data;
      if (tela === 'visao') { setResumo(data.resumo); setRecebiveis(data.recebimentos); setContas(data.pagamentos); setAlertas(data.alertas); }
      if (tela === 'receber') { setRecebiveis(data.recebiveis); setResumo(data.resumo); }
      if (tela === 'pagar') { setContas(data.contas); setCategorias(data.categorias); }
      if (tela === 'fluxo') setFluxo(data);
      if (tela === 'relatorios') setRelatorio(data);
      setCarregando(false);
    }).catch(() => { if (ativo) { setErro('Não foi possível carregar o financeiro.'); setCarregando(false); } });
    return () => { ativo = false; };
  }, [tela, periodo, amostra]);

  const listaReceber = useMemo(() => recebiveis.filter((item) => {
    const texto = `${item.cliente} ${item.pacote}`.toLowerCase().includes(busca.toLowerCase());
    if (!texto) return false;
    if (filtro === 'A receber') return item.status === 'A receber' || item.status === 'Parcialmente pago';
    if (filtro === 'Vencidos') return item.status === 'Vencido';
    if (filtro === 'Pagos') return item.status === 'Pago';
    return true;
  }), [recebiveis, filtro, busca]);

  async function enviar(url: string, body: unknown) {
    setAviso('');
    const corpo = await (await adminFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (!corpo.ok) { setAviso(corpo.erro || 'Não foi possível concluir.'); return; }
    setDialogo(null);
    await carregar();
  }

  if (carregando) return <main className={styles.pagina} aria-busy="true"><p>Carregando…</p></main>;
  if (erro) return <main className={styles.pagina}><p className={styles.erro} role="alert">{erro}</p><button type="button" onClick={() => void carregar()}>Tentar novamente</button></main>;

  return <main className={styles.pagina}>
    {tela === 'visao' && <>
      <header className={styles.topo}><div><h1>Financeiro</h1><p>Visão geral das entradas, saídas e próximos compromissos.</p></div></header>
      <Periodo valor={periodo} aoMudar={setPeriodo} />
      <Kpis itens={[['Recebido no mês', resumo?.recebidoMesCentavos], ['A receber', resumo?.aReceberCentavos], ['A pagar', resumo?.aPagarCentavos], ['Em atraso', resumo?.emAtrasoCentavos], ['Saldo previsto', resumo?.saldoPrevistoCentavos]]} />
      <div className={styles.grade}>
        <section className={styles.cartao}><h2>Fluxo do período</h2><Grafico linhas={[{ saldo: resumo?.recebidoMesCentavos ?? 0 }, { saldo: (resumo?.saldoPrevistoCentavos ?? 0) }]} /></section>
        <section className={styles.cartao}><h2>Alertas</h2>{alertas.length === 0 && <p className={styles.vazio}>Tudo em dia.</p>}{alertas.map((item) => <p key={item}>{item}</p>)}</section>
      </div>
      <div className={styles.meio}>
        <Lista titulo="Próximos recebimentos" vazio="Nenhum recebimento em aberto." itens={recebiveis.map((item) => ({ id: item.id, titulo: item.cliente, detalhe: item.vencimento, valor: item.saldoCentavos }))} />
        <Lista titulo="Próximos pagamentos" vazio="Você ainda não tem contas a pagar." itens={contas.map((item) => ({ id: item.id, titulo: item.descricao, detalhe: item.vencimento, valor: item.saldoCentavos }))} />
      </div>
    </>}
    {tela === 'receber' && <>
      <header className={styles.topo}><div><h1>Contas a receber</h1><p>Parcelas dos contratos desta empresa.</p></div></header>
      <Kpis itens={[['Total a receber', resumo?.aReceberCentavos], ['Vencido', resumo?.emAtrasoCentavos], ['Recebido no mês', resumo?.recebidoMesCentavos]]} />
      <Filtros opcoes={['Todos', 'A receber', 'Vencidos', 'Pagos']} valor={filtro} aoMudar={setFiltro} />
      <input className={styles.busca} aria-label="Buscar cliente ou festa" placeholder="Buscar cliente ou festa" value={busca} onChange={(evento) => setBusca(evento.target.value)} />
      {listaReceber.length === 0 && <p className={styles.vazio}>{filtro === 'Vencidos' ? 'Tudo em dia. Nenhum recebimento vencido.' : 'Nenhuma parcela neste filtro.'}</p>}
      <Tabela colunas={['Cliente', 'Festa', 'Vencimento', 'Valor', 'Saldo', 'Status', '']} linhas={listaReceber.map((item) => ({
        id: item.id,
        celulas: [item.cliente, item.pacote, item.vencimento, reaisDe(item.valorCentavos), reaisDe(item.saldoCentavos), item.status],
        status: item.status,
        acao: item.saldoCentavos > 0 && item.status !== 'Cancelado' ? () => { setAlvo(item); setDialogo('receber'); } : undefined,
      }))} />
    </>}
    {tela === 'pagar' && <>
      <header className={styles.topo}><div><h1>Contas a pagar</h1><p>Saídas previstas e pagas desta empresa.</p></div><button className={styles.principal} type="button" onClick={() => setDialogo('nova')}>+ Nova conta</button></header>
      <Kpis itens={[['A pagar', contas.filter((item) => item.status === 'A pagar' || item.status === 'Vencido').reduce((t, item) => t + item.saldoCentavos, 0)], ['Vencido', contas.filter((item) => item.status === 'Vencido').reduce((t, item) => t + item.saldoCentavos, 0)], ['Pago no mês', contas.reduce((t, item) => t + item.pagoCentavos, 0)]]} />
      {contas.length === 0 && <p className={styles.vazio}>Você ainda não tem contas a pagar.</p>}
      <Tabela colunas={['Descrição', 'Favorecido', 'Categoria', 'Vencimento', 'Valor', 'Status', '']} linhas={contas.map((item) => ({
        id: item.id,
        celulas: [item.descricao, item.favorecido || '—', item.categoria, item.vencimento, reaisDe(item.valorCentavos), item.status],
        status: item.status,
        acao: item.status !== 'Pago' && item.status !== 'Cancelado' ? () => { setAlvo(item); setDialogo('pagar'); } : undefined,
      }))} />
    </>}
    {tela === 'fluxo' && fluxo && <>
      <header className={styles.topo}><div><h1>Fluxo de caixa</h1><p>Previsto e realizado no período.</p></div></header>
      <Periodo valor={periodo} aoMudar={setPeriodo} />
      <Kpis itens={[['Saldo inicial', fluxo.saldoInicialCentavos], ['Entradas', fluxo.entradasCentavos], ['Saídas', fluxo.saidasCentavos], ['Saldo final', fluxo.saldoFinalCentavos]]} />
      <section className={styles.cartao}><h2>Saldo ao longo do período</h2><Grafico linhas={fluxo.linhas} /></section>
      {fluxo.linhas.length === 0 && <p className={styles.vazio}>Nenhuma movimentação neste período.</p>}
      <Tabela colunas={['Data', 'Descrição', 'Entrada', 'Saída', 'Saldo', '']} linhas={fluxo.linhas.map((item, indice) => ({ id: String(indice), celulas: [item.data, `${item.descricao} (${item.tipo})`, item.entrada ? reaisDe(item.entrada) : '—', item.saida ? reaisDe(item.saida) : '—', reaisDe(item.saldo)], status: item.tipo }))} />
    </>}
    {tela === 'relatorios' && relatorio && <>
      <header className={styles.topo}><div><h1>Relatórios</h1><p>Leitura do período para decidir o que fazer.</p></div></header>
      <div className={styles.kpis}>
        {[['Faturamento', relatorio.faturamentoCentavos], ['Recebido', relatorio.recebidoCentavos], ['A receber', relatorio.aReceberCentavos], ['A pagar', relatorio.aPagarCentavos], ['Inadimplência', relatorio.inadimplenciaCentavos]].map(([rotulo, valor]) => <article className={styles.kpi} key={String(rotulo)}><strong>{reaisDe(Number(valor))}</strong><span>{rotulo}</span></article>)}
      </div>
      <div className={styles.meio}>
        <section className={styles.cartao}><h2>Despesas por categoria</h2>{relatorio.despesas.length === 0 && <p className={styles.vazio}>Nenhuma despesa paga.</p>}{relatorio.despesas.map((item) => <div className={styles.linha} key={item.categoria}><p>{item.categoria}</p><strong>{reaisDe(item.centavos)}</strong></div>)}</section>
        <section className={styles.cartao}><h2>Receita por pacote</h2>{relatorio.pacotes.length === 0 && <p className={styles.vazio}>Nenhum recebimento no período.</p>}{relatorio.pacotes.map((item) => <div className={styles.linha} key={item.pacote}><p>{item.pacote}</p><strong>{reaisDe(item.centavos)}</strong></div>)}</section>
      </div>
    </>}
    {dialogo === 'receber' && alvo && 'cliente' in alvo && <Dialogo titulo="Registrar recebimento" aviso={aviso} aoFechar={() => setDialogo(null)} aoEnviar={(form) => enviar('/api/admin/financeiro/contas-receber', { parcelaId: alvo.id, valor: Number(form.get('valor')), data: String(form.get('data')), forma: String(form.get('forma')), taxa: Number(form.get('taxa') || 0), observacao: String(form.get('observacao') || ''), chave: crypto.randomUUID() })}>
      <Campo nome="valor" rotulo="Valor recebido" tipo="number" padrao={(alvo.saldoCentavos / 100).toFixed(2)} />
      <Campo nome="data" rotulo="Data" tipo="date" padrao={new Date().toISOString().slice(0, 10)} />
      <Forma />
      <Campo nome="taxa" rotulo="Taxa (opcional)" tipo="number" />
      <Campo nome="observacao" rotulo="Observação (opcional)" />
    </Dialogo>}
    {dialogo === 'pagar' && alvo && 'descricao' in alvo && <Dialogo titulo="Registrar pagamento" aviso={aviso} aoFechar={() => setDialogo(null)} aoEnviar={(form) => enviar('/api/admin/financeiro/contas-pagar', { acao: 'pagar', contaId: alvo.id, valor: Number(form.get('valor')), data: String(form.get('data')), forma: String(form.get('forma')), observacao: String(form.get('observacao') || ''), chave: crypto.randomUUID() })}>
      <Campo nome="valor" rotulo="Valor" tipo="number" padrao={(alvo.saldoCentavos / 100).toFixed(2)} />
      <Campo nome="data" rotulo="Data" tipo="date" padrao={new Date().toISOString().slice(0, 10)} />
      <Forma />
      <Campo nome="observacao" rotulo="Observação (opcional)" />
    </Dialogo>}
    {dialogo === 'nova' && <Dialogo titulo="Nova conta" aviso={aviso} aoFechar={() => setDialogo(null)} aoEnviar={(form) => enviar('/api/admin/financeiro/contas-pagar', { acao: 'criar', descricao: String(form.get('descricao')), favorecido: String(form.get('favorecido') || ''), categoriaId: String(form.get('categoriaId')), valor: Number(form.get('valor')), vencimento: String(form.get('vencimento')), competencia: String(form.get('competencia') || '') || undefined, forma: String(form.get('forma')), observacao: String(form.get('observacao') || ''), recorrente: form.get('recorrente') === 'on' })}>
      <Campo nome="descricao" rotulo="Descrição" obrigatorio />
      <Campo nome="favorecido" rotulo="Favorecido / fornecedor" />
      <label>Categoria<select name="categoriaId" required aria-label="Categoria">{categorias.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}</select></label>
      <Campo nome="valor" rotulo="Valor" tipo="number" obrigatorio />
      <Campo nome="vencimento" rotulo="Vencimento" tipo="date" obrigatorio />
      <Campo nome="competencia" rotulo="Competência (opcional)" tipo="date" />
      <Forma />
      <label><input name="recorrente" type="checkbox" /> Recorrente mensal</label>
      <Campo nome="observacao" rotulo="Observação" />
    </Dialogo>}
  </main>;
}

function Kpis({ itens }: { itens: Array<[string, number | undefined]> }) {
  return <section className={styles.kpis} aria-label="Indicadores">{itens.map(([rotulo, valor]) => <article className={styles.kpi} key={rotulo}><strong>{reaisDe(valor ?? 0)}</strong><span>{rotulo}</span></article>)}</section>;
}
function Periodo({ valor, aoMudar }: { valor: string; aoMudar: (valor: string) => void }) {
  return <div className={styles.filtros} role="group" aria-label="Período">{[['mes', 'Este mês'], ['anterior', 'Mês anterior'], ['30', '30 dias']].map(([id, rotulo]) => <button key={id} type="button" aria-pressed={valor === id} onClick={() => aoMudar(id)}>{rotulo}</button>)}</div>;
}
function Filtros({ opcoes, valor, aoMudar }: { opcoes: string[]; valor: string; aoMudar: (valor: string) => void }) {
  return <div className={styles.filtros} role="group" aria-label="Filtro">{opcoes.map((item) => <button key={item} type="button" aria-pressed={valor === item} onClick={() => aoMudar(item)}>{item}</button>)}</div>;
}
function Lista({ titulo, vazio, itens }: { titulo: string; vazio: string; itens: Array<{ id: string; titulo: string; detalhe: string; valor: number }> }) {
  return <section className={styles.cartao}><h2>{titulo}</h2>{itens.length === 0 && <p className={styles.vazio}>{vazio}</p>}{itens.map((item) => <div className={styles.linha} key={item.id}><div><p>{item.titulo}</p><small>{item.detalhe}</small></div><strong>{reaisDe(item.valor)}</strong></div>)}</section>;
}
function Tabela({ colunas, linhas }: { colunas: string[]; linhas: Array<{ id: string; celulas: string[]; status: string; acao?: () => void }> }) {
  return <>
    <table className={styles.tabela}>
      <thead><tr>{colunas.filter(Boolean).map((coluna) => <th key={coluna}>{coluna}</th>)}<th><span className={styles.srOnly}>Ações</span></th></tr></thead>
      <tbody>{linhas.map((linha) => <tr key={linha.id} onClick={linha.acao}>{linha.celulas.map((celula, indice) => <td key={indice} className={indice === linha.celulas.length - 1 && ["Vencido", "Pago", "Reembolsado", "A receber", "Parcialmente pago", "A pagar", "Cancelado"].includes(linha.status) ? classe(linha.status) : undefined}>{celula}</td>)}<td>{linha.acao ? <button type="button" aria-label="Registrar" onClick={(evento) => { evento.stopPropagation(); linha.acao?.(); }}>Registrar</button> : null}</td></tr>)}</tbody>
    </table>
    <div className={styles.cards}>{linhas.map((linha) => <article className={styles.card} key={linha.id}><p>{linha.celulas[0]}</p><p>{linha.celulas[1]}</p><p className={classe(linha.status)}>{linha.status}</p>{linha.acao ? <button type="button" onClick={linha.acao}>Registrar</button> : null}</article>)}</div>
  </>;
}
function Grafico({ linhas }: { linhas: Array<{ saldo: number }> }) {
  if (linhas.length === 0) return <p className={styles.vazio}>Nenhuma movimentação neste período.</p>;
  const valores = linhas.map((linha) => linha.saldo);
  const max = Math.max(...valores, 1);
  const min = Math.min(...valores, 0);
  const pontos = valores.map((valor, indice) => `${(indice / Math.max(valores.length - 1, 1)) * 300},${140 - ((valor - min) / (max - min || 1)) * 120}`).join(' ');
  return <svg className={styles.grafico} viewBox="0 0 300 160" role="img" aria-label="Saldo ao longo do período"><polyline fill="none" stroke="#5DE3B0" strokeWidth="3" points={pontos} /></svg>;
}
function Campo({ nome, rotulo, tipo = 'text', padrao, obrigatorio }: { nome: string; rotulo: string; tipo?: string; padrao?: string; obrigatorio?: boolean }) {
  return <label>{rotulo}<input name={nome} type={tipo} defaultValue={padrao} required={obrigatorio} step={tipo === 'number' ? '0.01' : undefined} min={tipo === 'number' ? '0' : undefined} aria-label={rotulo} /></label>;
}
function Forma() {
  return <label>Forma<select name="forma" aria-label="Forma de pagamento" required>{FORMAS.map((forma) => <option key={forma} value={forma}>{ROTULOS[forma]}</option>)}</select></label>;
}
function Dialogo({ titulo, aviso, aoFechar, aoEnviar, children }: { titulo: string; aviso: string; aoFechar: () => void; aoEnviar: (form: FormData) => void; children: ReactNode }) {
  return <div className={styles.dialogo}><form aria-label={titulo} onSubmit={(evento) => { evento.preventDefault(); aoEnviar(new FormData(evento.currentTarget)); }}><h2>{titulo}</h2>{children}{aviso && <p className={styles.erro} role="alert">{aviso}</p>}<div className={styles.acoes}><button type="button" onClick={aoFechar}>Voltar</button><button type="submit">Confirmar</button></div></form></div>;
}
