import { sha256Texto } from "./sha256.ts";

/**
 * Valores fixos nas cláusulas (plano modelo de contrato v3, 1.3): detecção determinística, sem IA, SÓ dentro das
 * cláusulas. Marca todas as ocorrências dos padrões (tracejado e lista "valores fixos restantes", que não bloqueia) e
 * SUGERE a troca só quando a frase fala da festa e não tem palavra de exclusão. A troca nunca é automática.
 */
export type ClausulaTela = { id: string; titulo: string | null; texto: string };
export type CampoDetectado = "festa.data" | "festa.horario" | "festa.convidados" | "valor.total";

export type ValorFixo = {
  campo: CampoDetectado;
  /** Campos que a troca insere (o horário troca o par início/fim numa ação só). */
  campos: string[];
  rotulo: string;
  idClausula: string;
  numero: number;
  tituloClausula: string | null;
  inicio: number;
  fim: number;
  trecho: string;
  antes: string;
  depois: string;
  sugerir: boolean;
  substituto: string;
  versaoTexto: string;
  versaoEstrutura: string;
};

export const versaoTexto = (texto: string) => sha256Texto(texto);
export const versaoEstrutura = (clausulas: readonly ClausulaTela[]) => sha256Texto(JSON.stringify(clausulas.map((c) => [c.id, c.titulo ?? null, c.texto])));

/** Minúsculas e sem acento, mesmo comprimento não é garantido: usado só para procurar palavras numa frase. */
const plano = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const tem = (frase: string, palavras: RegExp) => palavras.test(plano(frase));

/** Frase em volta de [inicio, fim): de um ".", ";", "!", "?" (seguido de espaço ou fim) ou quebra de linha até o próximo. */
function frase(texto: string, inicio: number, fim: number) {
  let a = inicio;
  while (a > 0) {
    const c = texto[a - 1];
    if (c === "\n" || c === ";" || c === "!" || c === "?" || (c === "." && /\s/.test(texto[a] ?? " "))) break;
    a--;
  }
  let b = fim;
  while (b < texto.length) {
    const c = texto[b];
    if (c === "\n" || c === ";" || c === "!" || c === "?" || (c === "." && /\s|$/.test(texto[b + 1] ?? ""))) break;
    b++;
  }
  return texto.slice(a, b);
}

function dataValida(d: number, m: number, a: number) {
  if (m < 1 || m > 12 || d < 1 || a < 1900 || a > 2200) return false;
  return d <= new Date(Date.UTC(a, m, 0)).getUTCDate();
}

type Regra = {
  campo: CampoDetectado;
  campos: string[];
  rotulo: string;
  padrao: RegExp;
  /** Devolve o trecho trocado dentro da ocorrência (deslocamento e tamanho) ou null se a ocorrência não vale. */
  trecho: (m: RegExpExecArray) => { desloc: number; tamanho: number } | null;
  substituto: string;
  contexto: RegExp;
  exclui: RegExp;
};

const REGRAS: Regra[] = [
  {
    campo: "festa.data", campos: ["festa.data"], rotulo: "Data da festa",
    padrao: /(?<![\d/])(\d{2})\/(\d{2})\/(\d{4})(?![\d/])/g,
    trecho: (m) => (dataValida(Number(m[1]), Number(m[2]), Number(m[3])) ? { desloc: 0, tamanho: m[0].length } : null),
    substituto: "{{festa.data}}",
    contexto: /\b(festas?|eventos?|aniversarios?|realizad[oa]s?)\b/,
    exclui: /\b(pagamentos?|vencimentos?|parcelas?|prazos?|assinaturas?)\b/,
  },
  {
    campo: "festa.horario", campos: ["festa.inicio", "festa.fim"], rotulo: "Horário de início e de término",
    padrao: /\bdas\s+(\d{1,2})\s*(?::|h)\s*(\d{2})?\s*(?:h(?:oras?)?\b)?\s*(?:à|a)s\s+(\d{1,2})\s*(?::|h)\s*(\d{2})?(?:\s*h(?:oras?)?\b)?/gi,
    trecho: (m) => {
      const ok = (h: string, mi?: string) => Number(h) <= 23 && Number(mi ?? "0") <= 59;
      return ok(m[1], m[2]) && ok(m[3], m[4]) ? { desloc: 0, tamanho: m[0].length } : null;
    },
    substituto: "das {{festa.inicio}} às {{festa.fim}}",
    contexto: /\b(festas?|eventos?)\b/,
    exclui: /\b(montagem|montagens|desmontagem|desmontagens|decoracao|decoracoes|entregas?)\b/,
  },
  {
    campo: "festa.convidados", campos: ["festa.convidados"], rotulo: "Convidados contratados",
    padrao: /(?<![\d.,])(\d{1,5})(\s+convidados)\b/gi,
    trecho: (m) => ({ desloc: 0, tamanho: m[1].length }),
    substituto: "{{festa.convidados}}",
    contexto: /\b(festas?|pacotes?|contrat\w*)\b/,
    exclui: /\b(adicional|adicionais|excedentes?|a mais|tolerancias?|extras?)\b/,
  },
  {
    campo: "valor.total", campos: ["valor.total"], rotulo: "Valor total do contrato",
    // "valor total" e o R$ na mesma frase: no máximo 30 caracteres entre os dois, sem ponto, ponto e vírgula ou quebra.
    padrao: /\bvalor\s+total\b([^.;\n]{0,30}?)(R\$\s*(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?)(?![\d.,]\d)/gi,
    trecho: (m) => ({ desloc: m[0].length - m[2].length, tamanho: m[2].length }),
    substituto: "{{valor.total}}",
    contexto: /\b(contratacao|contrato|festas?|pacotes?|eventos?|servicos?)\b/,
    exclui: /\b(multas?|caucao|caucoes|parcelas?|entradas?|adicional|adicionais|juros|taxas?|excedentes?|reajustes?)\b/,
  },
];

/** Todas as ocorrências nas cláusulas, em ordem (cláusula, posição). */
export function detectarValoresFixos(clausulas: readonly ClausulaTela[]): ValorFixo[] {
  const estrutura = versaoEstrutura(clausulas);
  const achados: ValorFixo[] = [];
  clausulas.forEach((cl, i) => {
    const vt = versaoTexto(cl.texto);
    for (const regra of REGRAS) {
      regra.padrao.lastIndex = 0;
      for (let m = regra.padrao.exec(cl.texto); m; m = regra.padrao.exec(cl.texto)) {
        const parte = regra.trecho(m);
        if (!parte) continue;
        const inicio = m.index + parte.desloc;
        const fim = inicio + parte.tamanho;
        const f = frase(cl.texto, m.index, m.index + m[0].length);
        achados.push({
          campo: regra.campo, campos: regra.campos, rotulo: regra.rotulo,
          idClausula: cl.id, numero: i + 1, tituloClausula: cl.titulo,
          inicio, fim, trecho: cl.texto.slice(inicio, fim),
          antes: cl.texto.slice(Math.max(0, inicio - 40), inicio), depois: cl.texto.slice(fim, fim + 40),
          sugerir: tem(f, regra.contexto) && !tem(f, regra.exclui),
          substituto: regra.substituto, versaoTexto: vt, versaoEstrutura: estrutura,
        });
      }
    }
  });
  return achados.sort((a, b) => a.numero - b.numero || a.inicio - b.inicio);
}
