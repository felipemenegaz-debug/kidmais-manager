import DisponibilidadePublica from "@/components/disponibilidade/DisponibilidadePublica";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { exigirEmpresaPublica, metadataEmpresaPublica } from "../empresa-publica";

export const dynamic = "force-dynamic";
export const metadata = metadataEmpresaPublica;

export default async function DisponibilidadeDaEmpresaPage({ params }: { params: Promise<{ empresa: string }> }) {
  const empresa = await exigirEmpresaPublica(params);
  return <MarcaPublicaProvider nome={empresa.nome} pagamento={empresa.pagamento}><DisponibilidadePublica empresa={empresa.codigo} /></MarcaPublicaProvider>;
}
