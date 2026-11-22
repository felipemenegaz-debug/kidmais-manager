import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import MeuPedido from "@/components/pre-reserva/MeuPedido";
import { destinoMeuPedido } from "@/components/pre-reserva/origem-meu-pedido";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Meu pedido",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function MeuPedidoPage() {
  const destino = destinoMeuPedido(await headers(), null);
  if (destino.tipo === "INDISPONIVEL") notFound();
  if (destino.tipo === "REDIRECIONAR") redirect(destino.destino);
  return <MeuPedido empresa={null} />;
}
