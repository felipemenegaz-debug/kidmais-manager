"use client";

import { useParams } from "next/navigation";
import ClienteProfile from "@/components/clientes/ClienteProfile";
import { ContextoKidmais } from "@/components/admin/inteligencia/PerguntarKidmais";

export default function Page() {
  const params = useParams<{ id: string }>();
  return <>
    <ContextoKidmais tela="cliente" entidadeId={params.id} />
    <ClienteProfile clienteId={params.id} />
  </>;
}
