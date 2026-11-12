import Link from 'next/link';
import styles from '@/components/admin/workspace.module.css';
import { CreditosIA } from '@/components/admin/AssinaturaCreditos';
import { mcpAtivo } from '@/lib/integracoes/mcp/config';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <main className={styles.page} data-admin-workspace>
    <header className={styles.header}><h1>IA e créditos</h1></header>
    <div className={styles.content}>
      <CreditosIA recurso="CONVITES">
        {mcpAtivo(process.env) && <section aria-labelledby="assistentes-externos">
          <h3 id="assistentes-externos">ChatGPT e Claude</h3>
          <p>Use sua conta do ChatGPT ou do Claude para consultar a agenda e o resumo de contas a receber da sua empresa.</p>
          <Link href="/admin/conexoes-ia">Gerenciar conexões</Link>
        </section>}
      </CreditosIA>
      <CreditosIA recurso="WALLE" />
    </div>
  </main>;
}
