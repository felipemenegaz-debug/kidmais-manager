'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { Filtro, FinanceiroLista, ItemLista } from '@/lib/contratos/services/lista-contratos';
import { dataPorExtenso, tituloFesta } from './contrato-tela';
import { PREFIXO_IMPORTADO } from './contrato-url';
import styles from './contratos-ux.module.css';

/**
 * Lista de contratos (fase 2): busca no servidor, filtros rápidos com contagem, páginas de 50 por cursor e os importados
 * em conferência numa seção própria. Só leitura; abrir um contrato muda a URL (a mesma seleção de antes).
 */
type Importado = { id: string; nome: string | null; data_evento: string | null; pacote: string | null; convidados: number | null };
type Pagina = { itens: ItemLista[]; proximoCursor: string | null; contagens: Record<Filtro, number>; importados: Importado[] };
type Aba = Filtro | 'importados';
const ABAS: Array<[Aba, string]> = [['proximas', 'Próximas festas'], ['aguardando', 'Aguardando assinatura'], ['alteracao', 'Com alteração'], ['todas', 'Todas'], ['canceladas', 'Canceladas'], ['importados', 'Importados em conferência']];
const reais = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const centavos = (v: string) => reais(Number(BigInt(v)) / 100);

function situacao(i: ItemLista) {
  if (i.referencia.diagnostico) return { texto: 'Conferir', tom: 'alerta' };
  if (i.cancelado) return { texto: 'Cancelado', tom: 'neutro' };
  if (i.alteracao) return { texto: 'Alteração em andamento', tom: 'alerta' };
  if (i.aguardandoCliente) return { texto: 'Aguardando assinatura', tom: 'info' };
  if (i.status === 'ASSINADO') return { texto: 'Assinado', tom: 'ok' };
  return { texto: 'Em preparação', tom: 'neutro' };
}
function Pagamento({ f }: { f: FinanceiroLista }) {
  if (f.tipo === 'CONFERIR') return <span className={styles.chipAlerta}>Conferir pagamentos</span>;
  if (f.tipo === 'SEM_ASSINATURA') return <span className={styles.discreto}>—</span>;
  if (f.encerrada) return <span className={styles.discreto}>Cobrança encerrada · recebido {centavos(f.recebido)}</span>;
  const obrigacao = BigInt(f.obrigacao), recebido = BigInt(f.recebido);
  const largura = obrigacao > 0n ? Math.min(100, Number((recebido * 100n) / obrigacao)) : recebido > 0n ? 100 : 0;
  return <span className={styles.pagamentoLinha}><span className={styles.barraPagamento} role="img" aria-label={`Recebido ${centavos(f.recebido)} de ${centavos(f.obrigacao)}`}><span style={{ width: `${largura}%` }} /></span><span className={styles.discreto}>{centavos(f.recebido)} de {centavos(f.obrigacao)} · a cobrar {centavos(f.aCobrar)}</span></span>;
}

