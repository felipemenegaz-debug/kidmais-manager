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
export type ObjetoCriacao = "FESTA" | "PACOTE" | "CONTA_PAGAR";

export const CAPACIDADE_DO_OBJETO: Readonly<Record<ObjetoCriacao, string>> = { FESTA: "preparar_contratacao", PACOTE: "criar_pacote", CONTA_PAGAR: "criar_conta_pagar" };

const VERBO_CRIAR = /\b(crie|criar|cria|crio|cadastr(?:e|ar|a)|mont(?:e|ar)|agend(?:e|ar|a)|marc(?:ar|que)|fech(?:ar|e)|faz(?:er)?|faca|contrat(?:ar|e)|nov[oa]|prepar\w* (?:a |uma )?contratacao)\b/;
// "Fechar um contrato" / "fazer um contrato novo" é a contratação de uma festa (o contrato nasce do fechamento).
const FESTA = /\b(festa|aniversario|contratacao|fechamento|contratos?)\b/;
const VERBO_CRIAR_TODOS = new RegExp(VERBO_CRIAR.source, "g");

/**
 * Escopo da negação (parecer do Astra, 23/10, rodadas 1–4). Uma negação ("não", "nunca", "jamais", "nem") alcança
 * tudo o que vem depois dela até um RECOMEÇO AFIRMATIVO REAL: uma pausa (pontuação ou "mas/porém/então/e sim")
 * seguida de um pedido novo ("quero", "vamos", "pode", "preciso", "feche", "crie"…). Só a pausa não basta: vírgula de
 * inciso ("não quero, por enquanto, fechar"), "então" intercalado ("não quero, então, fechar") e coordenação
 * ("criar um pacote ou fechar um contrato") continuam negados. "Não, quero fechar…" e "Não. Quero…" recomeçam.
 * Analisado no texto original, sem limite de palavras. Na dúvida fica negado: o pedido segue as outras regras e nunca
 * vira criação (o Human Gate continua valendo de qualquer forma).
 */
const NEGACAO = /\b(nao|nunca|jamais|nem)\b/g;
const PAUSA = String.raw`(?:[,.;:!?]|\b(?:mas|porem|entao|e sim)\b)[\s,]*(?:(?:mas|porem|entao|e sim|sim|eu|agora|so)[\s,]+)*`;
const PEDIDO = "quero|queria|vamos|preciso|precisamos|pode|podemos|gostaria|faca|feche|crie|prepare|agende|marque|monte";
const RECOMECO = new RegExp(`${PAUSA}(?:${PEDIDO})\\b`);
/** Na correção de objetivo, "é"/"sim" depois da pausa também afirmam o alvo ("não é pacote, é uma festa"). */
const RECOMECO_CORRECAO = new RegExp(`${PAUSA}(?:e|eh|seria|sim|${PEDIDO})\\b`);

/** O trecho [inicio, fim) de `n` está no escopo de alguma negação anterior sem recomeço afirmativo até ele. */
export function noEscopoDeNegacao(n: string, inicio: number, fim: number, recomeco: RegExp = RECOMECO): boolean {
  for (const negacao of n.slice(0, inicio).matchAll(NEGACAO)) {
    if (!recomeco.test(n.slice((negacao.index ?? 0) + negacao[0].length, fim))) return true;
  }
  return false;
}
const verboNegado = (n: string, m: RegExpMatchArray) => noEscopoDeNegacao(n, m.index ?? 0, (m.index ?? 0) + m[0].length);

/** Contrato JÁ existente ("fechar o contrato", "este contrato"): não é uma contratação nova. */
const CONTRATO_EXISTENTE = /\b(o|os|este|esse|estes|esses|deste|desse|neste|nesse|do|no|seu|meu)\s+contratos?\b/;
const PACOTE = /\bpacotes?\b/;
export function pedeContaPagar(texto: string): boolean {
  const n = normalizar(texto);
  return /\b(?:adicion\w*|inclu\w*|crie|criar|cria|cadastre|cadastrar|nova)\b/.test(n)
    && /\bconta a pagar\b/.test(n) && !ehPergunta(texto)
    && !/\bnao\s+(?:quero\s+)?(?:adicion\w*|inclu\w*|cri\w*|cadastr\w*)\b/.test(n);
}
/** "não (é) (um/o) pacote", "não festa": o objeto negado é retirado antes de procurar o principal. */
const NEGADO = /\b(?:e )?nao (?:e |eh |seria |quero |quero criar |criar )?(?:um |uma |o |a )?(pacotes?|festas?)\b/g;

