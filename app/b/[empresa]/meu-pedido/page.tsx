import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import MeuPedido from "@/components/pre-reserva/MeuPedido";
import { destinoMeuPedido } from "@/components/pre-reserva/origem-meu-pedido";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import { REGRAS_LEGADAS } from "@/lib/comercial/regras-pagamento";
import { db } from "@/lib/db/postgres";
import { nomePublicoDaEmpresa } from "@/lib/perfil/nome-publico";
import { logoDoAssistente } from "../empresa-publica";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Meu pedido",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
  icons: { icon: [{ url: "/icone-orcamento.svg", type: "image/svg+xml" }] },
};

export default async function MeuPedidoDaEmpresaPage({ params }: { params: Promise<{ empresa: string }> }) {
  const { empresa } = await params;
  const destino = destinoMeuPedido(await headers(), empresa);
  if (destino.tipo === "INDISPONIVEL") notFound();
  if (destino.tipo === "REDIRECIONAR") redirect(destino.destino);
  const escopo = await escopoCotacaoPublica(db, empresa, { acompanharPedido: true }).catch(() => null);
  if (!escopo) notFound();
  const nome = await nomePublicoDaEmpresa(db(), escopo.empresaId).catch(() => null);
  if (!nome) notFound();
  const logo = await logoDoAssistente(escopo.empresaId);
  return (
    <MarcaPublicaProvider nome={nome} pagamento={{ ...REGRAS_LEGADAS }}>
      <MeuPedido key={empresa} empresa={empresa} logo={logo} />
    </MarcaPublicaProvider>
  );
}
