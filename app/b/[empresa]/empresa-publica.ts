import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db/postgres";
import { escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import { lerRegrasPagamento, REGRAS_LEGADAS, type RegrasPagamento } from "@/lib/comercial/regras-pagamento";
import { nomePublicoDaEmpresa } from "@/lib/perfil/nome-publico";

/**
 * Em breve até a homologação: fora dos buscadores. Título, descrição e ícone neutros (o layout raiz usa os da
 * Kidmais); o ícone daqui substitui o da raiz só nas páginas /b/<código>.
 */
export const metadataEmpresaPublica: Metadata = {
  title: "Orçamento da festa",
  description: "Consulte datas disponíveis e envie o pedido da sua festa.",
  robots: { index: false, follow: false },
  icons: { icon: [{ url: "/icone-orcamento.svg", type: "image/svg+xml" }] },
};

/**
 * Antes da 077 o servidor aplica o legado (PIX 10%/3%) a toda condição: a tela mostra o mesmo, mas sem o selo
 * de -15% de dia útil nem o rótulo “Cielo”, que são da Kidmais. Com a 077, as regras da própria empresa.
 */
const ANTES_DA_077: RegrasPagamento = Object.freeze({ ...REGRAS_LEGADAS, cartaoRotulo: "Cartão de crédito", descontoDiaUtil: false });

/**
 * A página do endereço da empresa só abre se o servidor atenderia a cotação dela (mesma regra das APIs).
 * Qualquer recusa vira 404, sem dizer se a empresa existe, qual é o plano ou a situação da assinatura.
 * Devolve o código, o nome público e as regras de pagamento da própria empresa (nada da Kidmais nem de terceiros).
 */
export async function exigirEmpresaPublica(params: Promise<{ empresa: string }>) {
  const { empresa } = await params;
  let nome: string | null, pagamento: RegrasPagamento;
  try {
    const escopo = await escopoCotacaoPublica(db, empresa);
    nome = await nomePublicoDaEmpresa(db(), escopo.empresaId);
    if (!nome) throw new Error("EMPRESA_AUSENTE");
    pagamento = (await lerRegrasPagamento(db(), escopo.empresaId)) ?? ANTES_DA_077;
  } catch {
    notFound();
  }
  return { codigo: empresa, nome, pagamento: { ...pagamento } };
}
