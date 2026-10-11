'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import Link from 'next/link';
import { FORMAS, hojeBrasilia, periodoSelecionado, reaisDe, type FormaFinanceira } from '@/lib/financeiro/calculos';
import { abrirAcao, acaoInicial, confirmarAcao, finalizarAcao, type AcaoFinanceira } from '@/lib/financeiro/submissao';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import styles from './financeiro.module.css';
import { PixParcela } from './PixParcela';

type Resumo = { recebidoMesCentavos: number; aReceberCentavos: number; aPagarCentavos: number; emAtrasoCentavos: number; saldoPrevistoCentavos: number; pagoMesCentavos: number };
type Recebivel = { id: string; origem?: "CONTRATO" | "ENTRADA_MANUAL"; cliente: string; clienteId?: string | null; pacote: string; festaId: string | null; parcela: number; vencimento: string; valorCentavos: number; recebidoCentavos: number; saldoCentavos: number; forma: string; status: string; diasAtraso: number };
type Conta = { id: string; descricao: string; favorecido: string | null; categoria: string; categoriaId: string; vencimento: string; valorCentavos: number; saldoCentavos: number; pagoCentavos: number; status: string; forma: string | null };
type Categoria = { id: string; nome: string };
type Fluxo = { saldoInicialCentavos: number; entradasCentavos: number; saidasCentavos: number; saldoFinalCentavos: number; linhas: Array<{ data: string; descricao: string; entrada: number; saida: number; saldo: number | null; tipo: string }> };
type Relatorio = {
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
  margens?: Array<{ festaId: string; cliente: string; margemEstimadaCentavos: number; resultadoCaixaCentavos: number }>;
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
  const [dialogo, setDialogo] = useState<'receber' | 'pagar' | 'nova' | 'entrada' | null>(null);
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
      const corpo = await (await adminFetch(rotas[tela])).json();
      if (!corpo.ok) { setErro(corpo.erro || 'Não foi possível carregar o financeiro.'); return; }
      const data = corpo.data;
      if (tela === 'visao') { setResumo(data.resumo); setRecebiveis(data.recebimentos); setContas(data.pagamentos); setAlertas(data.alertas); setFinanceiroCompleto(data.financeiroCompleto !== false); }
      if (tela === 'receber') { setRecebiveis(data.recebiveis); setResumo(data.resumo); }
      if (tela === 'pagar') { setContas(data.contas); setCategorias(data.categorias); setPagoMes(data.pagoMesCentavos ?? 0); }
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
    adminFetch(rotas[tela]).then((resposta) => resposta.json()).then((corpo) => {
      if (!ativo) return;
      if (!corpo.ok) { setErro(corpo.erro || 'Não foi possível carregar o financeiro.'); setCarregando(false); return; }
      const data = corpo.data;
      if (tela === 'visao') { setResumo(data.resumo); setRecebiveis(data.recebimentos); setContas(data.pagamentos); setAlertas(data.alertas); setFinanceiroCompleto(data.financeiroCompleto !== false); }
      if (tela === 'receber') { setRecebiveis(data.recebiveis); setResumo(data.resumo); }
      if (tela === 'pagar') { setContas(data.contas); setCategorias(data.categorias); setPagoMes(data.pagoMesCentavos ?? 0); }
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

  function abrirDialogo(tipo: 'receber' | 'pagar' | 'nova' | 'entrada', item?: Recebivel | Conta) {
    if (acaoRef.current.fase === 'submitting') return;
    aplicar(abrirAcao(acaoRef.current, () => crypto.randomUUID()));
    if (item) setAlvo(item);
    setDialogo(tipo);
  }

  function fecharDialogo() {
    if (acaoRef.current.fase === 'submitting') return;
    aplicar(acaoInicial());
    setDialogo(null);
  }

  async function enviar(url: string, body: unknown) {
    const envio = confirmarAcao(acaoRef.current);
    if (!envio?.chave) return;
    aplicar(envio);
    setAviso('');
    try {
      const corpo = await (await adminFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (!corpo.ok) { setAviso(corpo.erro || 'Não foi possível concluir.'); aplicar(finalizarAcao(acaoRef.current, 'erro')); return; }
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

  return <main className={styles.pagina}>
    {tela === 'visao' && <>
      <header className={styles.topo}><div><h1>Financeiro</h1><p>Posição atual das entradas, saídas e próximos compromissos.</p></div></header>
      <Kpis itens={[['Recebido no mês', resumo?.recebidoMesCentavos], ['A receber total', resumo?.aReceberCentavos], ...(financeiroCompleto ? [['A pagar total', resumo?.aPagarCentavos] as [string, number | undefined]] : []), ['Em atraso', resumo?.emAtrasoCentavos], ['Saldo previsto', resumo?.saldoPrevistoCentavos]]} />
      <div className={styles.grade}>
        <section className={styles.cartao}><h2>Movimento do mês</h2><Grafico linhas={[{ saldo: resumo?.recebidoMesCentavos ?? 0 }, { saldo: (resumo?.saldoPrevistoCentavos ?? 0) }]} /></section>
        <section className={styles.cartao}><h2>Alertas</h2>{alertas.length === 0 && <p className={styles.vazio}>Tudo em dia.</p>}{alertas.map((item) => <p key={item}>{item}</p>)}</section>
      </div>
      <div className={styles.meio}>
        <Lista titulo="Próximos recebimentos" vazio="Nenhum recebimento em aberto." itens={recebiveis.map((item) => ({ id: item.id, titulo: item.cliente, detalhe: item.vencimento, valor: item.saldoCentavos }))} />
        {financeiroCompleto && <Lista titulo="Próximos pagamentos" vazio="Você ainda não tem contas a pagar." itens={contas.map((item) => ({ id: item.id, titulo: item.descricao, detalhe: item.vencimento, valor: item.saldoCentavos }))} />}
      </div>
    </>}
    {tela === 'receber' && <>
      <header className={styles.topo}><div><h1>Contas a receber</h1><p>Parcelas de contrato e entradas avulsas desta empresa.</p></div><AdminPrimaryButton type="button" disabled={acao.fase === 'submitting'} onClick={() => abrirDialogo('entrada')}>+ Nova entrada</AdminPrimaryButton></header>
      <Kpis itens={[['Total a receber', resumo?.aReceberCentavos], ['Vencido', resumo?.emAtrasoCentavos], ['Recebido no mês', resumo?.recebidoMesCentavos]]} />
      <Filtros opcoes={['Todos', 'A receber', 'Vencidos', 'Pagos']} valor={filtro} aoMudar={setFiltro} />
      <input className={styles.busca} aria-label="Buscar cliente ou festa" placeholder="Buscar cliente ou festa" value={busca} onChange={(evento) => setBusca(evento.target.value)} />
      {listaReceber.length === 0 && <p className={styles.vazio}>{filtro === 'Vencidos' ? 'Tudo em dia. Nenhum recebimento vencido.' : 'Nenhum recebimento neste filtro.'}</p>}
      <Tabela colunas={['Cliente', 'Festa', 'Vencimento', 'Valor', 'Saldo', 'Status', '']} linhas={listaReceber.map((item) => ({
        id: item.id,
        celulas: [item.clienteId ? <Link href={`/clientes/${item.clienteId}`} onClick={(evento) => evento.stopPropagation()}>{item.cliente}</Link> : item.cliente, item.pacote, item.vencimento, reaisDe(item.valorCentavos), reaisDe(item.saldoCentavos), item.status],
        status: item.status,
        acao: item.origem !== 'ENTRADA_MANUAL' && item.saldoCentavos > 0 && item.status !== 'Cancelado' ? () => abrirDialogo('receber', item) : undefined,
        // 066: Pix copia e cola / QR com a chave da própria empresa, no valor do saldo.
        pix: item.origem !== 'ENTRADA_MANUAL' && item.saldoCentavos > 0 && !['Cancelado', 'Reembolsado', 'Pago'].includes(item.status) ? () => setPixParcela(item.id) : undefined,
      }))} />
    </>}
    {tela === 'pagar' && <>
      <header className={styles.topo}><div><h1>Contas a pagar</h1><p>Saídas previstas e pagas desta empresa.</p></div><AdminPrimaryButton type="button" disabled={acao.fase === 'submitting'} onClick={() => abrirDialogo('nova')}>+ Nova conta</AdminPrimaryButton></header>
      <Kpis itens={[['A pagar', contas.filter((item) => item.status === 'A pagar' || item.status === 'Vencido').reduce((t, item) => t + item.saldoCentavos, 0)], ['Vencido', contas.filter((item) => item.status === 'Vencido').reduce((t, item) => t + item.saldoCentavos, 0)], ['Pago no mês', pagoMes]]} />
      {contas.length === 0 && <p className={styles.vazio}>Você ainda não tem contas a pagar.</p>}
      <Tabela colunas={['Descrição', 'Favorecido', 'Categoria', 'Vencimento', 'Valor', 'Status', '']} linhas={contas.map((item) => ({
        id: item.id,
        celulas: [item.descricao, item.favorecido || '—', item.categoria, item.vencimento, reaisDe(item.valorCentavos), item.status],
        status: item.status,
        acao: item.status !== 'Pago' && item.status !== 'Cancelado' ? () => abrirDialogo('pagar', item) : undefined,
      }))} />
    </>}
    {tela === 'fluxo' && fluxo && <>
      <header className={styles.topo}><div><h1>Fluxo de caixa</h1><p>Previsto e realizado no período.</p></div></header>
      <Periodo valor={periodo} aoMudar={setPeriodo} />
      <Kpis itens={[['Saldo inicial', fluxo.saldoInicialCentavos], ['Entradas', fluxo.entradasCentavos], ['Saídas', fluxo.saidasCentavos], ['Saldo final', fluxo.saldoFinalCentavos]]} />
      <section className={styles.cartao}><h2>Saldo ao longo do período</h2><Grafico linhas={fluxo.linhas} /></section>
      {fluxo.linhas.length === 0 && <p className={styles.vazio}>Nenhuma movimentação neste período.</p>}
      <Tabela colunas={['Data', 'Descrição', 'Entrada', 'Saída', 'Saldo', '']} linhas={fluxo.linhas.map((item, indice) => ({ id: String(indice), celulas: [item.data, `${item.descricao} (${item.tipo})`, item.entrada ? reaisDe(item.entrada) : '—', item.saida ? reaisDe(item.saida) : '—', item.saldo == null ? '—' : reaisDe(item.saldo)], status: item.tipo }))} />
    </>}
    {tela === 'relatorios' && relatorio && <>
      <header className={styles.topo}><div><h1>Relatórios</h1><p>Leitura do período para decidir o que fazer.</p></div></header>
      <Periodo valor={periodo} aoMudar={setPeriodo} />
      <div className={styles.kpis}>
        {[['Faturamento do período', relatorio.faturamentoCentavos], ['Recebido no período', relatorio.recebidoCentavos], ['A receber no período', relatorio.aReceberCentavos], ['A pagar no período', relatorio.aPagarCentavos], ['Inadimplência no período', relatorio.inadimplenciaCentavos], ['Ticket médio', relatorio.ticketCentavos ?? 0], ['Taxas no período', relatorio.taxasCentavos ?? 0]].map(([rotulo, valor]) => <article className={`${styles.kpi} ${styles.acento} ${tomKpi(String(rotulo), Number(valor))}`} key={String(rotulo)}><strong>{reaisDe(Number(valor))}</strong><span>{rotulo}</span></article>)}
      </div>
      <p className={styles.vazio}>Pacote mais vendido: {relatorio.pacoteMaisVendido || '—'}</p>
      <div className={styles.meio}>
        <section className={styles.cartao}><h2>Despesas por categoria</h2>{relatorio.despesas.length === 0 && <p className={styles.vazio}>Nenhuma despesa paga no período.</p>}{relatorio.despesas.map((item) => <div className={styles.linha} key={item.categoria}><p>{item.categoria}</p><strong>{reaisDe(item.centavos)}</strong></div>)}</section>
        <section className={styles.cartao}><h2>Receita por pacote</h2>{relatorio.pacotes.length === 0 && <p className={styles.vazio}>Nenhuma festa contratada no período.</p>}{relatorio.pacotes.map((item) => <div className={styles.linha} key={item.pacote}><p>{item.pacote}</p><strong>{reaisDe(item.centavos)}</strong></div>)}</section>
        <section className={styles.cartao}><h2>Formas de pagamento</h2>{(relatorio.formas ?? []).length === 0 && <p className={styles.vazio}>Nenhum recebimento no período.</p>}{(relatorio.formas ?? []).map((item) => <div className={styles.linha} key={item.forma}><p>{item.forma}</p><strong>{reaisDe(item.centavos)}</strong></div>)}</section>
        <section className={styles.cartao}><h2>Margem por festa</h2>{(relatorio.margens ?? []).length === 0 && <p className={styles.vazio}>Nenhuma festa no período.</p>}{(relatorio.margens ?? []).map((item) => <div className={styles.linha} key={item.festaId}><div><p>{item.cliente}</p><small>Resultado de caixa {reaisDe(item.resultadoCaixaCentavos)}</small></div><strong>{reaisDe(item.margemEstimadaCentavos)}</strong></div>)}</section>
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
      <Campo nome="data" rotulo="Data" tipo="date" padrao={new Date().toISOString().slice(0, 10)} />
      <Forma />
      <Campo nome="taxa" rotulo="Taxa (opcional)" tipo="number" />
      <Campo nome="observacao" rotulo="Observação (opcional)" />
    </Dialogo>}
    {dialogo === 'pagar' && alvo && 'descricao' in alvo && acao.chave && <Dialogo titulo="Registrar pagamento" aviso={aviso} ocupado={acao.fase === 'submitting'} aoFechar={fecharDialogo} aoEnviar={(form) => enviar('/api/admin/financeiro/contas-pagar', { acao: 'pagar', contaId: alvo.id, valor: Number(form.get('valor')), data: String(form.get('data')), forma: String(form.get('forma')), observacao: String(form.get('observacao') || ''), chave: acao.chave })}>
      <Campo nome="valor" rotulo="Valor" tipo="number" padrao={(alvo.saldoCentavos / 100).toFixed(2)} />
      <Campo nome="data" rotulo="Data" tipo="date" padrao={new Date().toISOString().slice(0, 10)} />
      <Forma />
      <Campo nome="observacao" rotulo="Observação (opcional)" />
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

function Kpis({ itens }: { itens: Array<[string, number | undefined]> }) {
  const acento = itens.length <= 5;
  return <section className={styles.kpis} aria-label="Indicadores">{itens.map(([rotulo, valor]) => <article className={`${styles.kpi} ${acento ? styles.acento : ''} ${tomKpi(rotulo, valor)}`} key={rotulo}><strong>{reaisDe(valor ?? 0)}</strong><span>{rotulo}</span></article>)}</section>;
}
function tomKpi(rotulo: string, valor?: number) {
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
function Tabela({ colunas, linhas }: { colunas: string[]; linhas: Array<{ id: string; celulas: ReactNode[]; status: string; acao?: () => void; pix?: () => void }> }) {
  return <>
    <div className={styles.painel}>
      <table className={styles.tabela}>
        <thead><tr>{colunas.filter(Boolean).map((coluna) => <th key={coluna}>{coluna}</th>)}<th><span className={styles.srOnly}>Ações</span></th></tr></thead>
        <tbody>{linhas.map((linha) => <tr key={linha.id} onClick={linha.acao}>{linha.celulas.map((celula, indice) => <td key={indice} className={indice === linha.celulas.length - 1 && ["Vencido", "Pago", "Reembolsado", "A receber", "Parcialmente pago", "A pagar", "Cancelado"].includes(linha.status) ? classe(linha.status) : undefined}>{celula}</td>)}<td>{linha.pix ? <button className={styles.acao} type="button" aria-label="Pix da parcela" onClick={(evento) => { evento.stopPropagation(); linha.pix?.(); }}>Pix</button> : null}{linha.acao ? <button className={styles.acao} type="button" aria-label="Registrar" onClick={(evento) => { evento.stopPropagation(); linha.acao?.(); }}>Registrar</button> : null}</td></tr>)}</tbody>
      </table>
    </div>
    <div className={styles.cards}>{linhas.map((linha) => <article className={styles.card} key={linha.id}><p>{linha.celulas[0]}</p><p>{linha.celulas[1]}</p><p className={classe(linha.status)}>{linha.status}</p>{linha.pix ? <button className={styles.acao} type="button" onClick={linha.pix}>Pix</button> : null}{linha.acao ? <button className={styles.acao} type="button" onClick={linha.acao}>Registrar</button> : null}</article>)}</div>
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
