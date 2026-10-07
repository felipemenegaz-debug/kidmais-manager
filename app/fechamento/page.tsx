import FechamentoWizard from "@/components/fechamento/FechamentoWizard";
import { redirect } from "next/navigation";

export default async function FechamentoPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Compatibilidade com o atalho antigo do CRM. Estes parâmetros só orientam
  // a navegação; a autorização continua nas rotas administrativas autenticadas.
  const primeiro = (valor: string | string[] | undefined) => Array.isArray(valor) ? valor[0] : valor;
  if (primeiro(params.contexto) === "ADMIN" || primeiro(params.origem) === "ATENDIMENTO_KIDMAIS") {
    redirect("/clientes?acao=fechamento");
  }
  return <FechamentoWizard />;
}
