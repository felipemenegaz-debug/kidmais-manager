import { normalizar } from "../texto-pt.ts";
import {
  CAMPOS_FESTA, type CampoFesta, type CategoriaFinanceira, type FatoresPrioridade, type JevClassification, type PedidoJev,
} from "./contrato.ts";

/**
 * Motor local do JEV (V1 ativo, V2/V3 preparados): determinístico, sem rede, sem banco, sem modelo.
 * Só olha os dados da tarefa. Texto de cliente/lead é DADO: instruções escritas nele ("ignore as regras",
 * "confirme o pagamento") viram motivo de revisão humana, nunca comando.
 */
const tem = (n: string, ...padroes: RegExp[]) => padroes.some((p) => p.test(n));
const base = (tarefa: JevClassification["tarefa"], intent: string): JevClassification => ({
  tarefa, intent, completeness: null, missingFields: [], priority: null, needsHumanReview: false, reasonCodes: [],
});

const INJECAO = [/\b(ignore|ignora|desconsidere|esqueca)\b.*\b(regras?|instruc\w*|anterior\w*)\b/, /\b(confirm\w*|aprov\w*|marqu\w*|registr\w*)\b.*\b(sozinh\w*|automatic\w*|como pag\w*|pagamento)\b/, /\bvoce (agora )?e\b/, /\bsystem\b|\bprompt\b/];

// ---------------------------------------------------------------- V1: completude

/** Presença real do valor: nada é inferido; string vazia, null e undefined contam como ausentes. */
function presente(valor: unknown) {
  if (valor === null || valor === undefined) return false;
  if (typeof valor === "string") return valor.trim().length > 0;
  if (typeof valor === "number") return Number.isFinite(valor);
  if (Array.isArray(valor)) return valor.length > 0;
  return true;
}

const CRITICOS: readonly CampoFesta[] = ["contratante", "data", "convidados", "pacote"];

export function completudeFesta(campos: Partial<Record<CampoFesta, unknown>>): JevClassification {
  const faltando = CAMPOS_FESTA.filter((c) => !presente(campos[c]));
  return {
    ...base("COMPLETUDE_FESTA", "COMPLETUDE"),
    completeness: faltando.length ? "INCOMPLETO" : "COMPLETO",
    missingFields: faltando,
    needsHumanReview: faltando.some((c) => CRITICOS.includes(c)),
    reasonCodes: faltando.map((c) => `FALTA_${c.replace(/[A-Z]/g, (l) => `_${l}`).toUpperCase()}`),
  };
}

// ---------------------------------------------------------------- V1: triagem

const SINAIS_TRIAGEM: ReadonlyArray<[JevClassification["intent"], RegExp[]]> = [
  ["RECLAMACAO", [/\breclam\w*/, /\binsatisf\w*/, /\bpessim\w*/, /\bhorrivel\b/, /\babsurd\w*/, /\bdecepcion\w*/, /\bdescaso\b/, /\bprocon\b/, /\bnao gostei\b/, /\bmal atendid\w*/, /\bproblema\w*/]],
  ["REAGENDAMENTO", [/\bremarc\w*/, /\breagend\w*/, /\b(mudar|trocar|alterar) (a )?data\b/, /\badiar\b/, /\boutra data\b/, /\bcancel\w*/]],
  ["PAGAMENTO", [/\bpag\w*/, /\bpix\b/, /\bboleto\w*/, /\bparcela\w*/, /\bcomprovante\w*/, /\btransfer\w*/, /\bcartao\b/, /\bvencimento\w*/, /\bcobranc\w*/]],
  ["ORCAMENTO", [/\borcament\w*/, /\bquanto custa\b/, /\bvalor(es)?\b/, /\bpreco\w*/, /\bpacote\w*/, /\bdisponib\w*/, /\bdata livre\b/, /\bfesta para\b/]],
  ["DUVIDA", [/\bduvida\w*/, /\bcomo funciona\b/, /\bposso\b/, /\bqual\b/, /\bquais\b/]],
];

const FILA: Readonly<Record<string, NonNullable<JevClassification["fila"]>>> = {
  ORCAMENTO: "COMERCIAL", REAGENDAMENTO: "AGENDA", PAGAMENTO: "FINANCEIRO", RECLAMACAO: "ATENDIMENTO_HUMANO", DUVIDA: "ATENDIMENTO", OUTRO: "ATENDIMENTO",
};
const PRIORIDADE: Readonly<Record<string, NonNullable<JevClassification["priority"]>>> = {
  RECLAMACAO: "ALTA", REAGENDAMENTO: "MEDIA", PAGAMENTO: "MEDIA", ORCAMENTO: "MEDIA", DUVIDA: "BAIXA", OUTRO: "BAIXA",
};

