import styles from '@/components/admin/workspace.module.css';
import { CreditosIA } from '@/components/admin/AssinaturaCreditos';

/** Créditos de IA (095): um bloco por recurso; o do WhatsApp.AI só aparece com o Wall-e liberado para a empresa. */
export default function Page() {
  return <main className={styles.page} data-admin-workspace><header className={styles.header}><h1>Créditos de IA</h1></header>
    <div className={styles.content}><CreditosIA recurso="CONVITES" /><CreditosIA recurso="WALLE" /></div></main>;
}
