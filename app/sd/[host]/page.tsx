import { headers } from "next/headers";
import PaginaPublica, { metadataDaPagina } from "@/components/marketing/site/PaginaPublica";
import { viaDominioConfirmada } from "@/lib/marketing/site/rotas-publicas";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ host: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Site público pelo domínio personalizado. Alcançado SÓ pela reescrita do proxy (Host conferido); acesso direto
 * a /sd/... ou host não ATIVO = 404.
 */
async function via(params: Props["params"]) {
  const h = await headers();
  return { via: viaDominioConfirmada((await params).host, h), host: h.get("host") };
}

export async function generateMetadata({ params }: Props) {
  const v = await via(params);
  return metadataDaPagina(v.via, v.host);
}

export default async function Page({ params, searchParams }: Props) {
  const v = await via(params);
  return <PaginaPublica via={v.via} parametros={await searchParams} hostOriginal={v.host} />;
}
