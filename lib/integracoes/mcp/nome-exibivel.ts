/**
 * Etapa 0b do MCP (r2, 19/11/2026): representação CONSERVADORA de um nome lido do banco. O campo de nome aceita qualquer
 * texto digitado no cadastro; em vez de tentar apagar o que parece contato ou documento (lista negra, que deixa passar
 * variações), o nome só sai quando TODO ele tem cara de nome. Qualquer sinal de outra coisa omite o campo inteiro (null):
 * nunca sai um pedaço "limpo" de um texto que trazia contato, documento ou marcação.
 *
 * A busca por nome (lib/festas/resumo-tenant.ts) compara o termo SÓ com esta representação, normalizada por
 * `normalizarParaBusca`, em JavaScript (r3: o SQL não filtra por nome): um termo que só existe na parte omitida
 * (telefone, e-mail, documento, endereço) não encontra nada.
 */

export const NOME_MAX = 80;
/** Nomes brasileiros longos chegam a 6–7 palavras; mais que isso é frase, não nome. */
export const NOME_MAX_PALAVRAS = 8;

/**
 * Espaços que o JavaScript entende por `\s`, listados por extenso (r3: só o JavaScript normaliza; o SQL não compara nomes).
 */
export const CLASSE_ESPACOS = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const ESPACOS = new RegExp(`[${CLASSE_ESPACOS}]+`, "gu");

/** Só letras (qualquer alfabeto), marcas combinantes, espaço, apóstrofo, ponto e hífen. Nenhum dígito, @, <, /, etc. */
const SO_NOME = /^[\p{L}\p{M} '’.\-]+$/u;
/** Rótulos que acompanham contato ou documento digitado no campo de nome. Palavra inteira, sem diferenciar maiúsculas. */
const ROTULOS = /(?<!\p{L})(cpf|cnpj|rg|cnh|tel|telefone|fone|celular|whatsapp|whats|zap|wpp|e-?mail|mail|http|https|www|arroba|gmail|hotmail|outlook|yahoo|icloud|pix|cep)(?!\p{L})/iu;
/** Letra, ponto, letra sem espaço: cara de domínio ou endereço ("ana.silva", "gmail.com"). */
const DOMINIO = /\p{L}\.\p{L}/u;

/**
 * r3 (19/11/2026, decisão de Felipe): lista de BLOQUEIO por palavra inteira, comparada na forma de busca (sem acento,
 * minúsculas). Pega endereço, contato e documento escritos por extenso ("Rua das Flores número dez"), que passam pela
 * lista branca de caracteres. É heurística: o risco residual (endereço sem nenhuma destas palavras) fica declarado.
 * Ficam FORA, de propósito, palavras que também são nome ou sobrenome comuns (Vila, Jardim, Ed, Al) e iniciais com
 * ponto ("R.", "N."), que derrubariam nomes legítimos.
 */
const BLOQUEIO = new Set([
  // Endereço.
  "rua", "avenida", "av", "avda", "alameda", "travessa", "trav", "rodovia", "rod", "estrada", "praca", "largo", "viela",
  "beco", "via", "quadra", "qd", "lote", "bloco", "apto", "apartamento", "apt", "casa", "sala", "andar", "conjunto",
  "condominio", "cond", "residencial", "edificio", "bairro", "km", "endereco", "logradouro", "cidade", "estado",
  "numero", "num", "nº", "complemento", "esquina", "proximo", "perto", "fundos", "postal", "cx", "caixa",
  // Contato e documento por extenso.
  "ddd", "ramal", "contato", "recado", "ligar", "chamar", "numeros", "identidade", "passaporte", "documento", "nascimento",
  "nasc", "nasceu", "senha", "pis", "nis",
  // Números por extenso.
  "zero", "um", "uma", "dois", "duas", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze",
  "treze", "quatorze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove", "vinte", "trinta",
  "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa", "cem", "cento", "duzentos", "trezentos",
  "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos", "mil", "milhao", "milhoes",
  // r4: centenas no feminino ("Caixa Postal Duzentas") e coletivos numéricos.
  "duzentas", "trezentas", "quatrocentas", "quinhentas", "seiscentas", "setecentas", "oitocentas", "novecentas",
  "dezena", "dezenas", "centena", "centenas", "milhar", "milhares",
  // r5: grafias de Portugal ("Caixa Dezasseis") e grandezas maiores.
  "dezasseis", "dezassete", "dezanove", "bilhao", "bilhoes", "biliao",
]);
const SEPARA_PALAVRAS = /[ '’.\-]+/u;
const temPalavraBloqueada = (nome: string) => normalizarParaBusca(nome).split(SEPARA_PALAVRAS).some((p) => BLOQUEIO.has(p));

/**
 * Nome exibível, ou null. Sai NFC, com espaços colapsados, sem aparar nada além das pontas. Null quando: não é texto;
 * tem qualquer caractere fora de letras/marcas/espaço/' ’ . - (dígitos de qualquer alfabeto, controle, formatação
 * invisível, bidi, marcação, @, barra, dois-pontos...); tem menos de 2 letras; passa de NOME_MAX caracteres ou de
 * NOME_MAX_PALAVRAS palavras (não trunca: omite); traz rótulo de contato/documento; tem cara de domínio; ou tem palavra
 * de endereço, contato, documento ou número por extenso (BLOQUEIO, r3).
 */
export function nomeComoDado(bruto: string | null | undefined): string | null {
  if (typeof bruto !== "string") return null;
  const nome = bruto.normalize("NFC").replace(ESPACOS, " ").trim();
  if (!nome || nome.length > NOME_MAX) return null;
  if (!SO_NOME.test(nome)) return null;
  if ((nome.match(/\p{L}/gu) ?? []).length < 2) return null;
  if (nome.split(" ").length > NOME_MAX_PALAVRAS) return null;
  if (ROTULOS.test(nome) || DOMINIO.test(nome) || temPalavraBloqueada(nome)) return null;
  return nome;
}

/** Marcas combinantes removidas na busca (U+0300–U+036F). */
export const FAIXA_MARCAS = "\\u0300-\\u036f";
const MARCAS = new RegExp(`[${FAIXA_MARCAS}]`, "gu");

/**
 * Forma de comparação, a mesma para o termo e para o nome (só em JavaScript, sem collation do banco): NFD, sem marcas U+0300–U+036F, minúsculas, espaços colapsados,
 * pontas aparadas. Vale para o termo e para o nome exibível.
 */
export function normalizarParaBusca(texto: string): string {
  return texto.normalize("NFD").replace(MARCAS, "").toLowerCase().replace(ESPACOS, " ").trim();
}
