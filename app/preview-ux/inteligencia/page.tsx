import { notFound } from "next/navigation";
import AdminShell from "@/components/admin/AdminShell";
import DashboardGeral from "@/components/admin/DashboardGeral";
import { fonteAdmin } from "@/components/admin/fonte";
import PreviewInteligencia from "@/components/admin/inteligencia/PreviewInteligencia";
import { painelVitrine } from "@/lib/financeiro/vitrine";

/** Vitrine do drawer "Perguntar ao Kidmais" (leitura, rascunho, Human Gate). Só com KIDMAIS_PREVIEW_UX=1. */
export default async function Page({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  if (process.env.KIDMAIS_PREVIEW_UX !== "1") notFound();
  const { estado } = await searchParams;
  return <div className={fonteAdmin.variable}>
    <AdminShell vitrine={{ nome: "Administrador", caminho: "/admin/dashboard" }}>
      <DashboardGeral inicial={painelVitrine} />
      <PreviewInteligencia estado={estado} />
    </AdminShell>
  </div>;
}
