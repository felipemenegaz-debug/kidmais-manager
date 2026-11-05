import Link from 'next/link';
import styles from '@/components/admin/workspace.module.css';
import FranquiaConvites from '@/components/admin/FranquiaConvites';
import { mcpAtivo } from '@/lib/integracoes/mcp/config';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <main className={styles.page} data-admin-workspace>
    <header className={styles.header}><h1>IA e créditos</h1></header>
    <div className={styles.content}>
      <section className={styles.card}><h2>Créditos de convite</h2><FranquiaConvites /></section>
      {mcpAtivo(process.env) && <section className={styles.card}>
        <h2>ChatGPT e Claude</h2>
        <p>Use sua conta do ChatGPT ou do Claude para consultar a agenda e o resumo de contas a receber da sua empresa.</p>
        <Link href="/admin/conexoes-ia">Gerenciar conexões</Link>
      </section>}
    </div>
  </main>;
}
