'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';
import Link from 'next/link';
import KidmaisBrand from '@/components/layout/KidmaisBrand';
export default function AdminShell({ children }: {
    children: React.ReactNode;
}) {
    const path = usePathname(), [name, setName] = useState<string | null>(null),[configurar,setConfigurar]=useState(false);
    const router = useRouter();
    useEffect(() => { if (path === '/admin/login')
        return; let alive = true; fetch('/api/admin/autenticacao', { cache: 'no-store' }).then(r => r.json()).then(b => { if (!b.ok || !b.data.usuarioId)
        router.replace('/admin/login');
    else if (alive){setName(b.data.nome);setConfigurar(b.data.papel==='REPRESENTANTE_AUTORIZADO');} }).catch(() => router.replace('/admin/login')); return () => { alive = false; }; }, [path, router]);
    if (path === '/admin/login')
        return <div className={styles.shell}>{children}</div>;
    if (!name)
        return <p>Verificando sessão…</p>;
    return <div className={styles.shell}><header className={styles.nav}><KidmaisBrand subtitle="Gestão de festas" href="/admin/contratos"/><nav aria-label="Menu administrativo"><Link href="/clientes" aria-current={path.startsWith('/clientes')?'page':undefined}>Clientes</Link><Link href="/admin/contratos" aria-current={path.startsWith('/admin/contratos')?'page':undefined}>Contratos</Link><Link href="/admin/festas" aria-current={path.startsWith('/admin/festas')?'page':undefined}>Festas</Link><Link href="/admin/disponibilidade" aria-current={path==='/admin/disponibilidade'?'page':undefined}>Agenda / Disponibilidade</Link>{configurar&&<Link href="/admin/configuracoes/acessos">Configurações</Link>}</nav><span>{name}</span><button onClick={async () => { const res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'logout' }) }); if (res.ok) {
        setName(null);
        router.replace('/admin/login');
        router.refresh();
    } }}>Sair</button></header>{children}</div>;
}