export default function ListaContratos({ onAbrir }: { onAbrir(selecao: string): void }) {
  const [aba, setAba] = useState<Aba>('proximas'), [texto, setTexto] = useState(''), [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState<Pagina | null>(null), [mais, setMais] = useState(false);
  const [estado, setEstado] = useState<'carregando' | 'ok' | 'erro'>('carregando'), [erro, setErro] = useState('');
  // Só a resposta do último pedido é aplicada (troca rápida de filtro ou busca).
  const pedido = useRef(0);
  async function ler(filtro: Filtro, termo: string, cursor: string | null) {
    const q = new URLSearchParams({ filtro }); if (termo) q.set('busca', termo); if (cursor) q.set('cursor', cursor);
    const r = await adminFetch(`/api/admin/contratos/lista?${q}`), b = await r.json().catch(() => null);
    if (!r.ok || !b?.ok) throw new Error(r.status === 400 ? 'Use de 2 a 80 caracteres, ou uma data como 20/04/2027.' : b?.erro || 'Não foi possível carregar os contratos.');
    return b.data as Pagina;
  }
  const filtroDaAba = (a: Aba): Filtro => (a === 'importados' ? 'todas' : a);
  useEffect(() => {
    const n = ++pedido.current;
    ler(filtroDaAba(aba), busca, null).then((p) => { if (n === pedido.current) { setPagina(p); setEstado('ok'); } })
      .catch((e: Error) => { if (n === pedido.current) { setErro(e.message); setEstado('erro'); } });
  }, [aba, busca]);
  function trocarAba(a: Aba) { if (a !== aba) { setEstado('carregando'); setAba(a); } }
  function aplicarBusca(termo: string) { const t = termo.trim(); if (t !== busca) { setEstado('carregando'); setBusca(t); } }
  async function carregarMais() {
    if (!pagina?.proximoCursor) return;
    const n = ++pedido.current; setMais(true);
    try { const p = await ler(filtroDaAba(aba), busca, pagina.proximoCursor); if (n === pedido.current) setPagina({ ...p, contagens: pagina.contagens, importados: pagina.importados, itens: [...pagina.itens, ...p.itens] }); }
    catch (e) { if (n === pedido.current) { setErro((e as Error).message); setEstado('erro'); } }
    finally { setMais(false); }
  }
  const contagem = (a: Aba) => (pagina ? (a === 'importados' ? pagina.importados.length : pagina.contagens[a]) : null);
  return <section aria-label="Lista de contratos" className={styles.lista}>
    <div className={styles.listaTopo}>
      <form role="search" className={styles.busca} onSubmit={(e) => { e.preventDefault(); aplicarBusca(texto); }}>
        <input aria-label="Buscar contrato" placeholder="Cliente, aniversariante ou data (20/04/2027)" value={texto} maxLength={80} onChange={(e) => setTexto(e.target.value)} />
        <button type="submit">Buscar</button>
        {busca && <button type="button" onClick={() => { setTexto(''); aplicarBusca(''); }}>Limpar</button>}
      </form>
      <Link className={styles.importarContrato} href="/clientes?acao=fechamento">Novo contrato</Link>
    </div>
    <div className={styles.chips} role="group" aria-label="Filtrar contratos">{ABAS.map(([id, rotulo]) => { const n = contagem(id); return <button key={id} type="button" aria-pressed={aba === id} onClick={() => trocarAba(id)}>{rotulo}{n != null ? ` · ${n}` : ''}</button>; })}</div>
    {estado === 'erro' && <p role="alert" className={styles.notice}>{erro}</p>}
    {estado === 'carregando' && <p role="status">Carregando contratos…</p>}
    {estado === 'ok' && pagina && (aba === 'importados'
      ? (pagina.importados.length ? <ul className={styles.listaItens}>{pagina.importados.map((i) => <li key={i.id}><button type="button" className={styles.linhaContrato} onClick={() => onAbrir(`${PREFIXO_IMPORTADO}${i.id}`)}>
          <span><strong>{i.nome ?? 'Contratante não informado'}</strong><span className={styles.discreto}>{[i.data_evento ? dataPorExtenso(i.data_evento) : 'Data não informada', i.pacote, i.convidados != null ? `${i.convidados} convidados` : null].filter(Boolean).join(' · ')}</span></span>
          <span className={styles.chip}>Importado — em conferência</span><span className={styles.discreto}>sem valores até a integração</span></button></li>)}</ul>
        : <p className={styles.discreto}>Nenhum contrato importado em conferência.</p>)
      : (pagina.itens.length ? <>
        <ul className={styles.listaItens}>{pagina.itens.map((i) => { const t = tituloFesta({ contratante: { nomeCompleto: i.contratante ?? 'Contratante não informado' }, aniversariante: { nome: i.aniversariante, idadeNoEvento: i.idade } }), s = situacao(i);
          return <li key={i.id}><button type="button" className={styles.linhaContrato} onClick={() => onAbrir(i.id)}>
            <span><strong>{t.titulo}{t.idade ? ` · ${t.idade}` : ''}</strong><span className={styles.discreto}>{[t.aniversariante ? i.contratante : null, i.dataEvento ? dataPorExtenso(i.dataEvento) : i.dataInvalida ? 'Conferir data' : 'Data não informada', i.pacote, i.convidados != null ? `${i.convidados} convidados` : null].filter(Boolean).join(' · ')}</span></span>
            <span className={s.tom === 'alerta' ? styles.chipAlerta : styles.chip}>{s.texto}</span>
            <Pagamento f={i.financeiro} />
            <strong className={styles.valorLinha}>{i.valor != null && i.financeiro.tipo !== 'CONFERIR' && !i.referencia.diagnostico ? reais(i.valor) : '—'}</strong>
          </button></li>; })}</ul>
        {pagina.proximoCursor && <button type="button" disabled={mais} onClick={() => void carregarMais()}>{mais ? 'Carregando…' : 'Carregar mais'}</button>}
      </> : <p className={styles.discreto}>{busca ? 'Nenhum contrato encontrado para esta busca.' : 'Nenhum contrato neste filtro.'}</p>))}
  </section>;
}
