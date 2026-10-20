'use client';
import { useState } from 'react';
import { CabecalhoMarketing, EstadoCarga, enviarMarketing, useMarketing } from './comum';
import styles from './marketing.module.css';

type Pessoa = { membershipId: string; nome: string; email: string; gestao: boolean; concessoes: Array<{ id: string; capacidade: string; concedidoEm: string; motivo: string }> };
type Dados = { equipe: Pessoa[]; capacidades: Array<{ codigo: string; rotulo: string }> };

/** Gestão concede/revoga capacidades de Marketing à Equipe (com motivo; nada é apagado, revogação fica registrada). */
export default function MarketingPermissoes() {
  const { dados, falha, carregando, recarregar, setDados } = useMarketing<Dados>('/api/admin/marketing/permissoes');
  const [erro, setErro] = useState('');
  async function alternar(p: Pessoa, codigo: string) {
    const concessao = p.concessoes.find((c) => c.capacidade === codigo);
    const motivo = window.prompt(concessao ? 'Motivo da revogação:' : 'Motivo da concessão:', concessao ? 'Ajuste de acesso' : 'Atua no Marketing');
    if (!motivo || motivo.trim().length < 3) return;
    setErro('');
    try {
      const r = await enviarMarketing<{ equipe: Pessoa[] }>('/api/admin/marketing/permissoes', concessao
        ? { acao: 'revogar', concessaoId: concessao.id, motivo } : { acao: 'conceder', membershipId: p.membershipId, capacidade: codigo, motivo });
      if (dados) setDados({ ...dados, equipe: r.equipe });
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
  }
  return <main className={styles.pagina}>
    <CabecalhoMarketing titulo="Permissões de Marketing" descricao="A Gestão tem todas as permissões. Libere para a Equipe só o necessário: ver, editar campanhas, editar ou publicar o site, domínio e automações." />
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {erro && <p className={styles.aviso} role="alert">{erro}</p>}
    {dados && <section className={styles.cartao}><div className={styles.tabelaWrap}><table className={styles.tabela}>
      <thead><tr><th>Pessoa</th>{dados.capacidades.map((c) => <th key={c.codigo}>{c.rotulo}</th>)}</tr></thead>
      <tbody>{dados.equipe.map((p) => <tr key={p.membershipId}><td>{p.nome}<br /><span className={styles.muted}>{p.email}</span></td>
        {dados.capacidades.map((c) => <td key={c.codigo}>{p.gestao ? <span className={styles.seloAtivo}>Gestão</span>
          : <label className={styles.check}><input type="checkbox" checked={p.concessoes.some((x) => x.capacidade === c.codigo)} onChange={() => void alternar(p, c.codigo)} /><span className={styles.srOnly}>{c.rotulo} para {p.nome}</span></label>}</td>)}
      </tr>)}</tbody>
    </table></div></section>}
  </main>;
}
