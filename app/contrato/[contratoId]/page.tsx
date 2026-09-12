"use client";

import { useParams } from "next/navigation";
import ContratoPublico from "@/components/contrato/ContratoPublico";

export default function ContratoPublicoPage() {
  const params = useParams<{ contratoId: string }>();
  return <ContratoPublico contratoId={params.contratoId} />;
}
