import Link from 'next/link';
import type { ComplementoCopiloto } from './cliente-inteligencia';
import styles from './inteligencia.module.css';

/**
 * Complemento do Copiloto, SEMPRE abaixo dos dados e rotulado como sugestão: a explicação só reformula o que
 * está nos fatos (conferida pelo servidor) e a próxima ação é um procedimento, nunca uma execução.
 */
export default function ComplementoKidmais({ complemento, aoNavegar }: { complemento: ComplementoCopiloto; aoNavegar?: () => void }) {
  const { explicacao, proximaAcao } = complemento;
  if (!explicacao && !proximaAcao) return null;
  return <div className={styles.complemento}>
    {explicacao && <section aria-label="Explicação">
      <p className={styles.complementoTitulo}><span className={styles.categoria} data-categoria="sugestao">Explicação · confira nos dados acima</span></p>
      {explicacao.frases.map((f) => <p key={f} className={styles.complementoTexto}>{f}</p>)}
      <p className={styles.nota}>{explicacao.aviso}</p>
    </section>}
    {proximaAcao && <section aria-label="Próxima ação sugerida">
      <p className={styles.complementoTitulo}><span className={styles.categoria} data-categoria="sugestao">Próxima ação sugerida</span>{proximaAcao.titulo}</p>
      <ol className={styles.passos}>{proximaAcao.passos.map((p) => <li key={p}>{p}</li>)}</ol>
      {proximaAcao.destino && <Link className={styles.sugestaoCurta} href={proximaAcao.destino} onClick={aoNavegar}>Abrir a tela</Link>}
    </section>}
  </div>;
}
