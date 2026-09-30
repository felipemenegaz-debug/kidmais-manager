import type { AcaoObjetivo, AIResponse, EstadoEntendimento, ObjetivoIA, RecursoObjetivo } from "./contratos.ts";
import { normalizar } from "./texto-pt.ts";

/**
 * Estados de entendimento (AI V1.1, PR 2): o que realmente aconteceu com o pedido, para a resposta e para o trace.
 *
 *   EXECUTADO                 entendeu e respondeu/executou a leitura
 *   PRECISA_CONFIRMACAO       entendeu; a mutação espera o clique do Human Gate
 *   PRECISA_DADO              entendeu; falta um dado (rascunho pergunta, ou a entidade não está na tela)
 *   CAPACIDADE_INDISPONIVEL   entendeu, mas o assistente ainda não faz isso
 *   NEGADO_POLITICA           entendeu, e a Policy/Tenant Context recusou (ou é proibido)
 *   AMBIGUO                   entendeu a ação, mas não sobre o quê
 *   NAO_ENTENDIDO             não entendeu
 *
 * O objetivo (ação × recurso) é extraído de forma DETERMINÍSTICA, de listas fechadas. Ele só descreve o pedido:
 * nunca escolhe ferramenta, nunca autoriza nada e nunca vai ao modelo. Policy, Tool Registry e Human Gate seguem
 * sendo as únicas autoridades.
 */
export const ESTADOS_ENTENDIMENTO = [
  "EXECUTADO", "PRECISA_CONFIRMACAO", "PRECISA_DADO", "CAPACIDADE_INDISPONIVEL", "NEGADO_POLITICA", "AMBIGUO", "NAO_ENTENDIDO",
] as const satisfies readonly EstadoEntendimento[];

type Acao = AcaoObjetivo;
type Recurso = RecursoObjetivo;

/** Verbos de comando (mais específicos primeiro). "cadastro" (substantivo) não é verbo. */
const ACOES: ReadonlyArray<[Acao, RegExp]> = [
  ["LOCALIZAR", /^onde\b/],
  ["EXCLUIR", /\b(exclu\w*|apag(ue|ar|a)|delet\w*|remov(a|er|e))\b/],
  ["CANCELAR", /\bcancel(e|ar|a|em)\b/],
  ["ENVIAR", /\b(envi(e|ar|a|em)|mand(e|ar|a|em)|dispar(e|ar|a))\b/],
  ["REGISTRAR", /\b(registr(e|ar|a|em)|lanc(e|ar|a)|baix(e|ar|a)|quit(e|ar|a))\b/],
  ["CRIAR", /\b(crie|criar|cria|cadastr(e|ar|a|em|ando)|adicion(e|ar|a|em)|inclu(a|ir|i)|nov[oa])\b/],
  ["EDITAR", /\b(alter(e|ar|a|em)|mud(e|ar|a|em)|edit(e|ar|a)|renomei?(e|ar|a)|troqu?(e|ar|a)|atualiz(e|ar|a)|ajust(e|ar|a)|desativ(e|ar|a)|ativ(e|ar|a)|reativ(e|ar|a))\b/],
  ["ABRIR", /\b(abr(a|ir|e)|v(a|ai) para|leve-?me|me leve|mostre a tela)\b/],
  ["CONSULTAR", /\b(resum\w*|mostr(e|a)|list(e|a)|consult\w*|quais|qual|quanto|quantos|quantas|quando|quem|como (esta|anda|foi))\b/],
];

/** Recursos (o alvo é o primeiro citado no texto). */
const RECURSOS: ReadonlyArray<[Recurso, RegExp]> = [
  ["MENSAGEM", /\b(whats\s?app|mensage\w*|e-?mail)\b/],
  ["CATEGORIA", /\bcategorias?\b/],
  ["ITEM", /\bite(m|ns)\b/],
  ["PACOTE", /\bpacotes?\b/],
  ["CONTRATO", /\bcontratos?\b/],
  ["PAGAMENTO", /\b(pagamentos?|parcelas?|recebimentos?|boletos?)\b/],
  ["FINANCEIRO", /\b(financeiro|contas? a (receber|pagar)|recebive\w*)\b/],
  ["AGENDA", /\b(agenda|disponibilidade)\b/],
  ["FESTA", /\bfestas?\b/],
  ["CLIENTE", /\b(clientes?|cadastro dele|cadastro dela)\b/],
  ["DASHBOARD", /\b(dashboard|painel)\b/],
  ["CONFIGURACAO", /\b(configurac\w*|usuarios?|acessos?)\b/],
];

