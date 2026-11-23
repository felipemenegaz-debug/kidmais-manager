'use client';
import { MOTIVOS_PERDA } from '@/lib/oportunidades/modelo';
import styles from './MotivoPerda.module.css';

/**
 * Motivo da perda como opções de escolha única (23/11/2026). A lista nativa dentro das janelas não abria com clique na
 * máquina de Felipe (só pelo teclado); seis opções visíveis evitam a lista e mostram tudo de uma vez.
 * Usado pela recusa do pedido (RevisaoComercial) e pela perda no Funil (Oportunidades).
 */
export function MotivoPerda({ valor, aoMudar, desativado, nome }: { valor: string; aoMudar: (motivo: string) => void; desativado?: boolean; nome: string }) {
  return <fieldset className={styles.motivos} disabled={desativado}>
    <legend>Motivo da perda</legend>
    {MOTIVOS_PERDA.map(m => <label key={m} className={styles.opcao}>
      <input type="radio" name={nome} value={m} required checked={valor === m} onChange={() => aoMudar(m)} />
      <span>{m}</span>
    </label>)}
  </fieldset>;
}
