/**
 * Apresentação das telas públicas de cotação/fechamento. Sem empresa informada = endereço atual (Kidmais, inalterado).
 * Endereço de outra empresa (/b/<código>): nome da empresa no cabeçalho e redação neutra (“o buffet”), sem logo,
 * contatos, capacidade ou processador de pagamento da Kidmais.
 */
import { REGRAS_LEGADAS, type RegrasPagamento } from "../comercial/regras-pagamento.ts";

export type MarcaPublica = { kidmais: true } | { kidmais: false; nome: string; pagamento: RegrasPagamento };

export type TextosMarca = {
  kidmais: boolean;
  /** Nome exibido no cabeçalho. */
  nome: string;
  /** “a Kidmais” / “o buffet” (sujeito, minúsculo). */
  a: string;
  /** Início de frase: “A Kidmais” / “O buffet”. */
  A: string;
  /** “da Kidmais” / “do buffet”. */
  da: string;
  /** “pela Kidmais” / “pelo buffet”. */
  pela: string;
  /** “equipe Kidmais” / “equipe do buffet”. */
  equipe: string;
  /** Título curto: “Kidmais” / “O buffet”. */
  titulo: string;
  /** Aviso contratual em maiúsculas: “da KIDMAIS” / “do BUFFET”. */
  daMaiusculo: string;
  /** Regras de pagamento exibidas: Kidmais = legadas; outra empresa = as dela (servidor). */
  pagamento: RegrasPagamento;
};

export const MARCA_KIDMAIS: MarcaPublica = { kidmais: true };

export function textosMarca(marca: MarcaPublica): TextosMarca {
  if (marca.kidmais)
    return { kidmais: true, nome: "Kidmais", a: "a Kidmais", A: "A Kidmais", da: "da Kidmais", pela: "pela Kidmais",
      equipe: "equipe Kidmais", titulo: "Kidmais", daMaiusculo: "da KIDMAIS", pagamento: REGRAS_LEGADAS };
  const nome = marca.nome.trim() || "Buffet";
  return { kidmais: false, nome, a: "o buffet", A: "O buffet", da: "do buffet", pela: "pelo buffet",
    equipe: "equipe do buffet", titulo: "O buffet", daMaiusculo: "do BUFFET", pagamento: marca.pagamento };
}

/** Rótulo do cartão PIX: “10% de desconto” ou, sem desconto configurado, “Sem desconto automático”. */
export function rotuloDescontoPix(percentual: number) {
  return percentual > 0 ? `${percentual}% de desconto` : "Sem desconto automático";
}

/** Frase das condições após aprovação. Kidmais: texto atual, idêntico. */
export function textoCondicoesPagamento(marca: TextosMarca) {
  const { pixAvistaPercentual: avista, pixParceladoPercentual: parcelado } = marca.pagamento;
  const descontos = avista > 0 || parcelado > 0
    ? `Após aprovação: PIX à vista tem ${avista}% de desconto. PIX parcelado tem ${parcelado}% de desconto; as condições são confirmadas pela ${marca.equipe}.`
    : `As condições de pagamento são confirmadas pela ${marca.equipe} após a aprovação.`;
  return marca.kidmais ? `${descontos} Cartão é processado pela Cielo.` : descontos;
}