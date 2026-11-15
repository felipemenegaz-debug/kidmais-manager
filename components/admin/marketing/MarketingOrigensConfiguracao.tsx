'use client';
import {useState} from 'react';
import type {OpcaoOrigem} from '@/lib/marketing/origens';
import {EstadoCarga,enviarMarketing,useMarketing} from './comum';
import styles from './marketing.module.css';
export default function MarketingOrigensConfiguracao(){const {dados,falha,carregando,recarregar}=useMarketing<{origens:OpcaoOrigem[];gestao:boolean}>('/api/admin/marketing/origens');return <main className={styles.pagina}><h1>Opções de origem</h1><EstadoCarga carregando={carregando} falha={falha} aoTentar={recarregar}/>{dados&&<ListaOrigens origens={dados.origens} gestao={dados.gestao} aoSalvar={recarregar}/>}</main>;}
function ListaOrigens({ origens, gestao, aoSalvar }: { origens: OpcaoOrigem[]; gestao: boolean; aoSalvar: () => void }) {
  const [novo, setNovo] = useState('');
  const [aviso, setAviso] = useState('');
  async function salvar(corpo: Record<string, unknown>) {
    setAviso('');
    try { await enviarMarketing('/api/admin/marketing/origens', corpo); setNovo(''); aoSalvar(); }
    catch (e) { setAviso(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  }
  return <section className={styles.cartao} aria-labelledby="t-opcoes">
    <h2 id="t-opcoes">Opções de origem</h2>
    <p className={styles.muted}>Usadas no CRM para informar como o cliente conheceu o buffet. Desativar esconde de novos registros; o histórico continua legível.</p>
    <ul className={styles.datas}>{origens.map((o) => <li key={o.codigo}>{o.rotulo}{!o.ativa && ' (inativa)'}
      {gestao && <> <button type="button" className={styles.fantasma} style={{ minHeight: 28, padding: '0 8px' }} onClick={() => void salvar({ codigo: o.codigo, rotulo: o.rotulo, ativa: !o.ativa, ordem: o.ordem })}>{o.ativa ? 'Desativar' : 'Ativar'}</button></>}</li>)}</ul>
    {gestao && <form className={styles.filtros} style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); if (novo.trim()) void salvar({ rotulo: novo.trim(), ativa: true }); }}>
      <label>Nova origem<input value={novo} maxLength={60} onChange={(e) => setNovo(e.target.value)} placeholder="ex.: Feira de noivas" /></label>
      <button type="submit" className={styles.secundario}>Adicionar</button>
    </form>}
    {aviso && <p className={styles.erro} role="alert">{aviso}</p>}
  </section>;
}
