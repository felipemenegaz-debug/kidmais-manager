/**
 * Preparação CANÔNICA de texto para qualquer modelo (Model Router). Única fonte das regras de minimização da IA:
 * JEV, classificação de intenção por modelo, Context Builder e a barreira do próprio roteador usam estas funções —
 * nenhum caminho mantém cópia própria das expressões.
 *
 * - remove caracteres invisíveis e de controle (zero-width, bidi, BOM, C0/C1);
 * - normaliza (NFKC: largura total/compatibilidade viram as letras comuns) e colapsa espaços;
 * - redige ANTES de cortar (um CPF nunca sobra pela metade no limite): e-mail, id (uuid), CNPJ, CPF, telefone e,
 *   quando pedido, links internos e números longos (6+ dígitos);
 * - limita o comprimento.
 */

const hex = (n: number) => n.toString(16).padStart(4, "0");
/** Faixas de code points invisíveis/de controle (montadas por código: nenhum caractere oculto literal no fonte). */
const FAIXAS_OCULTAS: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f], [0x007f, 0x009f],
  [0x00ad, 0x00ad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff],
];
export const OCULTOS_MODELO = new RegExp(`[${FAIXAS_OCULTAS.map(([a, b]) => (a === b ? `\\u${hex(a)}` : `\\u${hex(a)}-\\u${hex(b)}`)).join("")}]`, "g");

/** Padrões de dado pessoal/identificador, na ordem de aplicação (e-mail e ids antes dos numéricos). */
export const PADROES_LINK: ReadonlyArray<readonly [RegExp, string]> = [
  [/https?:\/\/\S+/gi, "[link]"],
  [/(?:^|\s)\/(?:admin|clientes|festas|contratos|api)\/\S*/g, " [link]"],
];
export const PADROES_PII: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[cnpj]"],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]"],
  [/(?:\+?55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, "[telefone]"],
];
export const PADRAO_NUMERO_LONGO: readonly [RegExp, string] = [/\b\d{6,}\b/g, "[numero]"];

export type OpcoesTextoModelo = {
  /** Comprimento máximo depois da redação (padrão 300). */
  limite?: number;
  /** Números com 6+ dígitos viram [numero] (padrão: sim). Desligado só onde valores numéricos já são agregados. */
  numeros?: boolean;
  /** Links e caminhos internos viram [link] (padrão: sim). */
  links?: boolean;
};

export type TextoParaModelo = { texto: string; ocultosRemovidos: boolean; truncado: boolean; redacoes: number };

/** Redação de PII sem cortar nem normalizar (base comum dos caminhos). */
export function redigirPII(texto: string, opcoes: Pick<OpcoesTextoModelo, "numeros" | "links"> = {}): { texto: string; redacoes: number } {
  let redacoes = 0;
  const padroes = [
    ...(opcoes.links === false ? [] : PADROES_LINK),
    ...PADROES_PII,
    ...(opcoes.numeros === false ? [] : [PADRAO_NUMERO_LONGO]),
  ];
  let saida = texto;
  for (const [padrao, marcador] of padroes) {
    saida = saida.replace(padrao, () => {
      redacoes += 1;
      return marcador;
    });
  }
  return { texto: saida, redacoes };
}

/** Texto livre (do operador ou de dado) pronto para um modelo. */
export function prepararTextoParaModelo(bruto: string, opcoes: OpcoesTextoModelo = {}): TextoParaModelo {
  const normalizado = bruto.normalize("NFKC");
  const semOcultos = normalizado.replace(OCULTOS_MODELO, "");
  const ocultosRemovidos = semOcultos !== normalizado;
  const redigido = redigirPII(semOcultos.replace(/\s+/g, " ").trim(), opcoes);
  const limite = opcoes.limite ?? 300;
  const truncado = redigido.texto.length > limite;
  return { texto: truncado ? redigido.texto.slice(0, limite) : redigido.texto, ocultosRemovidos, truncado, redacoes: redigido.redacoes };
}

/**
 * Barreira do Model Router: toda mensagem de usuário que chega a um provedor passa por aqui, qualquer que seja o
 * chamador. Remove ocultos e redige PII sem cortar (o chamador já limitou) e sem tocar em números (explicações de
 * valores agregados dependem deles). Idempotente: marcadores já redigidos não mudam.
 */
export function barreiraTextoModelo(conteudo: string): string {
  return redigirPII(conteudo.replace(OCULTOS_MODELO, ""), { numeros: false, links: false }).texto;
}
