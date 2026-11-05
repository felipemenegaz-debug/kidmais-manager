import FechamentoWizard from "@/components/fechamento/FechamentoWizard";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { exigirEmpresaPublica, metadataEmpresaPublica } from "../empresa-publica";

export const dynamic = "force-dynamic";
export const metadata = metadataEmpresaPublica;

/**
 * Pedido de orçamento do buffet: /b/<código>/orcamento. Mesma tela e mesmas regras de /b/<código>/fechamento, que
 * continua respondendo para os links já enviados.
 */
export default async function OrcamentoDaEmpresaPage({ params }: { params: Promise<{ empresa: string }> }) {
  const empresa = await exigirEmpresaPublica(params);
  return <MarcaPublicaProvider nome={empresa.nome} pagamento={empresa.pagamento} contato={empresa.contato}><FechamentoWizard empresa={empresa.codigo} /></MarcaPublicaProvider>;
}
