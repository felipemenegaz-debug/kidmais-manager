import type { Metadata } from "next";
import MeuPedido from "@/components/pre-reserva/MeuPedido";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Meu pedido",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function MeuPedidoPage() {
  return <MeuPedido empresa={null} />;
}
