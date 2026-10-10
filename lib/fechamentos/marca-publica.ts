/**
 * Apresentação das telas públicas de cotação/fechamento. Sem empresa informada = endereço atual (Kidmais, inalterado).
 * Endereço de outra empresa (/b/<código>): nome da empresa no cabeçalho e redação neutra (“o buffet”), sem logo,
 * contatos, capacidade ou processador de pagamento da Kidmais.
 */
export type MarcaPublica = { kidmais: true } | { kidmais: false; nome: string };

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
};

export const MARCA_KIDMAIS: MarcaPublica = { kidmais: true };

export function textosMarca(marca: MarcaPublica): TextosMarca {
  if (marca.kidmais)
    return { kidmais: true, nome: "Kidmais", a: "a Kidmais", A: "A Kidmais", da: "da Kidmais", pela: "pela Kidmais",
      equipe: "equipe Kidmais", titulo: "Kidmais", daMaiusculo: "da KIDMAIS" };
  const nome = marca.nome.trim() || "Buffet";
  return { kidmais: false, nome, a: "o buffet", A: "O buffet", da: "do buffet", pela: "pelo buffet",
    equipe: "equipe do buffet", titulo: "O buffet", daMaiusculo: "do BUFFET" };
}
