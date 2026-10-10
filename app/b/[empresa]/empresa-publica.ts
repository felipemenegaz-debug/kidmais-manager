import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db/postgres";
import { escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";

/** Em breve até a homologação: fora dos buscadores. */
export const metadataEmpresaPublica: Metadata = { robots: { index: false, follow: false } };

/**
 * A página do endereço da empresa só abre se o servidor atenderia a cotação dela (mesma regra das APIs).
 * Qualquer recusa vira 404, sem dizer se a empresa existe, qual é o plano ou a situação da assinatura.
 */
export async function exigirEmpresaPublica(params: Promise<{ empresa: string }>) {
  const { empresa } = await params;
  try {
    await escopoCotacaoPublica(db, empresa);
  } catch {
    notFound();
  }
  return empresa;
}
