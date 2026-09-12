"use client";

import { useParams } from "next/navigation";
import ClienteProfile from "@/components/clientes/ClienteProfile";

export default function Page() {
  const params = useParams<{ id: string }>();
  return <ClienteProfile clienteId={params.id} />;
}