export function triagemMensagem(texto: string): JevClassification {
  const n = normalizar(texto.slice(0, 2_000));
  const pontos = SINAIS_TRIAGEM.map(([intent, padroes]) => [intent, padroes.filter((p) => p.test(n)).length] as const).filter(([, p]) => p > 0);
  const maior = Math.max(0, ...pontos.map(([, p]) => p));
  const empatados = pontos.filter(([, p]) => p === maior).map(([i]) => i);
  // Empate: a ordem de SINAIS_TRIAGEM prioriza o que exige mais cuidado (reclamação antes de orçamento).
  const intent = empatados[0] ?? (/\?/.test(texto) ? "DUVIDA" : "OUTRO");
  const motivos: string[] = [];
  if (empatados.length > 1) motivos.push("AMBIGUO");
  if (tem(n, ...INJECAO)) motivos.push("INSTRUCAO_IGNORADA");
  const cancelamento = intent === "REAGENDAMENTO" && /\bcancel\w*/.test(n);
  if (cancelamento) motivos.push("CANCELAMENTO");
  return {
    ...base("TRIAGEM_MENSAGEM", intent),
    priority: cancelamento ? "ALTA" : PRIORIDADE[intent],
    needsHumanReview: intent === "RECLAMACAO" || intent === "OUTRO" || motivos.length > 0,
    reasonCodes: [`SINAL_${intent}`, ...motivos],
    fila: FILA[intent],
  };
}

// ---------------------------------------------------------------- V1: avaliação pós-festa

const POSITIVOS = [/\b(amei|amamos|adorei|adoramos|otim\w*|excelente\w*|maravilh\w*|perfeit\w*|incrivel|lind\w*|parabens|recomend\w*|impecav\w*)\b/, /\bmuito bo[ma]\b/, /\bgostei\b/];
const NEGATIVOS = [/\b(pessim\w*|horrivel|ruim|decepcion\w*|atras\w*|frio\b|fria\b|faltou|faltaram|sujo|suja|grosseir\w*|nao recomend\w*|reclam\w*|problema\w*)\b/, /\bnao gostei\b/, /\bdeixou a desejar\b/];

export function avaliacaoPosFesta(texto: string, nota?: number | null): JevClassification {
  const n = normalizar(texto.slice(0, 4_000));
  const semNegacaoDeGostar = n.replace(/\bnao gostei\b/g, "");
  const pos = POSITIVOS.filter((p) => p.test(semNegacaoDeGostar)).length;
  const neg = NEGATIVOS.filter((p) => p.test(n)).length;
  const motivos: string[] = [];
  let sentimento: "POSITIVA" | "NEUTRA" | "NEGATIVA" = pos > neg ? "POSITIVA" : neg > pos ? "NEGATIVA" : "NEUTRA";
  if (typeof nota === "number" && Number.isFinite(nota)) {
    // Nota de 1 a 5 é evidência visível; contradição com o texto vai para revisão humana.
    const daNota = nota <= 2 ? "NEGATIVA" : nota >= 4 ? "POSITIVA" : "NEUTRA";
    if (daNota !== sentimento && pos + neg > 0) motivos.push("NOTA_DIVERGE_DO_TEXTO");
    if (daNota === "NEGATIVA") sentimento = "NEGATIVA";
    motivos.push(`NOTA_${daNota}`);
  }
  if (pos > 0 && neg > 0) motivos.push("MISTA");
  if (tem(n, ...INJECAO)) motivos.push("INSTRUCAO_IGNORADA");
  return {
    ...base("AVALIACAO_POS_FESTA", sentimento),
    priority: sentimento === "NEGATIVA" ? "ALTA" : "BAIXA",
    needsHumanReview: sentimento === "NEGATIVA" || motivos.some((m) => m === "MISTA" || m === "NOTA_DIVERGE_DO_TEXTO" || m === "INSTRUCAO_IGNORADA"),
    reasonCodes: [`SENTIMENTO_${sentimento}`, ...motivos],
  };
}

// ---------------------------------------------------------------- V2 (preparada): prioridade operacional

