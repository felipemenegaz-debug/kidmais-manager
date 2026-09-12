import AdminShell from '@/components/admin/AdminShell';
export default function ClientesLayout({ children }: {
    children: React.ReactNode;
}) {
    return <AdminShell>{children}</AdminShell>;
}
