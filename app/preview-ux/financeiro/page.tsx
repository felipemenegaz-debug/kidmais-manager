import { notFound } from "next/navigation";
import AdminShell from "@/components/admin/AdminShell";
import FinanceiroTelas, { type TelaFinanceira } from "@/components/admin/FinanceiroTelas";
import { fonteAdmin } from "@/components/admin/fonte";
import { financeiroVitrine } from "@/lib/financeiro/vitrine";

const telas: Record<string, TelaFinanceira> = {
  visao: "visao",
  receber: "receber",
  pagar: "pagar",
  fluxo: "fluxo",
  relatorios: "relatorios",
};

export default async function Page({ searchParams }: { searchParams: Promise<{ tela?: string }> }) {
  if (process.env.KIDMAIS_PREVIEW_UX !== "1") notFound();
  const params = await searchParams;
  const tela = telas[params.tela ?? "visao"] ?? "visao";
  const caminho = tela === "visao" ? "/admin/financeiro" : `/admin/financeiro/${tela === "receber" ? "contas-receber" : tela === "pagar" ? "contas-pagar" : tela === "fluxo" ? "fluxo-caixa" : "relatorios"}`;
  return <div className={fonteAdmin.variable}>
    <AdminShell vitrine={{ nome: "Administrador", caminho }}>
      <FinanceiroTelas tela={tela} amostra={financeiroVitrine} />
    </AdminShell>
  </div>;
}
