import Link from 'next/link';
import styles from './visual.module.css';

/** Retorno padrão das subtelas de Configurações para o hub. */
export function VoltarConfiguracoes() {
  return <Link className={styles.voltar} href="/admin/configuracoes">← Voltar às Configurações</Link>;
}
