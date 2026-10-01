import type { SituacaoRascunho } from "../extensoes.ts";
import type { Intencao } from "../intencao.ts";
import { normalizar } from "../texto-pt.ts";

/**
 * IA operacional (marco A): objeto PRINCIPAL do pedido e coordenação de mensagens durante um rascunho.
 *
 * O objeto principal governa a intenção: "crie uma festa do Felipe, pacote premium…" prepara a contratação de uma
 * festa (o pacote é um atributo); "crie um pacote chamado Premium" continua sendo criação de pacote. Objeto negado
 * ("…e não um pacote") nunca vira alvo. Nada aqui autoriza: Policy, Tenant Context e Human Gate seguem decidindo.
 */
export type ObjetoCriacao = "FESTA" | "PACOTE";

export const CAPACIDADE_DO_OBJETO: Readonly<Record<ObjetoCriacao, string>> = { FESTA: "preparar_contratacao", PACOTE: "criar_pacote" };

const VERBO_CRIAR = /\b(crie|criar|cria|crio|cadastr(?:e|ar|a)|mont(?:e|ar)|agend(?:e|ar|a)|marc(?:ar|que)|fech(?:ar|e)|nov[oa]|prepar\w* (?:a |uma )?contratacao)\b/;
const FESTA = /\b(festa|aniversario|contratacao|fechamento)\b/;
const PACOTE = /\bpacotes?\b/;
/** "não (é) (um/o) pacote", "não festa": o objeto negado é retirado antes de procurar o principal. */
const NEGADO = /\b(?:e )?nao (?:e |eh |seria |quero |quero criar |criar )?(?:um |uma |o |a )?(pacotes?|festas?)\b/g;

/** Objeto da criação: o primeiro (festa ou pacote) depois do verbo de criar, ignorando o que foi negado. */
export function objetoDeCriacao(texto: string): ObjetoCriacao | null {
  // Pergunta ("quem vai montar a festa?", "como crio um pacote?") nunca é pedido de criação.
  if (ehPergunta(texto)) return null;
  const n = normalizar(texto).replace(NEGADO, " ");
  const verbo = VERBO_CRIAR.exec(n);
  if (!verbo) return null;
  if (/contratacao$/.test(verbo[0])) return "FESTA";
  // O OBJETO do verbo é o primeiro substantivo depois dele (artigos e "nova/novo" à parte): "crie uma TAREFA nesta
  // festa" cria tarefa, não festa; "crie uma festa … pacote premium" cria festa (o pacote vem depois, como atributo).
  const palavras = n.slice(verbo.index + verbo[0].length).replace(/[^a-z0-9 ]/g, " ").split(" ").filter(Boolean);
  const objeto = palavras.find((p) => !/^(um|uma|o|a|os|as|nov[oa]s?|outr[oa]|mais|de|da|do|essa|esse|esta|este|minha|meu)$/.test(p));
  if (!objeto) return null;
  if (FESTA.test(objeto)) return "FESTA";
  if (PACOTE.test(objeto)) return "PACOTE";
  return null;
}

/**
 * Correção explícita do objetivo ("quero criar uma festa e não um pacote", "não é pacote, é festa", "festa, não
 * pacote"). Só com os DOIS objetos e uma negação de um deles; senão null (nunca troca por palpite).
 */
export function correcaoDeObjetivo(texto: string): ObjetoCriacao | null {
  const n = normalizar(texto);
  if (!FESTA.test(n) || !PACOTE.test(n) || !/\bnao\b/.test(n)) return null;
  if (/\b(festa|contratacao)\b.{0,25}\bnao\b.{0,15}\bpacotes?\b/.test(n) || /\bnao\b.{0,15}\bpacotes?\b.{0,30}\bfesta\b/.test(n)) return "FESTA";
  if (/\bpacotes?\b.{0,25}\bnao\b.{0,15}\bfestas?\b/.test(n) || /\bnao\b.{0,15}\bfestas?\b.{0,30}\bpacote\b/.test(n)) return "PACOTE";
  return null;
}

