'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { reaisDe } from '@/lib/financeiro/calculos';
import styles from './festa.module.css';

type Resumo = {
  valorContratadoCentavos: number;
  recebidoCentavos: number;
  aReceberCentavos: number;
  custosCentavos: number;
  margemEstimadaCentavos: number;
  recebimentos: Array<{ id: string; parcela: number; vencimento: string; valorCentavos: number; status: string }>;
  despesas: Array<{ id: string; categoria: string; favorecido: string | null; valorCentavos: number; status: string }>;
};

export default function FestaFinanceiro({ festaId, amostra }: { festaId: string; amostra?: Resumo }) {
  const [dados, setDados] = useState<Resumo | null>(amostra ?? null);
  const [erro, setErro] = useState('');
  const [aberto, setAberto] = useState<'receber' | 'despesa' | null>(null);
  const [aviso, setAviso] = useState('');
  const [categorias, setCategorias] = useState<Array<{ id: string; nome: string }>>([]);

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

  async function receber(form: FormData) {
    const parcela = dados?.recebimentos.find((item) => item.status !== 'Pago' && item.status !== 'Cancelado');
    if (!parcela) { setAviso('Não há parcela aberta nesta festa.'); return; }
    const corpo = await (await adminFetch('/api/admin/financeiro/contas-receber', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parcelaId: parcela.id, valor: Number(form.get('valor')), data: String(form.get('data')), forma: String(form.get('forma')), chave: crypto.randomUUID() }) })).json();
    if (!corpo.ok) { setAviso(corpo.erro || 'Não foi possível registrar.'); return; }
    setAberto(null);
    await carregar();
  }

  async function despesa(form: FormData) {
    const corpo = await (await adminFetch(`/api/admin/festas/${festaId}/financeiro`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ descricao: String(form.get('descricao')), categoriaId: String(form.get('categoriaId')), valor: Number(form.get('valor')), vencimento: String(form.get('vencimento')), favorecido: String(form.get('favorecido') || '') }) })).json();
    if (!corpo.ok) { setAviso(corpo.erro || 'Não foi possível adicionar a despesa.'); return; }
    setAberto(null);
    await carregar();
  }

  if (erro) return <p role="alert">{erro} <button type="button" onClick={() => void carregar()}>Tentar novamente</button></p>;
  if (!dados) return <p>Carregando financeiro…</p>;
  return <section className={styles.card}>
    <h2>Financeiro</h2>
    <p>Valor contratado {reaisDe(dados.valorContratadoCentavos)}</p>
    <p>Recebido {reaisDe(dados.recebidoCentavos)}</p>
    <p>A receber {reaisDe(dados.aReceberCentavos)}</p>
    <p>Custos {reaisDe(dados.custosCentavos)}</p>
    <p>Margem estimada {reaisDe(dados.margemEstimadaCentavos)}</p>
    <h3>Recebimentos</h3>
    {dados.recebimentos.length === 0 && <p>Nenhuma parcela nesta festa.</p>}
    {dados.recebimentos.map((item) => <p key={item.id}>Parcela {item.parcela} · {item.vencimento} · {reaisDe(item.valorCentavos)} · {item.status}</p>)}
    <h3>Despesas da festa</h3>
    {dados.despesas.length === 0 && <p>Nenhuma despesa vinculada.</p>}
    {dados.despesas.map((item) => <p key={item.id}>{item.categoria} · {item.favorecido || 'Sem favorecido'} · {reaisDe(item.valorCentavos)} · {item.status}</p>)}
    <div className={styles.actions}>
      <button type="button" onClick={() => setAberto('receber')}>Registrar recebimento</button>
      <button type="button" onClick={async () => { const corpo = await (await adminFetch('/api/admin/financeiro/contas-pagar')).json(); if (corpo.ok) setCategorias(corpo.data.categorias); setAberto('despesa'); }}>Adicionar despesa</button>
    </div>
    {aberto === 'receber' && <form onSubmit={(evento) => { evento.preventDefault(); void receber(new FormData(evento.currentTarget)); }}>
      <label>Valor<input name="valor" type="number" min="0.01" step="0.01" required aria-label="Valor recebido" /></label>
      <label>Data<input name="data" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} aria-label="Data" /></label>
      <label>Forma<select name="forma" aria-label="Forma de pagamento"><option value="PIX">PIX</option><option value="DINHEIRO">Dinheiro</option><option value="TRANSFERENCIA">Transferência</option></select></label>
      {aviso && <p role="alert">{aviso}</p>}
      <button type="submit">Confirmar</button>
    </form>}
    {aberto === 'despesa' && <form onSubmit={(evento) => { evento.preventDefault(); void despesa(new FormData(evento.currentTarget)); }}>
      <label>Descrição<input name="descricao" required aria-label="Descrição" /></label>
      <label>Categoria<select name="categoriaId" required aria-label="Categoria">{categorias.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}</select></label>
      <label>Valor<input name="valor" type="number" min="0.01" step="0.01" required aria-label="Valor" /></label>
      <label>Vencimento<input name="vencimento" type="date" required aria-label="Vencimento" /></label>
      <label>Favorecido<input name="favorecido" aria-label="Favorecido" /></label>
      {aviso && <p role="alert">{aviso}</p>}
      <button type="submit">Confirmar</button>
    </form>}
  </section>;
}
