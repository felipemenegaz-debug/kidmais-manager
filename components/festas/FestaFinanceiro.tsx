'use client';
import { useEffect, useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { escolherParcelaAberta, reaisDe } from '@/lib/financeiro/calculos';
import { abrirAcao, acaoInicial, confirmarAcao, finalizarAcao, type AcaoFinanceira } from '@/lib/financeiro/submissao';
import styles from './festa.module.css';
import { PixParcela } from '@/components/admin/PixParcela';

type Resumo = {
  valorContratadoCentavos: number;
  recebidoCentavos: number;
  aReceberCentavos: number;
  /** false quando o plano não inclui contas a pagar: sem despesas, custos, margem nem caixa. Ausente = incluído. */
  despesasIncluidas?: boolean;
  custosCentavos: number | null;
  margemEstimadaCentavos: number | null;
  resultadoCaixaCentavos: number | null;
  recebimentos: Array<{ id: string; parcela: number; vencimento: string; valorCentavos: number; status: string }>;
  despesas: Array<{ id: string; categoria: string; favorecido: string | null; valorCentavos: number; status: string }>;
};

export default function FestaFinanceiro({ festaId, amostra }: { festaId: string; amostra?: Resumo }) {
  const [dados, setDados] = useState<Resumo | null>(amostra ?? null);
  const [erro, setErro] = useState('');
  const [aberto, setAberto] = useState<'receber' | 'despesa' | null>(null);
  const [aviso, setAviso] = useState('');
  const [pixParcela, setPixParcela] = useState<string | null>(null);
  const [categorias, setCategorias] = useState<Array<{ id: string; nome: string }>>([]);
  const [parcelaId, setParcelaId] = useState('');
  const acaoRef = useRef<AcaoFinanceira>(acaoInicial());
  const [acao, setAcao] = useState<AcaoFinanceira>(acaoInicial);
  const enviando = acao.fase === 'submitting';

  function aplicar(proxima: AcaoFinanceira) {
    acaoRef.current = proxima;
    setAcao(proxima);
  }

  async function carregar() {
    const corpo = await (await adminFetch(`/api/admin/festas/${festaId}/financeiro`)).json();
    if (!corpo.ok) { setErro(corpo.erro || 'Não foi possível carregar o financeiro desta festa.'); return; }
    setDados(corpo.data);
    setErro('');
  }

  useEffect(() => {
    if (amostra) return;
    let ativo = true;
    adminFetch(`/api/admin/festas/${festaId}/financeiro`).then((resposta) => resposta.json()).then((corpo) => {
      if (!ativo) return;
      if (!corpo.ok) setErro(corpo.erro || 'Não foi possível carregar o financeiro desta festa.');
      else { setDados(corpo.data); setErro(''); }
    }).catch(() => { if (ativo) setErro('Não foi possível carregar o financeiro desta festa.'); });
    return () => { ativo = false; };
  }, [festaId, amostra]);

  function abrirReceber() {
    if (acaoRef.current.fase === 'submitting') return;
    aplicar(abrirAcao(acaoRef.current, () => crypto.randomUUID()));
    const abertas = (dados?.recebimentos ?? []).filter((item) => item.status !== 'Pago' && item.status !== 'Cancelado' && item.status !== 'Reembolsado');
    setParcelaId(abertas.length === 1 ? abertas[0].id : '');
    setAberto('receber');
  }

  function abrirDespesa() {
    if (acaoRef.current.fase === 'submitting') return;
    aplicar(abrirAcao(acaoRef.current, () => crypto.randomUUID()));
    setAberto('despesa');
  }

  async function receber(form: FormData) {
    const envio = confirmarAcao(acaoRef.current);
    if (!envio?.chave) return;
    aplicar(envio);
    const escolha = escolherParcelaAberta(dados?.recebimentos ?? [], String(form.get('parcelaId') || '') || null);
    if (escolha.vazia || !escolha.parcela) {
      setAviso(escolha.ambiguo ? 'Escolha a parcela deste recebimento.' : 'Não há parcela aberta nesta festa.');
      aplicar(finalizarAcao(acaoRef.current, 'erro'));
      return;
    }
    try {
      const corpo = await (await adminFetch('/api/admin/financeiro/contas-receber', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parcelaId: escolha.parcela.id, valor: Number(form.get('valor')), data: String(form.get('data')), forma: String(form.get('forma')), chave: envio.chave }) })).json();
      if (!corpo.ok) { setAviso(corpo.erro || 'Não foi possível registrar.'); aplicar(finalizarAcao(acaoRef.current, 'erro')); return; }
      aplicar(finalizarAcao(acaoRef.current, 'sucesso'));
      setAberto(null);
      await carregar();
    } catch {
      setAviso('Não foi possível registrar.');
      aplicar(finalizarAcao(acaoRef.current, 'erro'));
    }
  }

  async function despesa(form: FormData) {
    const envio = confirmarAcao(acaoRef.current);
    if (!envio) return;
    aplicar(envio);
    try {
      const corpo = await (await adminFetch(`/api/admin/festas/${festaId}/financeiro`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ descricao: String(form.get('descricao')), categoriaId: String(form.get('categoriaId')), valor: Number(form.get('valor')), vencimento: String(form.get('vencimento')), favorecido: String(form.get('favorecido') || '') }) })).json();
      if (!corpo.ok) { setAviso(corpo.erro || 'Não foi possível adicionar a despesa.'); aplicar(finalizarAcao(acaoRef.current, 'erro')); return; }
      aplicar(finalizarAcao(acaoRef.current, 'sucesso'));
      setAberto(null);
      await carregar();
    } catch {
      setAviso('Não foi possível adicionar a despesa.');
      aplicar(finalizarAcao(acaoRef.current, 'erro'));
    }
  }

  if (erro) return <p role="alert">{erro} <button type="button" onClick={() => void carregar()}>Tentar novamente</button></p>;
  if (!dados) return <p>Carregando financeiro…</p>;
  return <section className={`${styles.card} ${styles.financeiro}`}>
    <h2>Financeiro</h2>
    <p>Valor contratado {reaisDe(dados.valorContratadoCentavos)}</p>
    <p>Recebido {reaisDe(dados.recebidoCentavos)}</p>
    <p>A receber {reaisDe(dados.aReceberCentavos)}</p>
    {dados.custosCentavos !== null && <p>Custos {reaisDe(dados.custosCentavos)}</p>}
    {dados.margemEstimadaCentavos !== null && <p>Margem estimada {reaisDe(dados.margemEstimadaCentavos)}</p>}
    {dados.resultadoCaixaCentavos !== null && <p className={dados.resultadoCaixaCentavos >= 0 ? styles.caixaPositivo : undefined}>Resultado de caixa {reaisDe(dados.resultadoCaixaCentavos)}</p>}
    <h3>Recebimentos</h3>
    {dados.recebimentos.length === 0 && <p>Nenhuma parcela nesta festa.</p>}
    {dados.recebimentos.map((item) => <p key={item.id}>Parcela {item.parcela} · {item.vencimento} · {reaisDe(item.valorCentavos)} · {item.status}{!['Pago', 'Cancelado', 'Reembolsado'].includes(item.status) && <> <button type="button" aria-label={'Pix da parcela ' + item.parcela} onClick={() => setPixParcela(item.id)}>Pix</button></>}</p>)}
    {pixParcela && <PixParcela parcelaId={pixParcela} aoFechar={() => setPixParcela(null)} />}
    {dados.despesasIncluidas !== false && <>
      <h3>Despesas da festa</h3>
      {dados.despesas.length === 0 && <p>Nenhuma despesa vinculada.</p>}
      {dados.despesas.map((item) => <p key={item.id}>{item.categoria} · {item.favorecido || 'Sem favorecido'} · {reaisDe(item.valorCentavos)} · {item.status}</p>)}
    </>}
    <div className={styles.actions}>
      <button className={styles.cta} type="button" disabled={acao.fase === 'submitting'} onClick={abrirReceber}>Registrar recebimento</button>
      {dados.despesasIncluidas !== false && <button type="button" disabled={acao.fase === 'submitting'} onClick={() => { if (acaoRef.current.fase === 'submitting') return; void adminFetch('/api/admin/financeiro/contas-pagar').then((resposta) => resposta.json()).then((corpo) => { if (acaoRef.current.fase === 'submitting') return; if (corpo.ok) setCategorias(corpo.data.categorias); abrirDespesa(); }); }}>Adicionar despesa</button>}
    </div>
    {aberto === 'receber' && <form aria-busy={enviando} onSubmit={(evento) => { evento.preventDefault(); void receber(new FormData(evento.currentTarget)); }}>
      <label>Parcela<select name="parcelaId" required aria-label="Parcela" value={parcelaId} onChange={(evento) => setParcelaId(evento.target.value)}>{dados.recebimentos.filter((item) => item.status !== 'Pago' && item.status !== 'Cancelado' && item.status !== 'Reembolsado').length !== 1 && <option value="">Escolha a parcela</option>}{dados.recebimentos.filter((item) => item.status !== 'Pago' && item.status !== 'Cancelado' && item.status !== 'Reembolsado').map((item) => <option key={item.id} value={item.id}>Parcela {item.parcela} · {reaisDe(item.valorCentavos)}</option>)}</select></label>
      <label>Valor<input name="valor" type="number" min="0.01" step="0.01" required aria-label="Valor recebido" /></label>
      <label>Data<input name="data" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} aria-label="Data" /></label>
      <label>Forma<select name="forma" aria-label="Forma de pagamento"><option value="PIX">PIX</option><option value="DINHEIRO">Dinheiro</option><option value="TRANSFERENCIA">Transferência</option></select></label>
      {aviso && <p role="alert">{aviso}</p>}
      <button className={styles.cta} type="submit" disabled={enviando}>{enviando ? 'Processando…' : 'Confirmar'}</button>
    </form>}
    {aberto === 'despesa' && <form onSubmit={(evento) => { evento.preventDefault(); void despesa(new FormData(evento.currentTarget)); }}>
      <label>Descrição<input name="descricao" required aria-label="Descrição" /></label>
      <label>Categoria<select name="categoriaId" required aria-label="Categoria">{categorias.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}</select></label>
      <label>Valor<input name="valor" type="number" min="0.01" step="0.01" required aria-label="Valor" /></label>
      <label>Vencimento<input name="vencimento" type="date" required aria-label="Vencimento" /></label>
      <label>Favorecido<input name="favorecido" aria-label="Favorecido" /></label>
      {aviso && <p role="alert">{aviso}</p>}
      <button className={styles.cta} type="submit" disabled={acao.fase === 'submitting'}>{enviando ? 'Processando…' : 'Confirmar'}</button>
    </form>}
  </section>;
}
