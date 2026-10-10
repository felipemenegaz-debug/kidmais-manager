import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db/postgres";
import { escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";

/** Em breve até a homologação: fora dos buscadores. Título e descrição neutros (o raiz cita a Kidmais). */
export const metadataEmpresaPublica: Metadata = {
  title: "Orçamento da festa",
  description: "Consulte datas disponíveis e envie o pedido da sua festa.",
  robots: { index: false, follow: false },
};

/**
 * A página do endereço da empresa só abre se o servidor atenderia a cotação dela (mesma regra das APIs).
 * Qualquer recusa vira 404, sem dizer se a empresa existe, qual é o plano ou a situação da assinatura.
 * Devolve o código e o nome da própria empresa para o cabeçalho (nada da Kidmais nem de outra empresa).
 */
export async function exigirEmpresaPublica(params: Promise<{ empresa: string }>) {
  const { empresa } = await params;
  let nome: string;
  try {
    const escopo = await escopoCotacaoPublica(db, empresa);
    const linha = (await db().query<{ nome: string }>("SELECT nome FROM public.empresas WHERE id = $1::uuid", [escopo.empresaId])).rows[0];
    if (!linha) throw new Error("EMPRESA_AUSENTE");
    nome = linha.nome;
  } catch {
    notFound();
  }
  return { codigo: empresa, nome };
}
