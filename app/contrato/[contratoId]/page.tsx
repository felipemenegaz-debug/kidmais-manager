import type { Metadata } from "next";
import ContratoPublico from "@/components/contrato/ContratoPublico";

/** Título e ícone neutros: o layout raiz usa os da Kidmais, e esta página atende o cliente de qualquer buffet. */
export const metadata: Metadata = {
  title: "Contrato",
  description: "Confira os documentos da sua contratação.",
  robots: { index: false, follow: false },
  icons: { icon: [{ url: "/icone-orcamento.svg", type: "image/svg+xml" }] },
};

/** Sem consulta ao banco: antes da prova de identidade a página não diz se o contrato existe nem de qual buffet é. */
export default async function ContratoPublicoPage({ params }: { params: Promise<{ contratoId: string }> }) {
  const { contratoId } = await params;
  return <ContratoPublico key={contratoId} contratoId={contratoId} />;
}