/** Capacidade registrada → objetivo (autoritativo quando a rota é conhecida). */
const POR_CAPACIDADE: Readonly<Record<string, ObjetivoIA>> = {
  atencao_hoje: "CONSULTAR:DASHBOARD",
  analisar_recebiveis: "CONSULTAR:FINANCEIRO",
  analisar_pagamentos: "CONSULTAR:FINANCEIRO",
  contratos_pendentes: "CONSULTAR:CONTRATO",
  agenda_do_dia: "CONSULTAR:AGENDA",
  resumir_cliente: "CONSULTAR:CLIENTE",
  resumir_contrato: "CONSULTAR:CONTRATO",
  comparar_versoes_contrato: "CONSULTAR:CONTRATO",
  resumir_festa: "CONSULTAR:FESTA",
  pendencias_da_festa: "CONSULTAR:FESTA",
  festa_em_risco: "CONSULTAR:FESTA",
  pacotes_disponiveis: "CONSULTAR:PACOTE",
  criar_pacote: "CRIAR:PACOTE",
  editar_pacote: "EDITAR:PACOTE",
  ativar_pacote: "EDITAR:PACOTE",
  desativar_pacote: "EDITAR:PACOTE",
  criar_categoria_buffet: "CRIAR:CATEGORIA",
  editar_categoria_buffet: "EDITAR:CATEGORIA",
  criar_item_buffet: "CRIAR:ITEM",
  editar_item_buffet: "EDITAR:ITEM",
};

export function objetivoDaCapacidade(capacidade: string | null | undefined): ObjetivoIA | null {
  return capacidade && Object.hasOwn(POR_CAPACIDADE, capacidade) ? POR_CAPACIDADE[capacidade] : null;
}

export type ObjetivoTexto = { acao: Acao | null; recurso: Recurso | null; nome: string | null; qualificado: boolean };

const NOME_PROIBIDO = /\d{3}\D?\d{3}|\d{5,}|@|https?:|www\.|[<>{}]/i;

