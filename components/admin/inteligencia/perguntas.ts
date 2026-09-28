/**
 * Perguntas livres do drawer “Perguntar ao Kidmais”.
 *
 * O roteamento acontece no navegador e só aponta para capacidades já registradas no gateway.
 * O texto digitado nunca vai ao servidor: o gateway recebe apenas `{ capacidade }`, com schema estrito.
 * Sem correspondência, a resposta é “ainda não disponível” — nenhuma ferramenta é inventada.
 * Não é fronteira de segurança: política, tenant e registro fechado continuam no servidor.
 */

export type CapacidadeDisponivel = {
  capacidade: "atencao_hoje";
  pergunta: string;
  escopo: string;
};

export const CAPACIDADES_DISPONIVEIS: readonly CapacidadeDisponivel[] = Object.freeze([
  {
    capacidade: "atencao_hoje",
    pergunta: "O que precisa da minha atenção hoje?",
    escopo: "Pagamentos vencidos, que vencem hoje e valores a receber.",
  },
]);

export const LIMITE_PERGUNTA = 300;

export type Interpretacao =
  | { tipo: "capacidade"; capacidade: CapacidadeDisponivel["capacidade"] }
  | { tipo: "indisponivel" }
  | { tipo: "vazia" };

/** Gatilhos conservadores: só assuntos que a capacidade realmente responde. */
const GATILHOS: Readonly<Record<CapacidadeDisponivel["capacidade"], readonly RegExp[]>> = {
  atencao_hoje: [
    /\batenc/,
    /\bpendenc/,
    /\bvencid/,
    /\bvence(m)? hoje\b/,
    /\bem atraso\b/,
    /\bpagamentos? atrasad/,
    /\ba receber\b/,
    /\brecebive/,
    /\binadimpl/,
  ],
};

/**
 * Pedidos de ação (criar, enviar, registrar, cancelar…) nunca viram consulta: a V1 é somente leitura
 * e mutações futuras exigirão confirmação humana (CONFIRM). A resposta honesta é “ainda não disponível”.
 */
const PEDIDO_DE_ACAO = /\b(cri[ae]r?|envi[ae]r?|mand[ae]r?|registr[ae]r?|cancel[ae]r?|exclu[ai]r?|apag[ae]r?|alter[ae]r?|mud[ae]r?|ger[ae]r?|cobr[ae]r?|quit[ae]r?|delete|drop|update|insert)\b/;

const DIACRITICOS = /[̀-ͯ]/g;

export function normalizarPergunta(texto: string) {
  return texto.normalize("NFD").replace(DIACRITICOS, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function interpretarPergunta(texto: string): Interpretacao {
  const normalizada = normalizarPergunta(texto.slice(0, LIMITE_PERGUNTA));
  if (!normalizada) return { tipo: "vazia" };
  if (PEDIDO_DE_ACAO.test(normalizada)) return { tipo: "indisponivel" };
  for (const { capacidade } of CAPACIDADES_DISPONIVEIS) {
    if (GATILHOS[capacidade].some((gatilho) => gatilho.test(normalizada))) return { tipo: "capacidade", capacidade };
  }
  return { tipo: "indisponivel" };
}