const PERGUNTA = /^(qual|quais|quanto|quantos|quantas|quem|quando|onde|como|o que|que|existe|existem|tem|temos|ha|me (diz|diga|mostra|mostre)|mostre|liste|veja|consulte)\b/;
const CANCELAR = /^(?:cancel(?:a|e|ar)(?: (?:o|esse|este) rascunho| isso| tudo| a preparacao)?|desist\w*(?: disso)?|esquece(?: isso)?|deixa (?:pra|para) la|nao quero mais(?: isso)?)[.! ]*$/;
const RETOMAR = /^(?:retom\w*|continu\w*|voltar|vamos voltar|seguir|seguir com)(?: (?:o|ao|com o|com a|a) (?:rascunho|pacote|cadastro|pedido|contratacao|festa|preparacao))?[.! ]*$/;

export function ehPergunta(texto: string) {
  const n = normalizar(texto);
  return PERGUNTA.test(n) || /\?\s*$/.test(texto.trim());
}

export type DecisaoRascunho =
  | { tipo: "RESPOSTA_CAMPO" }
  | { tipo: "CORRECAO" }
  | { tipo: "MUDANCA_OBJETIVO"; capacidade: string }
  | { tipo: "NOVA_CONSULTA" }
  | { tipo: "CANCELAR" }
  | { tipo: "RETOMAR" }
  | { tipo: "AMBIGUO" }
  /** Rascunho expirado ou encerrado: a mensagem segue como pedido novo. */
  | { tipo: "ENCERRADO" };

/**
 * Coordenador: o que esta mensagem é para o rascunho aberto. Decisão do SERVIDOR (o `operacaoId` da UI é só a dica de
 * qual rascunho está na tela; propriedade, empresa, usuário, estado e prazo já foram revalidados em `situacao`).
 * `regras` é a interpretação determinística da mensagem; `consulta` marca pergunta operacional (ou continuação dela).
 */
export function coordenarRascunho(texto: string, s: SituacaoRascunho, regras: Intencao, consulta: boolean): DecisaoRascunho {
  if (!s.aberto) return { tipo: "ENCERRADO" };
  const n = normalizar(texto);
  if (CANCELAR.test(n)) return { tipo: "CANCELAR" };
  if (RETOMAR.test(n)) return { tipo: "RETOMAR" };
  const corrigido = correcaoDeObjetivo(texto);
  if (corrigido) return CAPACIDADE_DO_OBJETO[corrigido] === s.capacidade ? { tipo: "CORRECAO" } : { tipo: "MUDANCA_OBJETIVO", capacidade: CAPACIDADE_DO_OBJETO[corrigido] };
  // Outro pedido de criação explícito (verbo + objeto): troca de objetivo; o mesmo objetivo é correção dos dados.
  if (regras.tipo === "acao" && objetoDeCriacao(texto)) return regras.capacidade === s.capacidade ? { tipo: "CORRECAO" } : { tipo: "MUDANCA_OBJETIVO", capacidade: regras.capacidade };
  if (consulta) return { tipo: "NOVA_CONSULTA" };
  const pergunta = ehPergunta(texto);
  if (s.respondeCampo && !pergunta) return { tipo: "RESPOSTA_CAMPO" };
  if (pergunta) return s.respondeCampo && regras.tipo === "nenhuma" ? { tipo: "AMBIGUO" } : { tipo: "NOVA_CONSULTA" };
  if (s.trazDados) return { tipo: "CORRECAO" };
  // Comando reconhecido pelas regras (leitura, navegação, outra ação): não é resposta ao campo.
  if (regras.tipo !== "nenhuma") return { tipo: "NOVA_CONSULTA" };
  // Nada reconhecível: segue como resposta (o rascunho pergunta de novo, sem inventar).
  return { tipo: "RESPOSTA_CAMPO" };
}
