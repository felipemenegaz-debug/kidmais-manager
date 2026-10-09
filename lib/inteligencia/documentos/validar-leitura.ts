import type { z } from "zod";

/**
 * Validação da saída do modelo na leitura de documentos (tabela de preços, modelo de contrato).
 *
 * O JSON Schema estrito enviado ao provedor não leva tamanhos (maxLength/maxItems), então um texto ou uma lista
 * acima do limite do schema do Core derrubava a leitura inteira. Aqui só isso é tolerado: o excesso é APARADO
 * no limite (nada é inventado nem reescrito) e a revisão humana vem depois. Qualquer outra divergência (campo
 * a mais, tipo errado, enum desconhecido, JSON cortado) continua recusada.
 *
 * Diagnóstico sem dado do documento: só a etapa, o tamanho da resposta e os caminhos/códigos dos problemas.
 */
export function validarLeitura<T>(schema: z.ZodType<T>, texto: string, rotulo: string): T {
  let valor: unknown;
  try {
    valor = JSON.parse(texto);
  } catch (erro) {
    console.warn(`[Kidmais IA] ${rotulo}: leitura fora do formato`, JSON.stringify({ etapa: "json", tamanho: texto.length }));
    throw erro;
  }
  const aparados: string[] = [];
  for (let rodada = 0; rodada < 8; rodada++) {
    const r = schema.safeParse(valor);
    if (r.success) {
      if (aparados.length) console.warn(`[Kidmais IA] ${rotulo}: leitura aparada ao limite`, JSON.stringify({ caminhos: aparados.slice(0, 20) }));
      return r.data;
    }
    const aparaveis = r.error.issues.filter((p) => p.code === "too_big" && (p.origin === "string" || p.origin === "array") && p.path.length > 0);
    if (!aparaveis.length) {
      const problemas = r.error.issues.slice(0, 10).map((p) => ({ codigo: p.code, caminho: p.path.join(".") }));
      console.warn(`[Kidmais IA] ${rotulo}: leitura fora do formato`, JSON.stringify({ etapa: "schema", tamanho: texto.length, problemas }));
      throw r.error;
    }
    for (const p of aparaveis) {
      const limite = Number((p as { maximum?: number | bigint }).maximum);
      const pai = p.path.slice(0, -1).reduce<unknown>((no, chave) => (no as Record<PropertyKey, unknown> | null)?.[chave as PropertyKey], valor) as Record<PropertyKey, unknown> | null;
      const chave = p.path[p.path.length - 1] as PropertyKey;
      const atual = pai?.[chave];
      if (!Number.isFinite(limite) || !pai) continue;
      if (typeof atual === "string" || Array.isArray(atual)) {
        pai[chave] = atual.slice(0, limite);
        aparados.push(p.path.join("."));
      }
    }
  }
  console.warn(`[Kidmais IA] ${rotulo}: leitura fora do formato`, JSON.stringify({ etapa: "aparar", tamanho: texto.length }));
  throw new Error("leitura fora do formato");
}
