import AdminShell from '@/components/admin/AdminShell';
import { fonteAdmin } from '@/components/admin/fonte';
export default function AdminLayout({ children }: {
    children: React.ReactNode;
}) { return <AdminShell classeFonte={fonteAdmin.variable}>{children}</AdminShell>; }
