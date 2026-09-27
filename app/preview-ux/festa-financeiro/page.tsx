import { notFound } from "next/navigation";
import AdminShell from "@/components/admin/AdminShell";
import { fonteAdmin } from "@/components/admin/fonte";
import FestaFinanceiro from "@/components/festas/FestaFinanceiro";
import { festaVitrine } from "@/lib/financeiro/vitrine";

export default function Page() {
  if (process.env.KIDMAIS_PREVIEW_UX !== "1") notFound();
  return <div className={fonteAdmin.variable}>
    <AdminShell vitrine={{ nome: "Administrador", caminho: "/admin/festas/festa" }}>
      <main style={{ padding: 32 }}><FestaFinanceiro festaId="festa" amostra={festaVitrine} /></main>
    </AdminShell>
  </div>;
}
