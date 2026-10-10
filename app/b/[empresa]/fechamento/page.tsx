import FechamentoWizard from "@/components/fechamento/FechamentoWizard";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { exigirEmpresaPublica, metadataEmpresaPublica } from "../empresa-publica";

export const dynamic = "force-dynamic";
export const metadata = metadataEmpresaPublica;

export default async function FechamentoDaEmpresaPage({ params }: { params: Promise<{ empresa: string }> }) {
  const empresa = await exigirEmpresaPublica(params);
  return <MarcaPublicaProvider nome={empresa.nome} pagamento={empresa.pagamento}><FechamentoWizard empresa={empresa.codigo} /></MarcaPublicaProvider>;
}
