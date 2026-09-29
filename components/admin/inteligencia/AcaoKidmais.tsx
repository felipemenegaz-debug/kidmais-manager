import Link from 'next/link';
import type { RascunhoPublico } from './cliente-inteligencia';
import styles from './inteligencia.module.css';

/**
 * Rascunho e preview de uma ação sob Human Gate.
 * O preview é a única superfície com "Confirmar": o clique envia só operacaoId, versão e hash.
 * Enquanto grava, os dois botões ficam desativados (o servidor também é idempotente).
 */
function campos(rascunho: RascunhoPublico) {
  const preenchidos = rascunho.campos.filter((c) => c.valor);
  if (!preenchidos.length) return null;
  return <dl className={styles.campos}>
    {preenchidos.map((c) => <div key={c.id}><dt>{c.rotulo}</dt><dd>{c.valor}</dd></div>)}
  </dl>;
}

export function RascunhoAcao({ rascunho, pergunta, erro = null }: { rascunho: RascunhoPublico; pergunta: string; erro?: string | null }) {
  return <div className={styles.acao} data-estado="rascunho">
    <p className={styles.acaoTitulo}><span className={styles.selo}>Rascunho</span>{rascunho.titulo}</p>
    {campos(rascunho)}
    <p className={styles.perguntaKidmais}>{pergunta}</p>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
  </div>;
}

export function PreviewAcao({ rascunho, decidindo, erro, onDecidir }: {
  rascunho: RascunhoPublico;
  decidindo: boolean;
  erro: string | null;
  onDecidir(rascunho: RascunhoPublico, decisao: 'confirmar' | 'cancelar'): void;
}) {
  return <div className={styles.acao} data-estado="preview" aria-busy={decidindo}>
    <p className={styles.acaoTitulo}><span className={styles.selo}>Confira antes de gravar</span>{rascunho.titulo}</p>
    {campos(rascunho)}
    {rascunho.avisos.length > 0 && <ul className={styles.avisos}>{rascunho.avisos.map((a) => <li key={a}>{a}</li>)}</ul>}
    <p className={styles.nota}>Nenhuma alteração foi feita no cadastro. Ela só acontece quando você confirmar.</p>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    <div className={styles.decisao}>
      <button type="button" className={styles.confirmar} disabled={decidindo} onClick={() => onDecidir(rascunho, 'confirmar')}>{decidindo ? 'Gravando…' : 'Confirmar'}</button>
      <button type="button" className={styles.cancelar} disabled={decidindo} onClick={() => onDecidir(rascunho, 'cancelar')}>Cancelar</button>
    </div>
  </div>;
}

export function ResultadoAcao({ mensagem, destino, aoNavegar }: { mensagem: string; destino?: string; aoNavegar?: () => void }) {
  return <div className={styles.acao} data-estado="resultado" role="status">
    <p className={styles.resultadoTexto}>{mensagem}</p>
    {destino && <Link className={styles.sugestaoCurta} href={destino} onClick={aoNavegar}>Abrir</Link>}
  </div>;
}
