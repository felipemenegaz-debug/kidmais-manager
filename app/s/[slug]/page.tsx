import PaginaPublica, { metadataDaPagina } from "@/components/marketing/site/PaginaPublica";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Site público do buffet no endereço da plataforma. Só a versão publicada; qualquer recusa é 404. */
export async function generateMetadata({ params }: Props) {
  return metadataDaPagina({ tipo: "PLATAFORMA", slug: (await params).slug });
}

export default async function Page({ params, searchParams }: Props) {
  return <PaginaPublica via={{ tipo: "PLATAFORMA", slug: (await params).slug }} parametros={await searchParams} />;
}
