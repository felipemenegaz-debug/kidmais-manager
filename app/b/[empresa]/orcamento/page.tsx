import FechamentoWizard from "@/components/fechamento/FechamentoWizard";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { codigoDaEmpresaLegada, exigirEmpresaPublica, logoDoAssistente, redirecionarAtalhoDoPainel, type BuscaFechamento } from "../empresa-publica";

export const dynamic = "force-dynamic";
export { gerarMetadataEmpresaPublica as generateMetadata } from "../empresa-publica";

/**
 * Pedido de orçamento do buffet: /b/<código>/orcamento. Mesma tela e mesmas regras de /b/<código>/fechamento, que
 * continua respondendo para os links já enviados.
 */
export default async function OrcamentoDaEmpresaPage({ params, searchParams }: {
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
