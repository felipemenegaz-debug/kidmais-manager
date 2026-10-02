/**
 * Validadores determinísticos da importação histórica. O modelo (ou o extrator por regras) só lê;
 * quem decide se um valor é representável é o código daqui.
 *
 * Nenhuma normalização silenciosa (H4): o texto inteiro é interpretado por uma gramática fechada. Sinal
 * negativo, casas decimais ambíguas, minutos ≥ 60, número dentro de texto maior ou mais de um número no
 * mesmo valor NUNCA viram um valor "parecido": devolvem falha com o estado correspondente.
 *
 * - INVALIDO: o texto é claro e o valor é inválido (CPF com dígito errado, valor negativo, 4h90).
 * - AMBIGUO: o texto admite mais de uma leitura (123.45, "30 a 40", dois valores).
 * - NAO_REPRESENTAVEL: o texto não cabe no tipo (30,5 convidados, "quatro horas", data sem ano).
 */
export type EstadoFalha = "INVALIDO" | "AMBIGUO" | "NAO_REPRESENTAVEL";
export type TipoCampo = "texto" | "cpf" | "telefone" | "email" | "data" | "horario" | "duracao" | "idade" | "convidados" | "quantidade" | "valor" | "parcela";
export type Validacao<T> = { ok: true; valor: T } | { ok: false; motivo: string; estado: EstadoFalha };

const ok = <T>(valor: T): Validacao<T> => ({ ok: true, valor });
const falha = <T>(motivo: string, estado: EstadoFalha = "INVALIDO"): Validacao<T> => ({ ok: false, motivo, estado });

export function soDigitos(texto: string) {
  return texto.replace(/\D/g, "");
}

const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "");

// ---------------------------------------------------------------- CPF

