import FechamentoWizard from "@/components/fechamento/FechamentoWizard";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { codigoDaEmpresaLegada, exigirEmpresaPublica, logoDoAssistente, redirecionarAtalhoDoPainel, type BuscaFechamento } from "../empresa-publica";

export const dynamic = "force-dynamic";
export { gerarMetadataEmpresaPublica as generateMetadata } from "../empresa-publica";

export default async function FechamentoDaEmpresaPage({ params, searchParams }: {
  params: Promise<{ empresa: string }>;
  searchParams: BuscaFechamento;
}) {
  const codigo = await codigoDaEmpresaLegada(params);
  if (codigo) {
    await redirecionarAtalhoDoPainel(searchParams);
    return <FechamentoWizard base={codigo} />;
  }

  const empresa = await exigirEmpresaPublica(params);
  const logo = await logoDoAssistente(empresa.id);
  return <MarcaPublicaProvider nome={empresa.nome} pagamento={empresa.pagamento} contato={empresa.contato}><FechamentoWizard empresa={empresa.codigo} logo={logo} /></MarcaPublicaProvider>;
}
