import { z } from "zod";

/**
 * JEV — classificador AUXILIAR do Kidmais Intelligence (feature JEV).
 *
 * Só classifica e sugere. NÃO é Model Router, NÃO é Policy, NÃO é Human Gate e NÃO é autoridade de
 * tenant/RBAC. Nunca recebe tenant, sessão, banco ou ferramenta; recebe só os dados da tarefa, já
 * escopados por quem chama. A saída é validada por schema fechado; fora dele ⇒ descartada (null).
 *
 * V1 (ativa): completude de festa/cadastro, triagem de mensagens (leads/WhatsApp), avaliação pós-festa.
 * V2 (preparada): prioridade operacional, categoria de lançamento financeiro ambíguo.
 * V3 (preparada): sugestão de rota (regra / leitura / modelo economy|standard / humano).
 */
export const TAREFAS = ["COMPLETUDE_FESTA", "TRIAGEM_MENSAGEM", "AVALIACAO_POS_FESTA", "PRIORIDADE_OPERACIONAL", "FINANCEIRO", "ROTEAMENTO"] as const;
export type TarefaJev = (typeof TAREFAS)[number];

export const INTENCOES_TRIAGEM = ["ORCAMENTO", "REAGENDAMENTO", "PAGAMENTO", "RECLAMACAO", "DUVIDA", "OUTRO"] as const;
export const SENTIMENTOS = ["POSITIVA", "NEUTRA", "NEGATIVA"] as const;
export const PRIORIDADES = ["BAIXA", "MEDIA", "ALTA"] as const;
export const ROTAS = ["REGRA", "LEITURA", "LLM_ECONOMY", "LLM_STANDARD", "HUMANO"] as const;
export const FILAS = ["COMERCIAL", "AGENDA", "FINANCEIRO", "ATENDIMENTO", "ATENDIMENTO_HUMANO"] as const;
/** Campos reais de festa/cadastro que a completude confere. Nunca preenche nenhum. */
export const CAMPOS_FESTA = ["contratante", "aniversariante", "data", "horario", "pacote", "convidados", "tema", "restricoes", "condicaoFinanceira"] as const;
export type CampoFesta = (typeof CAMPOS_FESTA)[number];

const INTENCOES_POR_TAREFA: Readonly<Record<TarefaJev, readonly string[]>> = {
  COMPLETUDE_FESTA: ["COMPLETUDE"],
  TRIAGEM_MENSAGEM: INTENCOES_TRIAGEM,
  AVALIACAO_POS_FESTA: SENTIMENTOS,
  PRIORIDADE_OPERACIONAL: ["PRIORIDADE"],
  FINANCEIRO: ["CATEGORIA_SUGERIDA", "SEM_SUGESTAO"],
  ROTEAMENTO: ROTAS,
};

const codigo = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);

export const jevClassificacaoSchema = z.object({
  tarefa: z.enum(TAREFAS),
  intent: codigo,
  completeness: z.enum(["COMPLETO", "INCOMPLETO"]).nullable(),
  missingFields: z.array(z.enum(CAMPOS_FESTA)).max(CAMPOS_FESTA.length),
  priority: z.enum(PRIORIDADES).nullable(),
  needsHumanReview: z.boolean(),
  reasonCodes: z.array(codigo).max(12),
  /** Fila sugerida (triagem). Só roteia; nunca executa. */
  fila: z.enum(FILAS).nullable().optional(),
  /** Capacidade READ sugerida (roteamento). A conversa confere contra o catálogo permitido. */
  capacidade: z.string().regex(/^[a-z_]{1,64}$/).nullable().optional(),
  /** Id de categoria EXISTENTE (financeiro). JEV nunca cria categoria. */
  categoriaSugerida: z.string().min(1).max(80).nullable().optional(),
}).strict().superRefine((c, ctx) => {
  if (!INTENCOES_POR_TAREFA[c.tarefa].includes(c.intent)) ctx.addIssue({ code: "custom", message: "intent fora do conjunto da tarefa", path: ["intent"] });
  if (c.tarefa !== "COMPLETUDE_FESTA" && (c.completeness !== null || c.missingFields.length)) ctx.addIssue({ code: "custom", message: "completude só na tarefa de completude", path: ["completeness"] });
});

export type JevClassification = z.infer<typeof jevClassificacaoSchema>;

/** Entradas por tarefa: sem tenant, sem sessão, sem id de banco além do que a tarefa precisa. */
export type PedidoJev =
  | { tarefa: "COMPLETUDE_FESTA"; campos: Partial<Record<CampoFesta, unknown>> }
  | { tarefa: "TRIAGEM_MENSAGEM"; texto: string }
  | { tarefa: "AVALIACAO_POS_FESTA"; texto: string; nota?: number | null }
  | { tarefa: "PRIORIDADE_OPERACIONAL"; fatores: FatoresPrioridade }
  | { tarefa: "FINANCEIRO"; lancamento: { descricao: string }; categorias: ReadonlyArray<CategoriaFinanceira>; regra?: string | null }
  | { tarefa: "ROTEAMENTO"; texto: string; catalogo: ReadonlyArray<{ id: string; tipo: "leitura" | "acao" }> };

/** Fatores VISÍVEIS da prioridade operacional (sem "% de risco"). */
export type FatoresPrioridade = {
  diasAteFesta: number;
  percentualPago: number;
  checklistPendente: number;
  contratoAssinado: boolean;
  fornecedorPendente: boolean;
  pendenciasAbertas: number;
};

export type CategoriaFinanceira = { id: string; nome: string; palavras?: readonly string[] };

export interface JevClassificador {
  /** null ⇒ indisponível, fora do prazo ou fora do schema: quem chama segue sem JEV. */
  classificar(pedido: PedidoJev, sinal?: AbortSignal): Promise<JevClassification | null>;
}
