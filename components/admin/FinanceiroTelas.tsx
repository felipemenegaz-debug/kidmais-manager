'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import Link from 'next/link';
import { FORMAS, cabecalhoVersaoFinanceira, respostaFinanceiraDesatualizada, hojeBrasilia, periodoSelecionado, reaisDe, type FormaFinanceira, somarDias } from '@/lib/financeiro/calculos';
import { abrirAcao, acaoInicial, confirmarAcao, finalizarAcao, recusarAcao, type AcaoFinanceira } from '@/lib/financeiro/submissao';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import styles from './financeiro.module.css';
import { PixParcela } from './PixParcela';

type Resumo = { recebidoMesCentavos: number; aReceberCentavos: number; aPagarCentavos: number; aPagar30DiasCentavos: number; emAtrasoReceberCentavos: number; emAtrasoPagarCentavos: number; movimentoPeriodoCentavos: number | null; pagoMesCentavos: number; versao?: number };
type Recebivel = { id: string; origem?: "CONTRATO" | "ENTRADA_MANUAL"; cliente: string; clienteId?: string | null; pacote: string; festaId: string | null; parcela: number; vencimento: string; valorCentavos: number; recebidoCentavos: number; saldoCentavos: number; forma: string; status: string; diasAtraso: number };
type Conta = { id: string; descricao: string; favorecido: string | null; categoria: string; categoriaId: string; vencimento: string; valorCentavos: number; saldoCentavos: number; pagoCentavos: number; status: string; forma: string | null };
type Categoria = { id: string; nome: string };
/** P2 fase B: cada operação só aparece com a flag ligada no servidor (que também barra). */
type Operacoes = { liquidacao: boolean; reversao: boolean; abertura: boolean };
type Saida = { id: string; data: string; forma: string; valorCentavos: number; revertidoCentavos: number; restanteCentavos: number };
const DESLIGADAS: Operacoes = { liquidacao: false, reversao: false, abertura: false };
type MotivoSaldo = 'SEM_ABERTURA' | 'ANTERIOR_A_ABERTURA' | 'ATRAVESSA_ABERTURA';
type Fluxo = { versao?: number; saldoInicialCentavos: number | null; entradasCentavos: number; saidasCentavos: number; saldoFinalCentavos: number | null; movimentoPeriodoCentavos?: number; motivoSaldo?: MotivoSaldo | null; abertura?: { versao: number; dataBase: string; saldoCentavos: number } | null; pendencias?: { quantidade: number; centavos: number }; recebimentosSemTaxa?: number; linhas: Array<{ data: string; descricao: string; entrada: number; saida: number; saldo: number | null; tipo: string }> };
type Relatorio = {
  versao?: number;
  inicio?: string;
  fim?: string;
  faturamentoCentavos: number;
  recebidoCentavos: number;
  aReceberCentavos: number;
  aPagarCentavos: number;
  inadimplenciaCentavos: number;
  ticketCentavos?: number;
  pacoteMaisVendido?: string;
  despesas: Array<{ categoria: string; centavos: number }>;
  pacotes: Array<{ pacote: string; centavos: number }>;
  formas?: Array<{ forma: string; centavos: number }>;
  taxasCentavos?: number;
  recebimentosSemTaxa?: number;
  margens?: Array<{ festaId: string; cliente: string; margemEstimadaCentavos: number | null; resultadoCaixaCentavos: number; custosLancados?: boolean; noEscopo?: boolean }>;
};

export type TelaFinanceira = 'visao' | 'receber' | 'pagar' | 'fluxo' | 'relatorios';

const ROTULOS: Record<FormaFinanceira, string> = {
  PIX: 'PIX', CARTAO_CREDITO: 'Cartão de crédito', CARTAO_DEBITO: 'Cartão de débito', BOLETO: 'Boleto', DINHEIRO: 'Dinheiro', TRANSFERENCIA: 'Transferência', OUTRO: 'Outro',
};