/** Objeto da criação: o primeiro (festa ou pacote) depois do verbo de criar, ignorando o que foi negado. */
export function objetoDeCriacao(texto: string): ObjetoCriacao | null {
  // Pergunta ("quem vai montar a festa?", "como crio um pacote?") nunca é pedido de criação.
  if (ehPergunta(texto)) return null;
  if (pedeContaPagar(texto)) return "CONTA_PAGAR";
  const n = normalizar(texto);
  // O primeiro verbo de criar que NÃO está no escopo de uma negação (decidido no texto original).
  const verbo = [...n.matchAll(VERBO_CRIAR_TODOS)].find((m) => !verboNegado(n, m));
  if (!verbo || verbo.index === undefined) return null;
  if (/contratacao$/.test(verbo[0])) return "FESTA";
  // O OBJETO do verbo é o primeiro substantivo depois dele (artigos e "nova/novo" à parte), sem os objetos negados
  // ("…uma festa e não um pacote"): "crie uma TAREFA nesta festa" cria tarefa; "crie uma festa … pacote premium" cria festa.
  const depois = n.slice(verbo.index + verbo[0].length).replace(NEGADO, " ");
  const palavras = depois.replace(/[^a-z0-9 ]/g, " ").split(" ").filter(Boolean);
  const objeto = palavras.find((p) => !/^(um|uma|o|a|os|as|nov[oa]s?|outr[oa]|mais|de|da|do|essa|esse|esta|este|minha|meu)$/.test(p));
  if (!objeto) return null;
  if (/^contratos?$/.test(objeto) && CONTRATO_EXISTENTE.test(n.slice(verbo.index))) return null;
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
  // O ALVO da correção precisa estar afirmado (parecer do Astra, rodada 4): em "não quero criar uma festa e não um
  // pacote" os dois estão negados — nada muda.
  const afirmado = (alvo: RegExp) => {
    const m = alvo.exec(n);
    return m !== null && !noEscopoDeNegacao(n, m.index, m.index + m[0].length, RECOMECO_CORRECAO);
  };
  if ((/\b(festa|contratacao)\b.{0,25}\bnao\b.{0,15}\bpacotes?\b/.test(n) || /\bnao\b.{0,15}\bpacotes?\b.{0,30}\bfesta\b/.test(n)) && afirmado(/\b(festa|contratacao)\b/)) return "FESTA";
  if ((/\bpacotes?\b.{0,25}\bnao\b.{0,15}\bfestas?\b/.test(n) || /\bnao\b.{0,15}\bfestas?\b.{0,30}\bpacote\b/.test(n)) && afirmado(/\bpacotes?\b/)) return "PACOTE";
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
  // Criação ambígua no meio de um rascunho: o esclarecimento responde, o rascunho fica intocado.
  if (regras.tipo === "esclarecer") return { tipo: "NOVA_CONSULTA" };
  const pergunta = ehPergunta(texto);
  if (s.respondeCampo && !pergunta) return { tipo: "RESPOSTA_CAMPO" };
  if (pergunta) return s.respondeCampo && regras.tipo === "nenhuma" ? { tipo: "AMBIGUO" } : { tipo: "NOVA_CONSULTA" };
  if (s.trazDados) return { tipo: "CORRECAO" };
  // Comando reconhecido pelas regras (leitura, navegação, outra ação): não é resposta ao campo.
  if (regras.tipo !== "nenhuma") return { tipo: "NOVA_CONSULTA" };
  // Nada reconhecível: segue como resposta (o rascunho pergunta de novo, sem inventar).
  return { tipo: "RESPOSTA_CAMPO" };
}