export function validarCpf(texto: string): Validacao<string> {
  const t = texto.trim();
  if (!/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(t)) return falha("CPF com formato inválido.", /\d/.test(t) ? "INVALIDO" : "NAO_REPRESENTAVEL");
  const d = soDigitos(t);
  if (/^(\d)\1{10}$/.test(d)) return falha("CPF com formato inválido.");
  const dv = (base: string, peso: number) => {
    const soma = [...base].reduce((total, n, i) => total + Number(n) * (peso - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  if (dv(d.slice(0, 9), 10) !== Number(d[9]) || dv(d.slice(0, 10), 11) !== Number(d[10])) return falha("CPF com dígito verificador inválido. Confira a leitura.");
  return ok(`${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`);
}

// ---------------------------------------------------------------- telefone / e-mail

export function validarTelefone(texto: string): Validacao<string> {
  const t = texto.trim();
  if (!/^(?:\+?55\s*)?\(?\d{2}\)?\s*\d{4,5}[\s-]?\d{4}$/.test(t)) return falha("Telefone deve ter DDD e 8 ou 9 dígitos.", /\d/.test(t) ? "INVALIDO" : "NAO_REPRESENTAVEL");
  let d = soDigitos(t);
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return falha("Telefone deve ter DDD e 8 ou 9 dígitos.");
  return ok(d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`);
}

export function validarEmail(texto: string): Validacao<string> {
  const e = texto.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(e) ? ok(e) : falha("E-mail com formato inválido.");
}

// ---------------------------------------------------------------- data

const MESES: Readonly<Record<string, number>> = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };

function dataIso(dia: number, mes: number, ano: number): Validacao<string> {
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (ano < 2000 || ano > 2100 || data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) return falha("Data inexistente ou fora do período esperado.");
  return ok(`${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`);
}

/** Data real (inclui 29/02 só em ano bissexto) entre 2000 e 2100. O texto inteiro é uma data. Devolve ISO. */
export function validarData(texto: string): Validacao<string> {
  const t = semAcento(texto).toLowerCase().trim().replace(/[.,;]$/, "");
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return dataIso(Number(iso[3]), Number(iso[2]), Number(iso[1]));
  const br = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (br) return dataIso(Number(br[1]), Number(br[2]), Number(br[3]));
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(t)) return falha("Ano com dois dígitos: informe o ano completo.", "AMBIGUO");
  const extenso = t.match(/^(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})$/);
  if (extenso && MESES[extenso[2]]) return dataIso(Number(extenso[1]), MESES[extenso[2]], Number(extenso[3]));
  return falha("Data não reconhecida.", "NAO_REPRESENTAVEL");
}

// ---------------------------------------------------------------- horário / duração

function hora(texto: string): string | null | "INVALIDA" {
  const m = texto.trim().match(/^(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*(?:h|hs|horas?)?$/i);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` : "INVALIDA";
}

/** "14:00 às 18:00", "das 14h às 18h30", "14h" (só início). */
export function validarHorario(texto: string): Validacao<{ inicio: string; fim: string | null }> {
  const formal = texto.trim().match(/^in[ií]cio\s+[aàá]s\s+(\d{1,2}:\d{2})\s+e\s+t[eé]rmino\s+[aàá]s\s+(\d{1,2}:\d{2})$/i);
  if (formal) return validarHorario(`${formal[1]} às ${formal[2]}`);
  const t = semAcento(texto).toLowerCase().trim().replace(/^das?\s+/, "");
  const partes = t.split(/\s*(?:\bas\b|\ba\b|\bate\b|-|–)\s*/).filter((p) => p.length);
  if (partes.length > 2) return falha("Horário com mais de um intervalo.", "AMBIGUO");
  const inicio = partes[0] ? hora(partes[0]) : null;
  const fim = partes[1] ? hora(partes[1]) : null;
  if (inicio === "INVALIDA" || fim === "INVALIDA") return falha("Horário inexistente.");
  if (!inicio) return falha("Horário não reconhecido.", "NAO_REPRESENTAVEL");
  if (partes[1] && !fim) return falha("Horário de término não reconhecido.", "NAO_REPRESENTAVEL");
  if (fim && fim <= inicio) return falha("O término é antes do início. Confira o horário.");
  return ok({ inicio, fim });
}

export function minutosEntre(inicio: string, fim: string) {
  const [hi, mi] = inicio.split(":").map(Number);
  const [hf, mf] = fim.split(":").map(Number);
  return hf * 60 + mf - (hi * 60 + mi);
}

/** "4 horas", "3h30", "3h 30min", "4 horas e meia", "4,5 horas", "90 minutos". Nada além disso. */
export function validarDuracao(texto: string): Validacao<number> {
  const t = semAcento(texto).toLowerCase().trim().replace(/[.;]$/, "");
  if (/-\s*\d/.test(t)) return falha("Duração negativa.");
  let minutos: number | null = null;
  const hm = t.match(/^(\d{1,2})\s*h(?:oras?|rs?)?\s*(?:e\s*)?(\d{1,2})\s*(?:min|minutos)?$/);
  const meia = t.match(/^(\d{1,2})\s*h(?:oras?|rs?)?\s*e\s*meia$/);
  const decimal = t.match(/^(\d{1,2})[.,](\d{1,2})\s*h(?:oras?|rs?)?$/);
  const h = t.match(/^(\d{1,2})\s*h(?:oras?|rs?)?$/);
  const m = t.match(/^(\d{1,4})\s*min(?:utos)?$/);
  if (hm) {
    if (Number(hm[2]) >= 60) return falha("Minutos da duração acima de 59.");
    minutos = Number(hm[1]) * 60 + Number(hm[2]);
  } else if (meia) minutos = Number(meia[1]) * 60 + 30;
  else if (decimal) {
    if (decimal[2] !== "5") return falha("Duração em fração de hora que não é meia hora.", "NAO_REPRESENTAVEL");
    minutos = Number(decimal[1]) * 60 + 30;
  } else if (h) minutos = Number(h[1]) * 60;
  else if (m) minutos = Number(m[1]);
  if (minutos === null) return falha("Duração não reconhecida.", "NAO_REPRESENTAVEL");
  if (minutos < 30 || minutos > 24 * 60) return falha("Duração fora do esperado para uma festa.");
  return ok(minutos);
}

// ---------------------------------------------------------------- dinheiro

const TOKEN_DINHEIRO = /(-\s*)?(?:r\$\s*)?(\d[\d.,]*\d|\d)/gi;

/**
 * Um valor monetário em reais, texto inteiro. Formatos aceitos: "R$ 8.900,00", "8900", "8.900", "8900,5",
 * "R$ 8.900,00 reais". Separador de milhar só com grupos de 3; vírgula só como decimal.
 */
export function lerDinheiro(token: string): Validacao<number> {
  const t = token.replace(/\s/g, "");
  if (/^-/.test(t)) return falha("Valor negativo.");
  const numero = t.replace(/^r\$/i, "");
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(numero) || /^\d+(?:,\d{1,2})?$/.test(numero)) {
    const [inteiro, frac = ""] = numero.split(",");
    const centavos = Number(inteiro.replace(/\./g, "")) * 100 + Number(frac.padEnd(2, "0") || "0");
    if (!Number.isSafeInteger(centavos) || centavos <= 0 || centavos > 100_000_000_00) return falha("Valor fora do esperado.");
    return ok(centavos);
  }
  // "123.45" (ponto decimal?), "1.2345", "8,900.00": mais de uma leitura possível.
  if (/^[\d.,]+$/.test(numero)) return falha("Separadores do valor admitem mais de uma leitura. Informe como R$ 1.234,56.", "AMBIGUO");
  return falha("Valor não reconhecido.", "NAO_REPRESENTAVEL");
}

export function tokensDinheiro(texto: string): string[] {
  return [...texto.matchAll(TOKEN_DINHEIRO)].map((m) => m[0]);
}

export function validarValor(texto: string): Validacao<number> {
  const t = semAcento(texto).toLowerCase().trim().replace(/\s*reais$/, "").replace(/[.;]$/, "");
  if (/^menos\b/.test(t) || /(?:^|[\s$(])-\s*(?:r\$\s*)?\d/.test(t) || /^-?\s*r\$\s*-/.test(t) || /^\(.*\d.*\)$/.test(t)) return falha("Valor negativo.");
  const tokens = tokensDinheiro(t);
  if (tokens.length === 0) return falha("Valor não reconhecido.", "NAO_REPRESENTAVEL");
  if (tokens.length > 1) return falha("Há mais de um valor no mesmo campo.", "AMBIGUO");
  // O token precisa ser o texto inteiro: "R$ 8.900,00 à vista" não é só um valor.
  if (t.replace(/\s/g, "") !== tokens[0].replace(/\s/g, "")) return falha("O campo tem texto além do valor.", "NAO_REPRESENTAVEL");
  return lerDinheiro(tokens[0]);
}

// ---------------------------------------------------------------- inteiros

/** Número inteiro, texto inteiro, com rótulo opcional ("80 convidados", "8 anos"). */
export function validarInteiro(texto: string, min: number, max: number, rotulo: string): Validacao<number> {
  const t = semAcento(texto).toLowerCase().trim().replace(/[.;]$/, "");
  if (/-\s*\d/.test(t) && !/^\d+\s*(?:a|-|ate)\s*\d+/.test(t)) return falha(`${rotulo} negativo.`);
  const numeros = t.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const [numero] = numeros;
  if (numero === undefined) return falha(`${rotulo} não reconhecido.`, "NAO_REPRESENTAVEL");
  if (numeros.length > 1) return falha(`${rotulo}: mais de um número no mesmo campo.`, "AMBIGUO");
  if (/[.,]/.test(numero)) return falha(`${rotulo} não é um número inteiro.`, "NAO_REPRESENTAVEL");
  // Só unidade conhecida depois do número: "30 mil", "30 k", "cerca de 30" nunca viram 30.
  if (!new RegExp(`^${numero}(?:\\s*(?:convidados?|pessoas?|criancas?|anos?|unidades?))?$`).test(t)) return falha(`${rotulo}: o campo tem texto além do número.`, "NAO_REPRESENTAVEL");
  const n = Number(numero);
  return Number.isSafeInteger(n) && n >= min && n <= max ? ok(n) : falha(`${rotulo} fora do esperado.`);
}

// ---------------------------------------------------------------- parcela

/** "R$ 5.000,00 em 10/11/2019": valor e vencimento válidos, os dois obrigatórios. */
export function validarParcela(texto: string): Validacao<{ valor: number; vencimento: string }> {
  const partes = texto.trim().split(/\s+(?:em|vencimento|venc\.?|com vencimento em)\s+/i);
  if (partes.length !== 2) return falha("Informe a parcela como \"R$ 1.000,00 em 10/11/2019\".", "NAO_REPRESENTAVEL");
  const valor = validarValor(partes[0]);
  if (!valor.ok) return valor;
  const vencimento = validarData(partes[1]);
  if (!vencimento.ok) return vencimento;
  return ok({ valor: valor.valor, vencimento: vencimento.valor });
}

// ---------------------------------------------------------------- consistência entre campos

/** Preço + adicionais = total, com tolerância de 1 centavo. */
export function somaConfere(preco: number, adicionais: number, total: number) {
  return Math.abs(preco + adicionais - total) <= 1;
}

/** Entrada + parcelas = total; vencimentos em ordem e não depois do evento. */
export function parcelasConferem(entrada: { valor: number; vencimento: string | null } | null, parcelas: Array<{ valor: number; vencimento: string | null }>, total: number, dataEvento: string | null): Validacao<true> {
  const soma = (entrada?.valor ?? 0) + parcelas.reduce((t, p) => t + p.valor, 0);
  if (Math.abs(soma - total) > parcelas.length + 1) return falha("A soma da entrada e das parcelas não bate com o total do contrato.");
  const datas = [entrada?.vencimento ?? null, ...parcelas.map((p) => p.vencimento)].filter((d): d is string => !!d);
  if (datas.some((d, i) => i > 0 && d < datas[i - 1])) return falha("Os vencimentos não estão em ordem.");
  if (dataEvento && datas.some((d) => d > dataEvento)) return falha("Há vencimento previsto depois da data da festa. Confira.");
  return ok(true);
}
