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

/**
 * Invisíveis e de controle, por PROPRIEDADE Unicode (não por lista de faixas, que envelhece): todo Cc (controle) exceto
 * tab/LF/CR, todo Cf (formatação: zero-width, bidi embeddings/overrides/ISOLATES U+2066–U+2069, soft hyphen, BOM…) e todo
 * Default_Ignorable_Code_Point (seletores de variação, fillers…). Removidos ANTES da redação, para que um identificador
 * com invisíveis no meio ainda seja reconhecido e redigido.
 */
export const OCULTOS_MODELO = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

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
  // RG: o sistema guarda texto livre (clientes.rg; o contrato imprime "RG: …"). Qualquer valor logo depois do rótulo
  // "RG" e o RG pontuado com dígito verificador (12.345.678-9 / -X, 1.234.567-8). Sem rótulo, o traço é exigido para
  // não apagar números operacionais (um valor como 12.345.678 continua).
  [/\bRG\b\s*(?:n[º°o.]?\s*)?[:.-]?\s*[0-9A-Za-z][0-9A-Za-z./-]{3,16}/gi, "RG [rg]"],
  [/\b\d{1,2}\.\d{3}\.\d{3}-[\dXx]\b/g, "[rg]"],
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
 * chamador. Remove ocultos e redige PII e links sem cortar (o chamador já limitou) e sem tocar em números (explicações
 * de valores agregados dependem deles). Idempotente: marcadores já redigidos não mudam.
 */
export function barreiraTextoModelo(conteudo: string): string {
  // Conteúdo de usuário costuma chegar serializado (JSON.stringify escapa C0 como barra-u-00XX e quebras como barra-n):
  // as formas escapadas também saem, senão um identificador com controle no meio escaparia da redação.
  const semEscapados = conteudo.replace(/\\u00[01][0-9a-fA-F]|\\u007[fF]/g, "").replace(/\\[bfnrt]/g, " ");
  return redigirPII(semEscapados.normalize("NFKC").replace(OCULTOS_MODELO, ""), { numeros: false }).texto;
}
