import DisponibilidadePublica from "@/components/disponibilidade/DisponibilidadePublica";
import { exigirEmpresaPublica, metadataEmpresaPublica } from "../empresa-publica";

export const dynamic = "force-dynamic";
export const metadata = metadataEmpresaPublica;

export default async function DisponibilidadeDaEmpresaPage({ params }: { params: Promise<{ empresa: string }> }) {
  const empresa = await exigirEmpresaPublica(params);
  return <DisponibilidadePublica empresa={empresa} />;
}
