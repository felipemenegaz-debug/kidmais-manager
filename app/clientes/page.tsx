import ClientesPage from "@/components/clientes/ClientesPage";

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { acao } = await searchParams;
  return <ClientesPage selecionarParaFechamento={acao === "fechamento"} />;
}
