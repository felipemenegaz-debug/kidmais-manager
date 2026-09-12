import Link from 'next/link';
import styles from '@/components/admin/admin.module.css';

export default function Page() {
  return <main className={styles.page}><h1>Configurações</h1><section className={styles.card}><h2>Usuários e acessos</h2><p>Organize quem pode administrar e operar as Festas.</p><Link href="/admin/configuracoes/acessos">Abrir acessos</Link></section><section className={styles.card}><h2>WhatsApp</h2><p>Conecte com segurança uma conta do WhatsApp Business por meio da Meta.</p><Link href="/admin/configuracoes/whatsapp">Abrir configuração do WhatsApp</Link></section></main>;
}
