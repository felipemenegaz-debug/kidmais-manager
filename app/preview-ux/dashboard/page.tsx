import { notFound } from "next/navigation";
import AdminShell from "@/components/admin/AdminShell";
import DashboardGeral from "@/components/admin/DashboardGeral";
import { fonteAdmin } from "@/components/admin/fonte";
import { painelVitrine } from "@/lib/financeiro/vitrine";

export default function Page() {
  if (process.env.KIDMAIS_PREVIEW_UX !== "1") notFound();
  return <div className={fonteAdmin.variable}>
    <AdminShell vitrine={{ nome: "Administrador", caminho: "/admin/dashboard" }}>
      <DashboardGeral inicial={painelVitrine} />
    </AdminShell>
  </div>;
}
