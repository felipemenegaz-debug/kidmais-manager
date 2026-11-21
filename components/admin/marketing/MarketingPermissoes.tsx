'use client';
import { dialogo } from '@/components/JanelaConfirmacao';
import { useState } from 'react';
import { EstadoCarga, enviarMarketing, useMarketing } from './comum';
import styles from './marketing.module.css';

type Pessoa = { membershipId: string; nome: string; email: string; gestao: boolean; concessoes: Array<{ id: string; capacidade: string; concedidoEm: string; motivo: string }> };
type Dados = { equipe: Pessoa[]; capacidades: Array<{ codigo: string; rotulo: string }> };

/** Gestão concede/revoga capacidades de Marketing à Equipe (com motivo; nada é apagado, revogação fica registrada). */
export default function MarketingPermissoes() {
  const { dados, falha, carregando, recarregar, setDados } = useMarketing<Dados>('/api/admin/marketing/permissoes');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  async function alternar(p: Pessoa, codigo: string, gatilho: HTMLInputElement) {
    if (enviando) return;
    const concessao = p.concessoes.find((c) => c.capacidade === codigo);
    const motivo = await dialogo.perguntar(concessao ? `Revogar ${codigo} de ${p.nome}` : `Conceder ${codigo} a ${p.nome}`, concessao ? 'Motivo da revogação:' : 'Motivo da concessão:', concessao ? 'Ajuste de acesso' : 'Atua no Marketing', gatilho);
    if (!motivo || motivo.trim().length < 3) return;
    setEnviando(true);
    setErro('');
    try {
      const r = await enviarMarketing<{ equipe: Pessoa[] }>('/api/admin/marketing/permissoes', concessao
        ? { acao: 'revogar', concessaoId: concessao.id, motivo } : { acao: 'conceder', membershipId: p.membershipId, capacidade: codigo, motivo });
      if (dados) setDados({ ...dados, equipe: r.equipe });
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
    finally { setEnviando(false); }
  }
  return <section className={styles.pagina} aria-labelledby="acessos-marketing">
    <header className={styles.topo}><div><h2 id="acessos-marketing">Acessos de Marketing</h2><p>A Gestão tem todos os acessos. Libere para a equipe apenas o que ela precisa usar.</p></div></header>
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {erro && <p className={styles.aviso} role="alert">{erro}</p>}
    {dados && <section className={styles.cartao}><div className={`${styles.tabelaWrap} ${styles.responsiva}`}><table className={`${styles.tabela} ${styles.tabelaAcessos}`}>
      <thead><tr><th>Pessoa</th>{dados.capacidades.map((c) => <th key={c.codigo}>{c.rotulo}</th>)}</tr></thead>
      <tbody>{dados.equipe.map((p) => <tr key={p.membershipId}><td>{p.nome}<br /><span className={styles.muted}>{p.email}</span></td>
        {dados.capacidades.map((c) => <td key={c.codigo}>{p.gestao ? <span className={styles.seloAtivo}>Gestão</span>
          : <label className={styles.check}><input type="checkbox" disabled={enviando} checked={p.concessoes.some((x) => x.capacidade === c.codigo)} onChange={evento => void alternar(p, c.codigo, evento.currentTarget)} /><span className={styles.srOnly}>{c.rotulo} para {p.nome}</span></label>}</td>)}
      </tr>)}</tbody>
    </table></div><div className={styles.cards}>{dados.equipe.map(p=><article className={styles.card} key={p.membershipId}><strong>{p.nome}</strong><p>{p.email}</p>{p.gestao?<p>Gestão: todos os acessos.</p>:dados.capacidades.map(c=><label className={styles.check} key={c.codigo}><input type="checkbox" disabled={enviando} checked={p.concessoes.some(x=>x.capacidade===c.codigo)} onChange={evento=>void alternar(p,c.codigo,evento.currentTarget)}/>{c.rotulo}</label>)}</article>)}</div></section>}
  </section>;
}
