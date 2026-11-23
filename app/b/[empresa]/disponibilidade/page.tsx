import DisponibilidadePublica from "@/components/disponibilidade/DisponibilidadePublica";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { codigoDaEmpresaLegada, exigirEmpresaPublica } from "../empresa-publica";

export const dynamic = "force-dynamic";
export { gerarMetadataEmpresaPublica as generateMetadata } from "../empresa-publica";

export default async function DisponibilidadeDaEmpresaPage({ params }: { params: Promise<{ empresa: string }> }) {
  const codigo = await codigoDaEmpresaLegada(params);
  if (codigo) return <DisponibilidadePublica base={codigo} />;

  const empresa = await exigirEmpresaPublica(params);
  return <MarcaPublicaProvider nome={empresa.nome} pagamento={empresa.pagamento} contato={empresa.contato}><DisponibilidadePublica empresa={empresa.codigo} /></MarcaPublicaProvider>;
}
