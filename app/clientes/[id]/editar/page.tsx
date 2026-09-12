"use client";

import { useParams } from "next/navigation";
import ClienteForm from "@/components/clientes/ClienteForm";

export default function Page() {
  const params = useParams<{ id: string }>();
  return <ClienteForm mode="edit" clienteId={params.id} />;
}
