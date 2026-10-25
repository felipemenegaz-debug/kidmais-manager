'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import FinanceiroContrato from './FinanceiroContrato';
import { erroPagamentos } from './contrato-tela';
import styles from './contratos-ux.module.css';

/**
 * Aba Pagamentos (plano rev. 3 §N7 + rev. 4 §R3-2): cartões a partir da MESMA leitura do Financeiro
 * (`/api/admin/contratos/<id>/financeiro`, um único pagamento). Só mostra números com resposta válida; recusas viram
 * mensagem de conferência, sem números e sem sugerir nova obrigação. O painel financeiro existente segue abaixo.
 */
type Posicao = { obrigacao: string; liquido: string; saldo: string; credito: string; reservado: string };
type PainelFinanceiro = {
  valorVigente: string; posicao: Posicao; motivos?: string[];
  cobranca: { encerrada: boolean; saldoACobrar: string; acertoAdministrativoPendente: boolean };
  futuro: Array<{ parcelaId: string; valorCentavos: string; vencimento: string }>;
};
const moeda = (v: string) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(BigInt(v)) / 100);
const data = (iso: string) => iso.split('-').reverse().join('/');

export default function PagamentosResumo({ contratoId, temVigente, onReady }: { contratoId: string; temVigente: boolean; onReady?: () => void }) {
  const [painel, setPainel] = useState<PainelFinanceiro | null>(null);
  const [falha, setFalha] = useState<ReturnType<typeof erroPagamentos> | null>(null), [tentativa, setTentativa] = useState(0);
  useEffect(() => {
    let ativo = true;
    adminFetch(`/api/admin/contratos/${contratoId}/financeiro`).then(async r => {
      const b = await r.json().catch(() => ({ ok: false }));
      if (!ativo) return;
      if (r.ok && b.ok) setPainel(b.data.painel); else setFalha(erroPagamentos(r.status, b.codigo, temVigente));
    }).catch(() => { if (ativo) setFalha(erroPagamentos(0, null, temVigente)); });
    return () => { ativo = false; };
  }, [contratoId, temVigente, tentativa]);
  const atualizar = useCallback((p: unknown) => setPainel(p as PainelFinanceiro), []);
  // Recusa numa leitura posterior (painel existente, inclusive a recarga depois de uma operação): os números saem.
  const recusar = useCallback((status: number, codigo?: string) => { setPainel(null); setFalha(erroPagamentos(status, codigo, temVigente)); }, [temVigente]);
  if (falha) return <div className={styles.notice} role="status" data-pagamentos={falha.tipo}>
    <p>{falha.texto}</p>
    {falha.tipo === 'TENTAR' && <button type="button" onClick={() => { setFalha(null); setTentativa(t => t + 1); }}>Tentar de novo</button>}
  </div>;
  if (!painel) return <p role="status" data-pagamentos="CARREGANDO">Carregando pagamentos…</p>;
  const { posicao, cobranca } = painel, obrigacao = BigInt(posicao.obrigacao), liquido = BigInt(posicao.liquido);
  const largura = obrigacao > 0n ? Math.min(100, Number((liquido * 100n) / obrigacao)) : liquido > 0n ? 100 : 0;
  const proxima = painel.futuro.find(f => BigInt(f.valorCentavos) > 0n);
  return <>
    <div className={styles.cartoes} data-pagamentos="OK">
      <div className={styles.cartao}><span>Valor do contrato</span><strong>{moeda(painel.valorVigente)}</strong></div>
      <div className={styles.cartao}><span>Recebido</span><strong>{moeda(posicao.liquido)}</strong><small>líquido de estornos e devoluções</small></div>
      <div className={styles.cartao}><span>A cobrar</span>{cobranca.encerrada ? <strong>Cobrança encerrada</strong> : <strong>{moeda(cobranca.saldoACobrar)}</strong>}</div>
      {cobranca.encerrada && BigInt(posicao.saldo) > 0n && <div className={styles.cartao}><span>Saldo não cobrável</span><strong>{moeda(posicao.saldo)}</strong><small>em aberto no cancelamento</small></div>}
      {BigInt(posicao.credito) > 0n && <div className={styles.cartao}><span>Crédito do cliente</span><strong>{moeda(posicao.credito)}</strong>{BigInt(posicao.reservado) > 0n && <small>{moeda(posicao.reservado)} reservado para devolução</small>}</div>}
    </div>
    <div className={styles.barraPagamento} role="img" aria-label={`Recebido ${moeda(posicao.liquido)} de ${moeda(posicao.obrigacao)}`}><span style={{ width: `${largura}%` }} /></div>
    <p className={styles.discreto}>Recebido {moeda(posicao.liquido)} do valor reconhecido ({moeda(posicao.obrigacao)}).{proxima && !cobranca.encerrada ? ` Próxima parcela: ${moeda(proxima.valorCentavos)} em ${data(proxima.vencimento)}.` : ''}</p>
    {posicao.obrigacao !== painel.valorVigente && <p className={styles.notice}>Alteração financeira pendente de tratamento: o valor reconhecido ainda não acompanha o valor do contrato.</p>}
    {cobranca.acertoAdministrativoPendente && <p className={styles.notice}>Acerto administrativo pendente.</p>}
    <FinanceiroContrato key={contratoId} contratoId={contratoId} onReady={onReady} onPainel={atualizar} onFalha={recusar} />
  </>;
}