/** Nome citado depois de "item"/"categoria" ("crie o item mini-pizza de chocolate" ⇒ "Mini-pizza de chocolate"). */
function nomeCitado(texto: string, recurso: Recurso | null): string | null {
  if (recurso !== "ITEM" && recurso !== "CATEGORIA") return null;
  const palavra = recurso === "ITEM" ? "item" : "categoria";
  // "…categoria do buffet chamada Doces" ⇒ "Doces": o qualificador do catálogo não faz parte do nome.
  const m = new RegExp(`\\b${palavra}\\s+(?:(?:do|de|no)\\s+(?:buffet|card[aá]pio)\\s+)?(?:chamad[oa]\\s+|de nome\\s+)?["'“]?([^"'”?!.;:,]{2,80})`, "iu").exec(texto);
  // Documento, contato, link ou marcação em QUALQUER ponto depois da palavra ⇒ não ecoa nada (nem um pedaço).
  if (!m || NOME_PROIBIDO.test(texto.slice(m.index))) return null;
  const nome = m[1].split(/\s+(?:na|no|da|do|para|em)\s+(?:categoria|pacote|festa)\b/i)[0].replace(/[^\p{L}\p{N} '\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (nome.length < 2 || NOME_PROIBIDO.test(nome)) return null;
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

/** Objetivo descrito no texto. Não usa modelo e não lê dados. */
export function objetivoDoTexto(texto: string): ObjetivoTexto {
  const n = normalizar(texto);
  const acao = ACOES.find(([, r]) => r.test(n))?.[0] ?? null;
  // O primeiro recurso CITADO é o alvo ("cadastre o item X na categoria Doces" ⇒ ITEM; "o contrato da festa" ⇒ CONTRATO).
  const achado = RECURSOS.map(([recurso, r]) => ({ recurso, m: r.exec(n) })).filter((x) => x.m).sort((a, b) => a.m!.index - b.m!.index)[0];
  const recurso = achado?.recurso ?? null;
  // "abra o contrato" (sem qualificador) é ambíguo; "abra o contrato da próxima festa" e "qual é a próxima festa?"
  // dizem qual (a resolução da referência é que ainda não existe).
  const depois = achado?.m ? n.slice(achado.m.index + achado.m[0].length).replace(/[?!.\s]+$/g, "").trim() : "";
  const relativo = /\b(proxim\w*|ultim\w*|anterior|hoje|amanha|ontem|sabado|domingo|segunda|terca|quarta|quinta|sexta|semana|mes|ano)\b/.test(n);
  return { acao, recurso, nome: nomeCitado(texto, recurso), qualificado: depois.length > 0 || relativo };
}

export function objetivoDe(o: ObjetivoTexto): ObjetivoIA | null {
  return o.acao && o.recurso ? (`${o.acao}:${o.recurso}` as ObjetivoIA) : null;
}

// ---------------------------------------------------------------- linguagem

/** Nome da entidade com o artigo certo (nunca "a contrato"). */
export const ENTIDADE_COM_ARTIGO = { festa: "a festa", cliente: "o cliente", contrato: "o contrato" } as const;
const NOME_ENTIDADE = { festa: "festa", cliente: "cliente", contrato: "contrato" } as const;

export function mensagemPrecisaContexto(entidade: keyof typeof ENTIDADE_COM_ARTIGO): string {
  const artigo = ENTIDADE_COM_ARTIGO[entidade];
  return `Abra ${artigo} e pergunte por ali: assim eu sei de qual ${NOME_ENTIDADE[entidade]} você está falando.`;
}

const VERBO: Readonly<Record<Acao, string>> = {
  CONSULTAR: "consultar", LOCALIZAR: "encontrar", ABRIR: "abrir", CRIAR: "criar", EDITAR: "alterar",
  EXCLUIR: "excluir", ENVIAR: "enviar", REGISTRAR: "registrar", CANCELAR: "cancelar",
};
/** [definido, indefinido, plural] */
const SINTAGMA: Readonly<Record<Recurso, readonly [string, string, string]>> = {
  DASHBOARD: ["o painel", "o painel", "o painel"],
  FESTA: ["a festa", "uma festa", "festas"],
  CLIENTE: ["o cliente", "um cliente", "clientes"],
  CONTRATO: ["o contrato", "um contrato", "contratos"],
  PAGAMENTO: ["o pagamento", "um pagamento", "pagamentos"],
  FINANCEIRO: ["o financeiro", "o financeiro", "o financeiro"],
  AGENDA: ["a agenda", "a agenda", "a agenda"],
  CATEGORIA: ["a categoria", "uma categoria", "categorias"],
  ITEM: ["o item", "um item", "itens"],
  PACOTE: ["o pacote", "um pacote", "pacotes"],
  MENSAGEM: ["a mensagem", "uma mensagem", "mensagens"],
  CONFIGURACAO: ["as configurações", "as configurações", "as configurações"],
};

function descrever(o: { acao: Acao; recurso: Recurso; nome: string | null }): string {
  const [definido, indefinido, plural] = SINTAGMA[o.recurso];
  if (o.nome) return `${VERBO[o.acao]} ${definido} '${o.nome}'`;
  if (o.acao === "CONSULTAR") return `${VERBO[o.acao]} ${plural}`;
  return `${VERBO[o.acao]} ${o.acao === "CRIAR" || o.acao === "ENVIAR" || o.acao === "REGISTRAR" ? indefinido : definido}`;
}

/**
 * "Entendi que você quer criar o item 'Mini-pizza de chocolate'. Essa ação ainda não está disponível pelo
 * assistente." — o complemento (quando houver) diz onde isso é feito hoje.
 */
export function mensagemIndisponivel(o: ObjetivoTexto, complemento?: string | null): string {
  const base = o.acao && o.recurso
    ? o.acao === "CONSULTAR"
      ? `Entendi que você quer ${descrever({ acao: o.acao, recurso: o.recurso, nome: o.nome })}, mas ainda não consigo responder essa pergunta pelo assistente.`
      : `Entendi que você quer ${descrever({ acao: o.acao, recurso: o.recurso, nome: o.nome })}. Essa ação ainda não está disponível pelo assistente.`
    : "Essa ação ainda não está disponível pelo assistente.";
  return complemento ? `${base} ${complemento}` : base;
}

export function mensagemAmbigua(o: ObjetivoTexto): string {
  if (o.acao && o.recurso) return `Entendi que você quer ${VERBO[o.acao]} ${SINTAGMA[o.recurso][0]}, mas não sei qual. Abra ${SINTAGMA[o.recurso][0]} na tela e pergunte por ali, ou diga qual é.`;
  return `Entendi que você quer ${o.acao ? VERBO[o.acao] : "fazer"} algo, mas não sei o quê. Diga o que você quer ${o.acao ? VERBO[o.acao] : "fazer"} (por exemplo, uma festa, um cliente ou um pacote).`;
}

// ---------------------------------------------------------------- classificação

/** Mutações só por comando; consulta/navegação/localização nunca contam como ação sobre um alvo ambíguo. */
const ACOES_DE_MUTACAO: readonly Acao[] = ["CRIAR", "EDITAR", "EXCLUIR", "ENVIAR", "REGISTRAR", "CANCELAR"];

export type SinaisResposta = {
  /** Parada da orquestradora (Demerzel), ou null no caminho da Foundation. */
  parada: string | null;
  /** Resultado da Policy registrado no trace. DENY por indisponibilidade já chega com estado explícito. */
  politica: string | null;
};

/** Estado de uma resposta já decidida. Explícito na resposta (agente, ação) vence. */
export function estadoDaResposta(resposta: AIResponse, s: SinaisResposta): EstadoEntendimento | null {
  if (resposta.entendimento) return resposta.entendimento;
  switch (resposta.tipo) {
    case "resposta": case "agente": case "resultado_acao": return "EXECUTADO";
    case "rascunho": return "PRECISA_DADO";
    case "preview": return "PRECISA_CONFIRMACAO";
    case "precisa_contexto": return "PRECISA_DADO";
    case "nao_suportado": {
      if (s.parada === "RECUSA_INJECAO" || s.parada === "RECUSA_JULGAMENTO") return "NEGADO_POLITICA";
      if (s.parada === "PEDIDO_MISTO") return "AMBIGUO";
      if (s.parada === "HUMANO" || s.parada === "AGENTE") return "CAPACIDADE_INDISPONIVEL";
      if (s.politica && s.politica.startsWith("NEGADO")) return "NEGADO_POLITICA";
      if (s.parada === "RECUSA_ACAO") return "CAPACIDADE_INDISPONIVEL";
      // Limites da orquestradora (prazo, passos, custo): nenhuma decisão sobre o pedido.
      if (s.parada && s.parada.startsWith("LIMITE")) return null;
      return "NAO_ENTENDIDO";
    }
    default: return null;
  }
}

/**
 * Pós-processamento da conversa: fixa estado e objetivo em TODA resposta e troca o "não sei" genérico pelo que
 * realmente aconteceu quando o pedido foi entendido mas não tem rota. Nunca cria rota, leitura ou ação.
 */
export function explicarResposta(resposta: AIResponse, texto: string, capacidade: string | null, s: SinaisResposta): AIResponse {
  const doTexto = objetivoDoTexto(texto);
  const objetivo = objetivoDaCapacidade(capacidade) ?? objetivoDe(doTexto);
  let estado = estadoDaResposta(resposta, s);
  let final = resposta;
  if (estado === "NAO_ENTENDIDO" && resposta.tipo === "nao_suportado") {
    const mutacao = doTexto.acao !== null && ACOES_DE_MUTACAO.includes(doTexto.acao);
    if (mutacao && !doTexto.recurso) {
      estado = "AMBIGUO";
      final = { ...resposta, mensagem: mensagemAmbigua(doTexto) };
    } else if (doTexto.acao && doTexto.recurso && doTexto.acao !== "LOCALIZAR") {
      const precisaQual = !doTexto.qualificado && !doTexto.nome && ["ABRIR", "CONSULTAR", "EDITAR"].includes(doTexto.acao) && ["FESTA", "CLIENTE", "CONTRATO"].includes(doTexto.recurso);
      estado = precisaQual ? "AMBIGUO" : "CAPACIDADE_INDISPONIVEL";
      final = { ...resposta, mensagem: precisaQual ? mensagemAmbigua(doTexto) : mensagemIndisponivel(doTexto) };
    }
  }
  return { ...final, entendimento: estado ?? undefined, objetivo };
}
