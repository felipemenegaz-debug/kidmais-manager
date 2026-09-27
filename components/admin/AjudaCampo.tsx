'use client';

import { useId } from 'react';
import styles from './workspace.module.css';

export function AjudaCampo({ texto }: { texto: string }) {
  const id = useId();
  return <span className={styles.ajuda}>
    <button type="button" className={styles.ajudaBotao} aria-describedby={id}><span aria-hidden="true">?</span><span className={styles.srOnly}>Ajuda</span></button>
    <span id={id} role="tooltip" className={styles.ajudaNota}>{texto}</span>
  </span>;
}
