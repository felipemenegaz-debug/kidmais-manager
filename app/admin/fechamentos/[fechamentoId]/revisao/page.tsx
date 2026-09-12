import RevisaoComercial from "@/components/admin/RevisaoComercial";

export default async function Page({ params }: { params: Promise<{ fechamentoId: string }> }) {
  const { fechamentoId } = await params;
  return <RevisaoComercial fechamentoId={fechamentoId} />;
}
