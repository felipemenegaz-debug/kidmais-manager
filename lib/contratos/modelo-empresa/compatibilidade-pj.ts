import type { ConteudoModelo } from "./conteudo.ts";

/**
 * Modelo da empresa × contratante PJ (Entrega B, 112; plano R2-2 e R21-2). Um modelo publicado que qualifica o
 * contratante como pessoa física não pode gerar contrato de PJ: o servidor recusa com MODELO_INCOMPATIVEL_PJ e o editor
 * lista cada trecho para revisão humana. O sistema nunca reescreve o modelo: a conversão é só sugerida.
 */
export const MENSAGEM_MODELO_INCOMPATIVEL_PJ =
  "O modelo de contrato da empresa qualifica o contratante como pessoa física (CPF). Para cliente pessoa jurídica, publique em Configurações uma nova versão do modelo usando {{contratante.tipo_documento}} {{contratante.documento}} no lugar do CPF.";

export type TrechoIncompativelPj = { local: string; trecho: string; motivo: string };

/** "CPF {{contratante.cpf}}" e variações ("CPF nº", "CPF:", "inscrito no CPF sob o nº", "portador do CPF"). */
const QUALIFICACAO_CPF = /(?:(?:portador[ao]?|inscrit[oa])\s+(?:do|no)\s+)?CPF(?:\s+sob\s+o)?(?:\s*(?:n\.?\s*[º°o]\.?))?\s*:?\s*\{\{\s*contratante\.cpf\s*\}\}/gi;
const MARCA_CPF = /\{\{\s*contratante\.cpf\s*\}\}/i;
const MARCA_CONTRATANTE = /\{\{\s*contratante\./i;
/** Literais de qualificação próprios de PF; só contam no mesmo texto que um campo do contratante. */
const LITERAIS_PF: ReadonlyArray<[RegExp, string]> = [
  [/portador[ao]?\s+do\s+CPF/i, "“portador do CPF” é qualificação de pessoa física"],
  [/inscrit[oa]\s+no\s+CPF/i, "“inscrito no CPF” é qualificação de pessoa física"],
  [/brasileir[oa](?:\s*\(a\))?/i, "nacionalidade é qualificação de pessoa física"],
  [/estado\s+civil/i, "estado civil é qualificação de pessoa física"],
  [/RG\s*(?:n\.?\s*[º°o]\.?)?\s*:?\s*\{\{\s*contratante\.rg\s*\}\}/i, "RG não se aplica a pessoa jurídica"],
];

function textosComLocal(c: ConteudoModelo): Array<[string, string]> {
  return [
    ["Título", c.titulo],
    ...c.preambulo.map((t, i): [string, string] => [`Preâmbulo ${i + 1}`, t]),
    ...c.clausulas.flatMap((x, i): Array<[string, string]> => [[`Cláusula ${i + 1} (título)`, x.titulo ?? ""], [`Cláusula ${i + 1}`, x.texto]]),
    ...c.observacoes.map((t, i): [string, string] => [`Observação ${i + 1}`, t]),
  ];
}

function recorte(texto: string, inicio: number, fim: number) {
  const a = Math.max(0, inicio - 30), b = Math.min(texto.length, fim + 30);
  return `${a > 0 ? "…" : ""}${texto.slice(a, b)}${b < texto.length ? "…" : ""}`;
}

/** Trechos que impedem gerar contrato de PJ com este modelo (vazio = compatível). Determinístico. */
export function trechosIncompativeisPj(c: ConteudoModelo): TrechoIncompativelPj[] {
  const achados: TrechoIncompativelPj[] = [];
  for (const [local, texto] of textosComLocal(c)) {
    if (!texto) continue;
    const cpf = MARCA_CPF.exec(texto);
    if (cpf) achados.push({ local, trecho: recorte(texto, cpf.index, cpf.index + cpf[0].length), motivo: "usa {{contratante.cpf}}" });
    if (!MARCA_CONTRATANTE.test(texto)) continue;
    for (const [padrao, motivo] of LITERAIS_PF) {
      const m = padrao.exec(texto);
      if (m) achados.push({ local, trecho: recorte(texto, m.index, m.index + m[0].length), motivo });
    }
  }
  return achados;
}

export function modeloCompativelComPj(c: ConteudoModelo) {
  return trechosIncompativeisPj(c).length === 0;
}

/**
 * Conversão SUGERIDA (o usuário revisa e publica): troca a expressão inteira de qualificação por
 * `{{contratante.tipo_documento}} {{contratante.documento}}` — para PF o texto gerado continua "CPF <cpf>"; para PJ vira
 * "CNPJ <cnpj>", nunca "CPF <cnpj>". Um {{contratante.cpf}} solto vira {{contratante.documento}}. Literais de PF fora do
 * marcador (estado civil, nacionalidade, RG) ficam para revisão humana.
 */
export function sugerirConversaoPj(texto: string) {
  return texto
    .replace(QUALIFICACAO_CPF, () => "{{contratante.tipo_documento}} {{contratante.documento}}")
    .replace(/\{\{\s*contratante\.cpf\s*\}\}/gi, () => "{{contratante.documento}}");
}

export function sugerirConversaoConteudoPj(c: ConteudoModelo): ConteudoModelo {
  return {
    ...c,
    titulo: sugerirConversaoPj(c.titulo),
    preambulo: c.preambulo.map(sugerirConversaoPj),
    clausulas: c.clausulas.map((x) => ({ titulo: x.titulo == null ? x.titulo : sugerirConversaoPj(x.titulo), texto: sugerirConversaoPj(x.texto) })),
    observacoes: c.observacoes.map(sugerirConversaoPj),
  };
}