function classe(status: string) {
  if (status === 'Vencido') return styles.vencido;
  if (status === 'Pago') return styles.pago;
  if (status === 'Cancelado') return styles.cancelado;
  if (status === 'Reembolsado') return styles.aberto;
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
  /** Só para amostra e teste: as flags reais vêm do GET. */
  operacoes?: Operacoes;
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
  const [pixParcela, setPixParcela] = useState<string | null>(null);
  const [pagoMes, setPagoMes] = useState(0);
  // Plano sem contas a pagar (Essencial): a visão geral mostra só entradas. A barreira está no servidor.
  const [financeiroCompleto, setFinanceiroCompleto] = useState(true);
  const acaoRef = useRef<AcaoFinanceira>(acaoInicial());
  const [acao, setAcao] = useState<AcaoFinanceira>(acaoInicial);
  const [dialogo, setDialogo] = useState<'receber' | 'pagar' | 'nova' | 'entrada' | 'liquidar' | 'reverter' | null>(null);
  const [operacoes, setOperacoes] = useState<Operacoes>(amostra?.operacoes ?? DESLIGADAS);
  const [saidas, setSaidas] = useState<Saida[] | null>(null);
  const [alvo, setAlvo] = useState<Recebivel | Conta | null>(null);
  const [aviso, setAviso] = useState('');

  async function carregar() {
    if (amostra) return;
    setCarregando(true);
    setErro('');
    const { inicio, fim } = intervalo(periodo);
    const consulta = `inicio=${inicio}&fim=${fim}`;
    const rotas: Record<TelaFinanceira, string> = {
      visao: '/api/admin/financeiro',
      receber: '/api/admin/financeiro/contas-receber',
      pagar: '/api/admin/financeiro/contas-pagar',
      fluxo: `/api/admin/financeiro/fluxo-caixa?${consulta}`,
      relatorios: `/api/admin/financeiro/relatorios?${consulta}`,
    };
    try {
      const corpo = await (await adminFetch(rotas[tela], { headers: cabecalhoVersaoFinanceira() })).json();
      if (!corpo.ok) { setErro(corpo.erro || 'Não foi possível carregar o financeiro.'); return; }
      const data = corpo.data;
      if (tela === 'visao') { setResumo(data.resumo); setRecebiveis(data.recebimentos); setContas(data.pagamentos); setAlertas(data.alertas); setFinanceiroCompleto(data.financeiroCompleto !== false); }
      if (tela === 'receber') { setRecebiveis(data.recebiveis); setResumo(data.resumo); setOperacoes({ ...DESLIGADAS, ...data.operacoes }); }
      if (tela === 'pagar') { setContas(data.contas); setCategorias(data.categorias); setPagoMes(data.pagoMesCentavos ?? 0); setOperacoes({ ...DESLIGADAS, ...data.operacoes }); }
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
    const { inicio, fim } = intervalo(periodo);
    const consulta = `inicio=${inicio}&fim=${fim}`;
    const rotas: Record<TelaFinanceira, string> = {
      visao: '/api/admin/financeiro',
      receber: '/api/admin/financeiro/contas-receber',
      pagar: '/api/admin/financeiro/contas-pagar',
      fluxo: `/api/admin/financeiro/fluxo-caixa?${consulta}`,
      relatorios: `/api/admin/financeiro/relatorios?${consulta}`,
    };
    adminFetch(rotas[tela], { headers: cabecalhoVersaoFinanceira() }).then((resposta) => resposta.json()).then((corpo) => {
      if (!ativo) return;
      if (!corpo.ok) { setErro(corpo.erro || 'Não foi possível carregar o financeiro.'); setCarregando(false); return; }
      const data = corpo.data;
      if (tela === 'visao') { setResumo(data.resumo); setRecebiveis(data.recebimentos); setContas(data.pagamentos); setAlertas(data.alertas); setFinanceiroCompleto(data.financeiroCompleto !== false); }
      if (tela === 'receber') { setRecebiveis(data.recebiveis); setResumo(data.resumo); setOperacoes({ ...DESLIGADAS, ...data.operacoes }); }
      if (tela === 'pagar') { setContas(data.contas); setCategorias(data.categorias); setPagoMes(data.pagoMesCentavos ?? 0); setOperacoes({ ...DESLIGADAS, ...data.operacoes }); }
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

  function aplicar(proxima: AcaoFinanceira) {
    acaoRef.current = proxima;
    setAcao(proxima);
  }

  function abrirDialogo(tipo: 'receber' | 'pagar' | 'nova' | 'entrada' | 'liquidar' | 'reverter', item?: Recebivel | Conta) {
    if (acaoRef.current.fase === 'submitting') return;
    aplicar(abrirAcao(acaoRef.current, () => crypto.randomUUID()));
    if (item) setAlvo(item);
    setDialogo(tipo);
  }

  async function abrirReversao(conta: Conta) {
    if (acaoRef.current.fase === 'submitting') return;
    setSaidas(null);
    setAviso('');
    abrirDialogo('reverter', conta);
    try {
      const corpo = await (await adminFetch(`/api/admin/financeiro/contas-pagar/${conta.id}/saidas`, { headers: cabecalhoVersaoFinanceira() })).json();
      if (!corpo.ok) { setAviso(corpo.erro || 'Não foi possível carregar os pagamentos.'); setSaidas([]); return; }
      setSaidas(corpo.data);
    } catch {
      setAviso('Não foi possível carregar os pagamentos.');
      setSaidas([]);
    }
  }

  function fecharDialogo() {
    if (acaoRef.current.fase === 'submitting') return;
    aplicar(acaoInicial());
    setDialogo(null);
  }

  /**
   * renovarNaRecusa (escritas da P2 fase B): se o servidor respondeu recusando, a próxima tentativa usa chave nova;
   * só a falha de transporte (sem resposta) reaproveita a chave. As ações da fase A/P1 seguem como estavam.
   */
  async function enviar(url: string, body: unknown, opcoes: { renovarNaRecusa?: boolean } = {}) {
    const envio = confirmarAcao(acaoRef.current);
    if (!envio?.chave) return;
    aplicar(envio);
    setAviso('');
    let corpo: { ok?: boolean; erro?: string };
    try {
      corpo = await (await adminFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    } catch {
      // Sem resposta legível: o pedido pode ter sido gravado; a mesma chave fica para o retry.
      setAviso('Não foi possível concluir.');
      aplicar(finalizarAcao(acaoRef.current, 'erro'));
      return;
    }
    try {
      if (!corpo.ok) {
        setAviso(corpo.erro || 'Não foi possível concluir.');
        aplicar(opcoes.renovarNaRecusa ? recusarAcao(acaoRef.current, () => crypto.randomUUID()) : finalizarAcao(acaoRef.current, 'erro'));
        return;
      }
      aplicar(finalizarAcao(acaoRef.current, 'sucesso'));
      setDialogo(null);
      await carregar();
    } catch {
      setAviso('Não foi possível concluir.');
      aplicar(finalizarAcao(acaoRef.current, 'erro'));
    }
  }

  if (carregando) return <main className={styles.pagina} aria-busy="true"><p>Carregando…</p></main>;
  if (erro) return <main className={styles.pagina}><p className={styles.erro} role="alert">{erro}</p><button type="button" onClick={() => void carregar()}>Tentar novamente</button></main>;
  // Tela e servidor de versões diferentes: não mostra número de outro contrato.
  if (respostaFinanceiraDesatualizada(resumo, tela === 'relatorios' ? relatorio : null, tela === 'fluxo' ? fluxo : null)) return <main className={styles.pagina}><p className={styles.erro} role="alert">O financeiro foi atualizado. Recarregue a página para ver os números certos.</p><button type="button" onClick={() => window.location.reload()}>Recarregar</button></main>;

  return <main className={styles.pagina}>
    {tela === 'visao' && <>
      <header className={styles.topo}><div><h1>Financeiro</h1><p>Posição atual das entradas, saídas e próximos compromissos.</p></div></header>
      <Kpis itens={[['A receber total', resumo?.aReceberCentavos], ['A receber em atraso', resumo?.emAtrasoReceberCentavos], ...(financeiroCompleto ? [['A pagar em 30 dias', resumo?.aPagar30DiasCentavos], ['A pagar vencido', resumo?.emAtrasoPagarCentavos]] as Array<[string, number | undefined]> : [])]} />
      <div className={styles.grade}>
        <section className={styles.cartao}><h2>Movimento do mês</h2>
          <div className={styles.linha}><p>Entrou no mês</p><strong>{reaisDe(resumo?.recebidoMesCentavos ?? 0)}</strong></div>
          {financeiroCompleto && <div className={styles.linha}><p>Saiu no mês</p><strong>{reaisDe(resumo?.pagoMesCentavos ?? 0)}</strong></div>}
          {financeiroCompleto && resumo?.movimentoPeriodoCentavos != null && <div className={styles.linha}><p>Entradas menos saídas</p><strong>{reaisDe(resumo.movimentoPeriodoCentavos)}</strong></div>}
          <p className={styles.vazio}>Entradas líquidas das taxas informadas, já sem estornos e devoluções.{financeiroCompleto ? <> Total a pagar em aberto, com as próximas parcelas de série: {reaisDe(resumo?.aPagarCentavos ?? 0)}.</> : null}</p>
        </section>
        <section className={styles.cartao}><h2>Alertas</h2>{alertas.length === 0 && <p className={styles.vazio}>Tudo em dia.</p>}{alertas.map((item) => <p key={item}>{item}</p>)}</section>
      </div>
      <div className={styles.meio}>
        <Lista titulo="Próximos recebimentos" vazio="Nenhum recebimento em aberto." itens={recebiveis.map((item) => ({ id: item.id, titulo: item.cliente, detalhe: item.vencimento, valor: item.saldoCentavos }))} />
        {financeiroCompleto && <Lista titulo="Próximos pagamentos" vazio="Você ainda não tem contas a pagar." itens={contas.map((item) => ({ id: item.id, titulo: item.descricao, detalhe: item.vencimento, valor: item.saldoCentavos }))} />}
      </div>
    </>}
    {tela === 'receber' && <>
      <header className={styles.topo}><div><h1>Contas a receber</h1><p>Parcelas de contrato e entradas avulsas desta empresa.</p></div><AdminPrimaryButton type="button" disabled={acao.fase === 'submitting'} onClick={() => abrirDialogo('entrada')}>+ Nova entrada</AdminPrimaryButton></header>
      <Kpis itens={[['Total a receber', resumo?.aReceberCentavos], ['Vencido', resumo?.emAtrasoReceberCentavos], ['Recebido no mês', resumo?.recebidoMesCentavos]]} />
      <Filtros opcoes={['Todos', 'A receber', 'Vencidos', 'Pagos']} valor={filtro} aoMudar={setFiltro} />
      <input className={styles.busca} aria-label="Buscar cliente ou festa" placeholder="Buscar cliente ou festa" value={busca} onChange={(evento) => setBusca(evento.target.value)} />
      {listaReceber.length === 0 && <p className={styles.vazio}>{filtro === 'Vencidos' ? 'Tudo em dia. Nenhum recebimento vencido.' : 'Nenhum recebimento neste filtro.'}</p>}
      <Tabela colunas={['Cliente', 'Festa', 'Vencimento', 'Valor', 'Saldo', 'Status', '']} linhas={listaReceber.map((item) => ({
        id: item.id,
        celulas: [item.clienteId ? <Link href={`/clientes/${item.clienteId}`} onClick={(evento) => evento.stopPropagation()}>{item.cliente}</Link> : item.cliente, item.pacote, item.vencimento, reaisDe(item.valorCentavos), reaisDe(item.saldoCentavos), item.status],
        status: item.status,
        acao: item.origem !== 'ENTRADA_MANUAL' && item.saldoCentavos > 0 && item.status !== 'Cancelado' ? () => abrirDialogo('receber', item)
          // P2 fase B: baixa parcial ou total de entrada avulsa, só com a flag de liquidação ligada.
          : item.origem === 'ENTRADA_MANUAL' && operacoes.liquidacao && item.saldoCentavos > 0 && !['Cancelado', 'Pago'].includes(item.status) ? () => abrirDialogo('liquidar', item)
          : undefined,
        // 066: Pix copia e cola / QR com a chave da própria empresa, no valor do saldo.
        pix: item.origem !== 'ENTRADA_MANUAL' && item.saldoCentavos > 0 && !['Cancelado', 'Reembolsado', 'Pago'].includes(item.status) ? () => setPixParcela(item.id) : undefined,
      }))} />
    </>}
    {tela === 'pagar' && <>
      <header className={styles.topo}><div><h1>Contas a pagar</h1><p>Saídas previstas e pagas desta empresa.</p></div><AdminPrimaryButton type="button" disabled={acao.fase === 'submitting'} onClick={() => abrirDialogo('nova')}>+ Nova conta</AdminPrimaryButton></header>
      <Kpis itens={[['A pagar em 30 dias', contas.filter((item) => (item.status === 'A pagar' || item.status === 'Parcialmente paga') && item.vencimento <= somarDias(hojeBrasilia(), 30)).reduce((t, item) => t + item.saldoCentavos, 0)], ['Total em aberto', contas.filter((item) => item.status === 'A pagar' || item.status === 'Parcialmente paga' || item.status === 'Vencido').reduce((t, item) => t + item.saldoCentavos, 0)], ['Vencido', contas.filter((item) => item.status === 'Vencido').reduce((t, item) => t + item.saldoCentavos, 0)], ['Pago no mês', pagoMes]]} />
      {contas.length === 0 && <p className={styles.vazio}>Você ainda não tem contas a pagar.</p>}
      <Tabela colunas={['Descrição', 'Favorecido', 'Categoria', 'Vencimento', 'Valor', 'Status', '']} linhas={contas.map((item) => ({
        id: item.id,
        celulas: [item.descricao, item.favorecido || '—', item.categoria, item.vencimento, reaisDe(item.valorCentavos), item.status],
        status: item.status,
        acao: item.status !== 'Pago' && item.status !== 'Cancelado' ? () => abrirDialogo('pagar', item) : undefined,
        extra: operacoes.reversao && item.pagoCentavos > 0 ? { rotulo: 'Reverter', aoClicar: () => void abrirReversao(item) } : undefined,
      }))} />
    </>}
    {tela === 'fluxo' && fluxo && <>
      <header className={styles.topo}><div><h1>Fluxo de caixa</h1><p>Previsto e realizado no período.</p></div></header>
      <Periodo valor={periodo} aoMudar={setPeriodo} />
      <Kpis itens={[['Saldo inicial', fluxo.saldoInicialCentavos], ['Entradas', fluxo.entradasCentavos], ['Saídas', fluxo.saidasCentavos], ['Saldo final', fluxo.saldoFinalCentavos]]} />
      <AvisoSaldo fluxo={fluxo} />
      <AvisoTaxas semTaxa={fluxo.recebimentosSemTaxa} />
      {!amostra && <PainelAbertura aoMudar={carregar} />}
      {fluxo.saldoFinalCentavos != null && <section className={styles.cartao}><h2>Saldo ao longo do período</h2><Grafico linhas={fluxo.linhas} /></section>}
      {fluxo.linhas.length === 0 && <p className={styles.vazio}>Nenhuma movimentação neste período.</p>}
      <Tabela colunas={['Data', 'Descrição', 'Entrada', 'Saída', 'Saldo', '']} linhas={fluxo.linhas.map((item, indice) => ({ id: String(indice), celulas: [item.data, `${item.descricao} (${item.tipo})`, item.entrada ? reaisDe(item.entrada) : '—', item.saida ? reaisDe(item.saida) : '—', item.saldo == null ? '—' : reaisDe(item.saldo)], status: item.tipo }))} />
    </>}
    {tela === 'relatorios' && relatorio && <>
      <header className={styles.topo}><div><h1>Relatórios</h1><p>Leitura do período para decidir o que fazer.</p></div></header>
      <Periodo valor={periodo} aoMudar={setPeriodo} />
      <div className={styles.kpis}>
        {[['Faturamento do período', relatorio.faturamentoCentavos], ['Recebido no período', relatorio.recebidoCentavos], ['A receber no período', relatorio.aReceberCentavos], ['A pagar no período', relatorio.aPagarCentavos], ['Inadimplência no período', relatorio.inadimplenciaCentavos], ['Ticket médio', relatorio.ticketCentavos ?? 0], ['Taxas informadas no período', relatorio.taxasCentavos ?? 0]].map(([rotulo, valor]) => <article className={`${styles.kpi} ${styles.acento} ${tomKpi(String(rotulo), Number(valor))}`} key={String(rotulo)}><strong>{reaisDe(Number(valor))}</strong><span>{rotulo}</span></article>)}
      </div>
      <AvisoTaxas semTaxa={relatorio.recebimentosSemTaxa} />
      <p className={styles.vazio}>Pacote mais vendido: {relatorio.pacoteMaisVendido || '—'}</p>
      <div className={styles.meio}>
        <section className={styles.cartao}><h2>Despesas por categoria</h2>{relatorio.despesas.length === 0 && <p className={styles.vazio}>Nenhuma despesa paga no período.</p>}{relatorio.despesas.map((item) => <div className={styles.linha} key={item.categoria}><p>{item.categoria}</p><strong>{reaisDe(item.centavos)}</strong></div>)}</section>
        <section className={styles.cartao}><h2>Receita por pacote</h2>{relatorio.pacotes.length === 0 && <p className={styles.vazio}>Nenhuma festa contratada no período.</p>}{relatorio.pacotes.map((item) => <div className={styles.linha} key={item.pacote}><p>{item.pacote}</p><strong>{reaisDe(item.centavos)}</strong></div>)}</section>
        <section className={styles.cartao}><h2>Formas de pagamento</h2>{(relatorio.formas ?? []).length === 0 && <p className={styles.vazio}>Nenhum recebimento no período.</p>}{(relatorio.formas ?? []).map((item) => <div className={styles.linha} key={item.forma}><p>{item.forma}</p><strong>{reaisDe(item.centavos)}</strong></div>)}</section>
        <section className={styles.cartao}><h2>Margem por festa</h2>{(relatorio.margens ?? []).length === 0 && <p className={styles.vazio}>Nenhuma festa no período.</p>}{(relatorio.margens ?? []).map((item) => <div className={styles.linha} key={item.festaId}><div><p>{item.cliente}</p><small>Resultado de caixa {reaisDe(item.resultadoCaixaCentavos)}</small></div><strong>{textoMargem(item)}</strong></div>)}</section>
      </div>
    </>}
    {dialogo === 'entrada' && acao.chave && <NovaEntrada aviso={aviso} ocupado={acao.fase === 'submitting'} festas={[...new Map(recebiveis.filter((item) => item.festaId).map((item) => [item.festaId, item.pacote])).entries()].map(([id, nome]) => ({ id: id ?? '', nome }))} aoFechar={fecharDialogo} aoEnviar={(form) => {
      const status = String(form.get('status')) === 'Pago' ? 'Pago' : 'A receber';
      const festaId = String(form.get('festaId') || '') || undefined;
      const forma = String(form.get('forma') || '') || undefined;
      enviar('/api/admin/financeiro/contas-receber', {
        acao: 'criar',
        descricao: String(form.get('descricao')),
        contraparte: String(form.get('contraparte') || '') || undefined,
        festaId,
        valor: Number(form.get('valor')),
        vencimento: String(form.get('vencimento')),
        forma,
        status,
        recebidoEm: status === 'Pago' ? String(form.get('recebidoEm') || '') : undefined,
        taxa: status === 'Pago' ? Number(form.get('taxa') || 0) : undefined,
        observacao: String(form.get('observacao') || '') || undefined,
        chave: acao.chave,
      });
    }} />}
    {dialogo === 'receber' && alvo && 'cliente' in alvo && acao.chave && <Dialogo titulo="Registrar recebimento" aviso={aviso} ocupado={acao.fase === 'submitting'} aoFechar={fecharDialogo} aoEnviar={(form) => enviar('/api/admin/financeiro/contas-receber', { parcelaId: alvo.id, valor: Number(form.get('valor')), data: String(form.get('data')), forma: String(form.get('forma')), taxa: Number(form.get('taxa') || 0), observacao: String(form.get('observacao') || ''), chave: acao.chave })}>
      <Campo nome="valor" rotulo="Valor recebido" tipo="number" padrao={(alvo.saldoCentavos / 100).toFixed(2)} />
      <Campo nome="data" rotulo="Data" tipo="date" padrao={hojeBrasilia()} />
      <Forma />
      <Campo nome="taxa" rotulo="Taxa (opcional)" tipo="number" />
      <Campo nome="observacao" rotulo="Observação (opcional)" />
    </Dialogo>}
    {dialogo === 'pagar' && alvo && 'descricao' in alvo && acao.chave && <Dialogo titulo="Registrar pagamento" aviso={aviso} ocupado={acao.fase === 'submitting'} aoFechar={fecharDialogo} aoEnviar={(form) => enviar('/api/admin/financeiro/contas-pagar', { acao: 'pagar', contaId: alvo.id, valor: Number(form.get('valor')), data: String(form.get('data')), forma: String(form.get('forma')), observacao: String(form.get('observacao') || ''), chave: acao.chave })}>
      <Campo nome="valor" rotulo="Valor" tipo="number" padrao={(alvo.saldoCentavos / 100).toFixed(2)} />
      <Campo nome="data" rotulo="Data" tipo="date" padrao={hojeBrasilia()} />
      <Forma />
      <Campo nome="observacao" rotulo="Observação (opcional)" />
    </Dialogo>}
    {dialogo === 'liquidar' && alvo && 'cliente' in alvo && acao.chave && <Dialogo titulo="Registrar recebimento da entrada" aviso={aviso} ocupado={acao.fase === 'submitting'} aoFechar={fecharDialogo} aoEnviar={(form) => enviar(`/api/admin/financeiro/contas-receber/${alvo.id}/liquidacoes`, { valor: Number(form.get('valor')), data: String(form.get('data')), forma: String(form.get('forma')), taxa: Number(form.get('taxa') || 0), observacao: String(form.get('observacao') || '') || undefined, chave: acao.chave }, { renovarNaRecusa: true })}>
      <p className={styles.vazio}>Saldo em aberto: {reaisDe(alvo.saldoCentavos)}. Pode ser parcial.</p>
      <Campo nome="valor" rotulo="Valor recebido" tipo="number" padrao={(alvo.saldoCentavos / 100).toFixed(2)} obrigatorio />
      <Campo nome="data" rotulo="Data" tipo="date" padrao={hojeBrasilia()} obrigatorio />
      <Forma />
      <Campo nome="taxa" rotulo="Taxa (opcional)" tipo="number" />
      <Campo nome="observacao" rotulo="Observação (opcional)" />
    </Dialogo>}
    {dialogo === 'reverter' && alvo && 'descricao' in alvo && acao.chave && <Dialogo titulo="Reverter pagamento" confirmar="Reverter" aviso={aviso} ocupado={acao.fase === 'submitting' || saidas === null} aoFechar={fecharDialogo} aoEnviar={(form) => enviar(`/api/admin/financeiro/contas-pagar/${alvo.id}/saidas/${String(form.get('saidaId'))}/reversoes`, { valor: Number(form.get('valor')), data: String(form.get('data')), motivo: String(form.get('motivo') || ''), chave: acao.chave }, { renovarNaRecusa: true })}>
      {saidas === null ? <p className={styles.vazio}>Carregando pagamentos…</p> : <ReversaoCampos saidas={saidas} />}
    </Dialogo>}
    {dialogo === 'nova' && acao.chave && <Dialogo titulo="Nova conta" aviso={aviso} ocupado={acao.fase === 'submitting'} aoFechar={fecharDialogo} aoEnviar={(form) => enviar('/api/admin/financeiro/contas-pagar', { acao: 'criar', descricao: String(form.get('descricao')), favorecido: String(form.get('favorecido') || ''), categoriaId: String(form.get('categoriaId')), valor: Number(form.get('valor')), vencimento: String(form.get('vencimento')), competencia: String(form.get('competencia') || '') || undefined, forma: String(form.get('forma')), observacao: String(form.get('observacao') || ''), recorrente: form.get('recorrente') === 'on', chave: acao.chave })}>
      <Campo nome="descricao" rotulo="Descrição" obrigatorio />
      <Campo nome="favorecido" rotulo="Favorecido / fornecedor" />
      <label>Categoria<select name="categoriaId" required aria-label="Categoria">{categorias.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}</select></label>
      <Campo nome="valor" rotulo="Valor" tipo="number" obrigatorio />
      <Campo nome="vencimento" rotulo="Vencimento" tipo="date" obrigatorio />
      <Campo nome="competencia" rotulo="Competência (opcional)" tipo="date" />
      <Forma />
      <label><input name="recorrente" type="checkbox" /> Recorrente mensal — gera 12 vencimentos</label>
      <Campo nome="observacao" rotulo="Observação" />
    </Dialogo>}
    {pixParcela && <PixParcela parcelaId={pixParcela} aoFechar={() => setPixParcela(null)} />}
  </main>;
}

function textoMargem(item: { margemEstimadaCentavos: number | null; noEscopo?: boolean }) {
  if (item.margemEstimadaCentavos != null) return reaisDe(item.margemEstimadaCentavos);
  return item.noEscopo === false ? '—' : 'custos não lançados';
}
function AvisoSaldo({ fluxo }: { fluxo: Fluxo }) {
  const pend = fluxo.pendencias;
  const dataBase = fluxo.abertura?.dataBase;
  const motivo = fluxo.motivoSaldo === 'SEM_ABERTURA' ? 'O saldo aparece depois que o saldo de abertura for informado. Até lá, mostramos só as entradas e saídas do período.'
    : fluxo.motivoSaldo === 'ANTERIOR_A_ABERTURA' ? `Este período é anterior ao saldo de abertura (${dataBase}). Mostramos só as entradas e saídas.`
    : fluxo.motivoSaldo === 'ATRAVESSA_ABERTURA' ? `O saldo começa em ${dataBase}, data do saldo de abertura.`
    : '';
  return <>
    {motivo && <p className={styles.vazio}>{motivo}{fluxo.movimentoPeriodoCentavos != null ? ` Entradas menos saídas no período: ${reaisDe(fluxo.movimentoPeriodoCentavos)}.` : ''}</p>}
    {pend && pend.quantidade > 0 && <p className={styles.erro} role="status">A conferir: {pend.quantidade === 1 ? '1 movimento' : `${pend.quantidade} movimentos`} desde a abertura, somando {reaisDe(pend.centavos)}. O saldo considera o que está lançado hoje.</p>}
  </>;
}
function AvisoTaxas({ semTaxa }: { semTaxa?: number }) {
  const n = semTaxa ?? 0;
  return <p className={styles.vazio}>Valores líquidos das taxas informadas.{n > 0 ? ` ${n === 1 ? '1 recebimento de cartão ou boleto está' : `${n} recebimentos de cartão ou boleto estão`} sem taxa informada.` : ''}</p>;
}
function Kpis({ itens }: { itens: Array<[string, number | null | undefined]> }) {
  const acento = itens.length <= 5;
  return <section className={styles.kpis} aria-label="Indicadores">{itens.map(([rotulo, valor]) => <article className={`${styles.kpi} ${acento ? styles.acento : ''} ${tomKpi(rotulo, valor)}`} key={rotulo}><strong>{valor === null ? '—' : reaisDe(valor ?? 0)}</strong><span>{rotulo}</span></article>)}</section>;
}
function tomKpi(rotulo: string, valor?: number | null) {
  if (valor === null) return '';
  const nome = rotulo.toLowerCase();
  if (nome.includes('atraso') || nome.includes('vencido') || nome.includes('inadimpl')) return styles.alerta;
  if (nome.includes('saída') || nome.includes('saida')) return styles.saida;
  if ((nome.includes('saldo previsto') || nome.includes('saldo final') || nome.includes('recebido') || nome.includes('entradas')) && (valor ?? 0) >= 0) return styles.positivo;
  return '';
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
type AcaoExtra = { rotulo: string; aoClicar: () => void };
function Tabela({ colunas, linhas }: { colunas: string[]; linhas: Array<{ id: string; celulas: ReactNode[]; status: string; acao?: () => void; pix?: () => void; extra?: AcaoExtra }> }) {
  return <>
    <div className={styles.painel}>
      <table className={styles.tabela}>
        <thead><tr>{colunas.filter(Boolean).map((coluna) => <th key={coluna}>{coluna}</th>)}<th><span className={styles.srOnly}>Ações</span></th></tr></thead>
        <tbody>{linhas.map((linha) => <tr key={linha.id} onClick={linha.acao}>{linha.celulas.map((celula, indice) => <td key={indice} className={indice === linha.celulas.length - 1 && ["Vencido", "Pago", "Reembolsado", "A receber", "Parcialmente pago", "Parcialmente paga", "A pagar", "Cancelado"].includes(linha.status) ? classe(linha.status) : undefined}>{celula}</td>)}<td>{linha.pix ? <button className={styles.acao} type="button" aria-label="Pix da parcela" onClick={(evento) => { evento.stopPropagation(); linha.pix?.(); }}>Pix</button> : null}{linha.acao ? <button className={styles.acao} type="button" aria-label="Registrar" onClick={(evento) => { evento.stopPropagation(); linha.acao?.(); }}>Registrar</button> : null}{linha.extra ? <button className={styles.acao} type="button" onClick={(evento) => { evento.stopPropagation(); linha.extra?.aoClicar(); }}>{linha.extra.rotulo}</button> : null}</td></tr>)}</tbody>
      </table>
    </div>
    <div className={styles.cards}>{linhas.map((linha) => <article className={styles.card} key={linha.id}><p>{linha.celulas[0]}</p><p>{linha.celulas[1]}</p><p className={classe(linha.status)}>{linha.status}</p>{linha.pix ? <button className={styles.acao} type="button" onClick={linha.pix}>Pix</button> : null}{linha.acao ? <button className={styles.acao} type="button" onClick={linha.acao}>Registrar</button> : null}{linha.extra ? <button className={styles.acao} type="button" onClick={linha.extra.aoClicar}>{linha.extra.rotulo}</button> : null}</article>)}</div>
  </>;
}
function intervalo(periodo: string) {
  const modo = periodo === 'anterior' || periodo === '30' ? periodo : 'mes';
  return periodoSelecionado(hojeBrasilia(), modo);
}
function Grafico({ linhas }: { linhas: Array<{ saldo: number | null }> }) {
  const realizados = linhas.filter((linha) => linha.saldo != null);
  if (realizados.length === 0) return <p className={styles.vazio}>Nenhuma movimentação neste período.</p>;
  const valores = realizados.map((linha) => linha.saldo ?? 0);
  const max = Math.max(...valores, 1);
  const min = Math.min(...valores, 0);
  const pontos = valores.map((valor, indice) => `${(indice / Math.max(valores.length - 1, 1)) * 300},${140 - ((valor - min) / (max - min || 1)) * 120}`).join(' ');
  return <svg className={styles.grafico} viewBox="0 0 300 160" role="img" aria-label="Saldo ao longo do período"><polyline fill="none" stroke="currentColor" strokeWidth="3" points={pontos} /></svg>;
}
function Campo({ nome, rotulo, tipo = 'text', padrao, obrigatorio }: { nome: string; rotulo: string; tipo?: string; padrao?: string; obrigatorio?: boolean }) {
  return <label>{rotulo}<input name={nome} type={tipo} defaultValue={padrao} required={obrigatorio} step={tipo === 'number' ? '0.01' : undefined} min={tipo === 'number' ? '0' : undefined} aria-label={rotulo} /></label>;
}
function Forma() {
  return <label>Forma<select name="forma" aria-label="Forma de pagamento" required>{FORMAS.map((forma) => <option key={forma} value={forma}>{ROTULOS[forma]}</option>)}</select></label>;
}
function Dialogo({ titulo, aviso, ocupado = false, confirmar = 'Confirmar', aoFechar, aoEnviar, children }: { titulo: string; aviso: string; ocupado?: boolean; confirmar?: string; aoFechar: () => void; aoEnviar: (form: FormData) => void; children: ReactNode }) {
  return <div className={styles.dialogo}><form aria-label={titulo} aria-busy={ocupado} onSubmit={(evento) => { evento.preventDefault(); if (!ocupado) aoEnviar(new FormData(evento.currentTarget)); }}><h2>{titulo}</h2>{children}{aviso && <p className={styles.erro} role="alert">{aviso}</p>}<div className={styles.acoes}><button className={styles.voltar} type="button" onClick={aoFechar} disabled={ocupado}>Voltar</button><AdminPrimaryButton type="submit" disabled={ocupado}>{ocupado ? 'Processando…' : confirmar}</AdminPrimaryButton></div></form></div>;
}
function NovaEntrada({ aviso, ocupado, festas, aoFechar, aoEnviar }: { aviso: string; ocupado: boolean; festas: Array<{ id: string; nome: string }>; aoFechar: () => void; aoEnviar: (form: FormData) => void }) {
  const [pago, setPago] = useState(false);
  return <Dialogo titulo="Nova entrada" aviso={aviso} ocupado={ocupado} confirmar="Salvar entrada" aoFechar={aoFechar} aoEnviar={aoEnviar}>
    <Campo nome="descricao" rotulo="Descrição" obrigatorio />
    <Campo nome="contraparte" rotulo="Cliente / contraparte" />
    <label>Festa vinculada<select name="festaId" aria-label="Festa vinculada"><option value="">Nenhuma</option>{festas.filter((item) => item.id).map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}</select></label>
    <Campo nome="valor" rotulo="Valor" tipo="number" obrigatorio />
    <Campo nome="vencimento" rotulo="Data de vencimento" tipo="date" obrigatorio />
    <label>Forma prevista<select name="forma" aria-label="Forma de pagamento prevista"><option value="">Não informada</option>{FORMAS.map((forma) => <option key={forma} value={forma}>{ROTULOS[forma]}</option>)}</select></label>
    <label>Status inicial<select name="status" aria-label="Status inicial" value={pago ? 'Pago' : 'A receber'} onChange={(evento) => setPago(evento.target.value === 'Pago')}><option value="A receber">A receber</option><option value="Pago">Pago</option></select></label>
    {pago && <>
      <Campo nome="recebidoEm" rotulo="Data do recebimento" tipo="date" obrigatorio />
      <Campo nome="taxa" rotulo="Taxa (opcional)" tipo="number" />
    </>}
    <Campo nome="observacao" rotulo="Observação" />
  </Dialogo>;
}
function ReversaoCampos({ saidas }: { saidas: Saida[] }) {
  const abertas = saidas.filter((item) => item.restanteCentavos > 0);
  const [saidaId, setSaidaId] = useState(abertas[0]?.id ?? '');
  const escolhida = abertas.find((item) => item.id === saidaId);
  if (abertas.length === 0) return <p className={styles.vazio}>Nenhum pagamento desta conta pode ser revertido.</p>;
  return <>
    <label>Pagamento<select name="saidaId" aria-label="Pagamento a reverter" value={saidaId} onChange={(evento) => setSaidaId(evento.target.value)} required>
      {abertas.map((item) => <option key={item.id} value={item.id}>{item.data} · {ROTULOS[item.forma as FormaFinanceira] ?? item.forma} · {reaisDe(item.valorCentavos)}{item.revertidoCentavos > 0 ? ` (já revertido ${reaisDe(item.revertidoCentavos)})` : ''}</option>)}
    </select></label>
    <Campo key={saidaId} nome="valor" rotulo="Valor a reverter" tipo="number" padrao={((escolhida?.restanteCentavos ?? 0) / 100).toFixed(2)} obrigatorio />
    <Campo nome="data" rotulo="Data da reversão" tipo="date" padrao={hojeBrasilia()} obrigatorio />
    <Campo nome="motivo" rotulo="Motivo" obrigatorio />
    <p className={styles.vazio}>O pagamento original fica no histórico. A reversão devolve o valor ao saldo da conta.</p>
  </>;
}

type MovimentoVisto = { tipo: string; origemId: string; data: string; centavos: number; descricao: string; atributosHash: string };
type LeituraAbertura = {
  disponivel: boolean;
  podeGerir: boolean;
  hoje: string;
  vigente: { versao: number; dataBase: string; saldoCentavos: number; confirmadaEm: string } | null;
  pendencias: { quantidade: number; centavos: number; itens: MovimentoVisto[] };
  previa: { dataBase: string; janela: { de: string; ate: string } | null; movimentos: MovimentoVisto[]; conjuntoHash: string; movimentoDesdeD0Centavos: number };
};
const LIMITE_CONFERENCIA = 200;
const chaveMovimento = (item: MovimentoVisto) => `${item.tipo}:${item.origemId}`;

/**
 * P2 fase B: confirmar ou corrigir a abertura e conferir pendências. Só aparece com a flag de abertura ligada.
 * A Equipe vê; só a Gestão envia (o servidor recusa a Equipe de qualquer forma).
 * Cada envio usa uma chave nova depois de resposta do servidor; numa falha de rede a mesma chave é reaproveitada.
 */
export function PainelAbertura({ aoMudar }: { aoMudar: () => Promise<void> | void }) {
  const [leitura, setLeitura] = useState<LeituraAbertura | null>(null);
  const [dataBase, setDataBase] = useState('');
  const [aviso, setAviso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [editando, setEditando] = useState(false);
  const [marcados, setMarcados] = useState<string[]>([]);
  const chaveRef = useRef<string | null>(null);
  // Cada leitura tem um número; só a mais recente é aplicada. Resposta antiga (de outra data) é descartada.
  const leituraRef = useRef(0);
  const [lendo, setLendo] = useState(false);

  async function ler(d0?: string) {
    const numero = ++leituraRef.current;
    setLendo(true);
    try {
      const consulta = d0 ? `?dataBase=${encodeURIComponent(d0)}` : '';
      const corpo = await (await adminFetch(`/api/admin/financeiro/abertura${consulta}`, { headers: cabecalhoVersaoFinanceira() })).json();
      if (numero !== leituraRef.current) return;
      if (!corpo.ok) { setAviso(corpo.erro || 'Não foi possível carregar a abertura.'); return; }
      setLeitura(corpo.data);
      setDataBase(corpo.data.previa.dataBase);
      setMarcados([]);
    } catch {
      if (numero === leituraRef.current) setAviso('Não foi possível carregar a abertura.');
    } finally {
      if (numero === leituraRef.current) setLendo(false);
    }
  }

  // Toda troca do campo invalida a leitura pendente, inclusive apagar a data: senão a resposta repõe a data abandonada.
  function escolherData(valor: string) {
    setDataBase(valor);
    if (valor) { void ler(valor); return; }
    leituraRef.current += 1;
    setLendo(false);
  }

  useEffect(() => {
    let ativo = true;
    const numero = ++leituraRef.current;
    adminFetch('/api/admin/financeiro/abertura', { headers: cabecalhoVersaoFinanceira() }).then((resposta) => resposta.json()).then((corpo) => {
      if (!ativo || numero !== leituraRef.current || !corpo.ok) return;
      setLeitura(corpo.data);
      setDataBase(corpo.data.previa.dataBase);
    }).catch(() => undefined);
    return () => { ativo = false; };
  }, []);

  async function postar(url: string, corpoPedido: Record<string, unknown>) {
    if (ocupado) return false;
    chaveRef.current ??= crypto.randomUUID();
    setOcupado(true);
    setAviso('');
    try {
      const resposta = await adminFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...corpoPedido, chave: chaveRef.current }) });
      const corpo = await resposta.json();
      chaveRef.current = null;
      if (!corpo.ok) {
        // 409: outra pessoa mudou a abertura ou os movimentos. Mostra a leitura nova para revisar antes de reenviar.
        setAviso(resposta.status === 409 ? `${corpo.erro || 'A abertura mudou.'} Revise a prévia atualizada e confirme de novo.` : (corpo.erro || 'Não foi possível concluir.'));
        if (resposta.status === 409) await ler(dataBase || undefined);
        return false;
      }
      await ler();
      await aoMudar();
      return true;
    } catch {
      setAviso('Não foi possível concluir. Tente de novo: o mesmo pedido não é gravado duas vezes.');
      return false;
    } finally {
      setOcupado(false);
    }
  }

  if (!leitura?.disponivel) return null;
  const { vigente, pendencias, previa, podeGerir } = leitura;
  const marcadosItens = pendencias.itens.filter((item) => marcados.includes(chaveMovimento(item)));
  const mostrarFormulario = podeGerir && (!vigente || editando);
  // Só confirma quando a prévia na tela é a da data escolhida: senão iria a data e o hash anteriores.
  const previaDaData = !lendo && dataBase !== '' && previa.dataBase === dataBase;

  return <section className={styles.cartao} aria-label="Saldo de abertura">
    <h2>Saldo de abertura</h2>
    {vigente
      ? <div className={styles.linha}><p>Saldo em {vigente.dataBase} (revisão {vigente.versao})</p><strong>{reaisDe(vigente.saldoCentavos)}</strong></div>
      : <p className={styles.vazio}>Informe o saldo do caixa numa data para o fluxo mostrar saldo.</p>}
    {!podeGerir && <p className={styles.vazio}>Só a gestão da empresa confirma a abertura e confere movimentos.</p>}
    {podeGerir && vigente && !editando && <button className={styles.acao} type="button" onClick={() => { setEditando(true); setAviso(''); }}>Corrigir abertura</button>}
    {mostrarFormulario && <form aria-label="Confirmar saldo de abertura" aria-busy={ocupado} onSubmit={async (evento) => {
      evento.preventDefault();
      if (ocupado || !previaDaData) return;
      const form = new FormData(evento.currentTarget);
      const ok = await postar('/api/admin/financeiro/abertura', {
        dataBase: previa.dataBase,
        saldo: Number(form.get('saldo')),
        justificativa: String(form.get('justificativa') || ''),
        versaoEsperada: vigente?.versao ?? 0,
        conjuntoHash: previa.conjuntoHash,
      });
      if (ok) setEditando(false);
    }}>
      <label>Data do saldo<input name="dataBase" type="date" aria-label="Data do saldo" value={dataBase} max={leitura.hoje} required disabled={ocupado} onChange={(evento) => escolherData(evento.target.value)} /></label>
      <label>Saldo no início do dia<input name="saldo" type="number" step="0.01" aria-label="Saldo no início do dia" defaultValue={vigente && vigente.dataBase === previa.dataBase ? (vigente.saldoCentavos / 100).toFixed(2) : undefined} required disabled={ocupado} /></label>
      <label>Justificativa<input name="justificativa" aria-label="Justificativa" minLength={3} maxLength={1000} required disabled={ocupado} /></label>
      <p className={styles.vazio}>
        {previa.janela ? `De ${previa.janela.de} a ${previa.janela.ate}: ${previa.movimentos.length === 1 ? '1 movimento lançado' : `${previa.movimentos.length} movimentos lançados`}, que ficam como já conferidos ao confirmar.` : 'Sem movimentos anteriores a hoje nesta data.'}
        {' '}Movimento de {previa.dataBase} até hoje: {reaisDe(previa.movimentoDesdeD0Centavos)}, somado ao saldo informado.
      </p>
      {!previaDaData && <p className={styles.vazio} role="status">{lendo ? 'Carregando a prévia da data escolhida…' : 'A prévia mostrada não é da data escolhida. Escolha a data de novo para recarregar.'}</p>}
      {previa.movimentos.length > 0 && <details><summary>Ver movimentos da prévia</summary>{previa.movimentos.map((item) => <div className={styles.linha} key={chaveMovimento(item)}><p>{item.data} · {item.descricao}</p><strong>{reaisDe(item.centavos)}</strong></div>)}</details>}
      {aviso && <p className={styles.erro} role="alert">{aviso}</p>}
      <div className={styles.acoes}>
        {vigente && <button className={styles.voltar} type="button" disabled={ocupado} onClick={() => { setEditando(false); setAviso(''); }}>Voltar</button>}
        <AdminPrimaryButton type="submit" disabled={ocupado || !previaDaData}>{ocupado ? 'Processando…' : vigente ? 'Salvar correção' : 'Confirmar abertura'}</AdminPrimaryButton>
      </div>
    </form>}
    {vigente && pendencias.quantidade > 0 && <div aria-label="Movimentos a conferir">
      <h3>A conferir desde a abertura</h3>
      <p className={styles.vazio}>{pendencias.quantidade === 1 ? '1 movimento' : `${pendencias.quantidade} movimentos`}, somando {reaisDe(pendencias.centavos)}. Marque os que conferem com o extrato.</p>
      {pendencias.itens.map((item) => {
        const id = chaveMovimento(item);
        return <label className={styles.linha} key={id}>
          {podeGerir && <input type="checkbox" aria-label={`Conferido: ${item.descricao}`} checked={marcados.includes(id)} disabled={ocupado || (!marcados.includes(id) && marcados.length >= LIMITE_CONFERENCIA)} onChange={(evento) => setMarcados((atual) => evento.target.checked ? [...atual, id] : atual.filter((x) => x !== id))} />}
          <p>{item.data} · {item.descricao}</p><strong>{reaisDe(item.centavos)}</strong>
        </label>;
      })}
      {podeGerir && <div className={styles.acoes}>
        <button className={styles.voltar} type="button" disabled={ocupado} onClick={() => setMarcados(pendencias.itens.slice(0, LIMITE_CONFERENCIA).map(chaveMovimento))}>Marcar {Math.min(pendencias.itens.length, LIMITE_CONFERENCIA)}</button>
        <AdminPrimaryButton type="button" disabled={ocupado || marcadosItens.length === 0} onClick={() => void postar('/api/admin/financeiro/abertura/conferencias', {
          versaoAbertura: vigente.versao,
          itens: marcadosItens.map((item) => ({ tipo: item.tipo, origemId: item.origemId, atributosHash: item.atributosHash })),
        })}>{ocupado ? 'Processando…' : `Conferir ${marcadosItens.length}`}</AdminPrimaryButton>
      </div>}
    </div>}
    {!mostrarFormulario && aviso && <p className={styles.erro} role="alert">{aviso}</p>}
  </section>;
}
