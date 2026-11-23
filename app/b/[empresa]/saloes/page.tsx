import { notFound } from "next/navigation";
import ConhecaSaloes from "@/components/saloes/ConhecaSaloes";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { codigoDaEmpresaLegada, exigirEmpresaPublica } from "../empresa-publica";

export const dynamic = "force-dynamic";
export { gerarMetadataEmpresaPublica as generateMetadata } from "../empresa-publica";

/** S-D: "Conheça os salões" do buffet do endereço; sem a etapa publicada, o componente segue direto para o fechamento. */
export default async function SaloesDaEmpresaPage({ params }: { params: Promise<{ empresa: string }> }) {
  if (await codigoDaEmpresaLegada(params)) notFound();

  const empresa = await exigirEmpresaPublica(params);
  return <MarcaPublicaProvider nome={empresa.nome} pagamento={empresa.pagamento} contato={empresa.contato}><ConhecaSaloes empresa={empresa.codigo} /></MarcaPublicaProvider>;
}