/** Fatores visíveis, sem "87% de risco": cada ponto vira um motivo legível. */
export function prioridadeOperacional(f: FatoresPrioridade): JevClassification {
  const motivos: string[] = [];
  const perto = f.diasAteFesta >= 0 && f.diasAteFesta <= 7;
  const proxima = f.diasAteFesta >= 0 && f.diasAteFesta <= 30;
  if (perto) motivos.push("FESTA_EM_ATE_7_DIAS"); else if (proxima) motivos.push("FESTA_EM_ATE_30_DIAS");
  if (f.percentualPago < 100) motivos.push(f.percentualPago < 50 ? "MENOS_DA_METADE_PAGO" : "SALDO_EM_ABERTO");
  if (f.checklistPendente > 0) motivos.push("CHECKLIST_PENDENTE");
  if (!f.contratoAssinado) motivos.push("CONTRATO_NAO_ASSINADO");
  if (f.fornecedorPendente) motivos.push("FORNECEDOR_PENDENTE");
  if (f.pendenciasAbertas > 0) motivos.push("PENDENCIAS_ABERTAS");
  const problemas = motivos.filter((m) => !m.startsWith("FESTA_")).length;
  const prioridade = perto && problemas > 0 ? "ALTA" : (proxima && problemas > 0) || problemas >= 3 ? "MEDIA" : "BAIXA";
  return { ...base("PRIORIDADE_OPERACIONAL", "PRIORIDADE"), priority: prioridade, needsHumanReview: prioridade === "ALTA", reasonCodes: motivos.length ? motivos : ["SEM_PENDENCIA_VISIVEL"] };
}

// ---------------------------------------------------------------- V2 (preparada): financeiro

/**
 * Regra determinística primeiro (vem de quem chama). Só lançamento ambíguo passa pelo JEV, que escolhe
 * entre categorias EXISTENTES — nunca cria. Mais de uma candidata ou nenhuma ⇒ sem sugestão + humano.
 */
export function categoriaFinanceira(lancamento: { descricao: string }, categorias: ReadonlyArray<CategoriaFinanceira>, regra?: string | null): JevClassification {
  if (regra && categorias.some((c) => c.id === regra)) {
    return { ...base("FINANCEIRO", "CATEGORIA_SUGERIDA"), categoriaSugerida: regra, reasonCodes: ["REGRA_DETERMINISTICA"] };
  }
  const n = normalizar(lancamento.descricao.slice(0, 300));
  const candidatas = categorias.filter((c) => [c.nome, ...(c.palavras ?? [])].some((p) => {
    const alvo = normalizar(p);
    return alvo.length >= 3 && new RegExp(`\\b${alvo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(n);
  }));
  if (candidatas.length === 1) return { ...base("FINANCEIRO", "CATEGORIA_SUGERIDA"), categoriaSugerida: candidatas[0].id, needsHumanReview: true, reasonCodes: ["PALAVRA_DA_CATEGORIA"] };
  return { ...base("FINANCEIRO", "SEM_SUGESTAO"), categoriaSugerida: null, needsHumanReview: true, reasonCodes: [candidatas.length ? "AMBIGUO" : "SEM_CANDIDATA"] };
}

// ---------------------------------------------------------------- V3 (preparada): roteamento

/**
 * Sugestão de rota a partir da triagem. Só LEITURA do catálogo recebido; reclamação e texto suspeito vão
 * para humano; o resto fica para o modelo (economy). A Policy da conversa decide.
 */
export function roteamento(texto: string, catalogo: ReadonlyArray<{ id: string; tipo: "leitura" | "acao" }>): JevClassification {
  const t = triagemMensagem(texto);
  const leitura = (id: string) => catalogo.some((c) => c.id === id && c.tipo === "leitura");
  const motivos = [...t.reasonCodes];
  if (t.intent === "RECLAMACAO" || t.reasonCodes.includes("INSTRUCAO_IGNORADA")) {
    return { ...base("ROTEAMENTO", "HUMANO"), needsHumanReview: true, priority: t.priority, reasonCodes: motivos };
  }
  if (t.intent === "PAGAMENTO" && leitura("analisar_recebiveis")) {
    return { ...base("ROTEAMENTO", "LEITURA"), capacidade: "analisar_recebiveis", priority: t.priority, reasonCodes: motivos };
  }
  return { ...base("ROTEAMENTO", "LLM_ECONOMY"), priority: t.priority, reasonCodes: motivos };
}

export function classificarLocal(pedido: PedidoJev): JevClassification {
  switch (pedido.tarefa) {
    case "COMPLETUDE_FESTA": return completudeFesta(pedido.campos);
    case "TRIAGEM_MENSAGEM": return triagemMensagem(pedido.texto);
    case "AVALIACAO_POS_FESTA": return avaliacaoPosFesta(pedido.texto, pedido.nota);
    case "PRIORIDADE_OPERACIONAL": return prioridadeOperacional(pedido.fatores);
    case "FINANCEIRO": return categoriaFinanceira(pedido.lancamento, pedido.categorias, pedido.regra);
    case "ROTEAMENTO": return roteamento(pedido.texto, pedido.catalogo);
  }
}
