import { z } from "zod";

/**
 * JEV V1 — camada de JULGAMENTO pequena, rápida, barata e tipada. Sem autoridade de negócio.
 *
 * O JEV só classifica e explica por códigos. NÃO é Policy, NÃO é Human Gate, NÃO é Tenant Context e NÃO
 * concede nada: quem decide é a Policy (autoridade final), com o tenant e o papel comprovados no servidor.
 * O JEV nunca recebe tenant, sessão, banco, id de entidade, ferramenta executável nem dado pessoal: recebe o
 * texto do operador já minimizado (tratado como DADO, nunca como instrução) e sinais booleanos da tela.
 *
 * Toda saída segue o mesmo contrato, validado por schema fechado:
 *   { classification, confidence (0–1), reasonCodes (enumerados), insufficientEvidence, version, source: "JEV" }
 * Sem evidência suficiente ⇒ DESCONHECIDA/UNKNOWN/INSUFFICIENT com `insufficientEvidence: true` — nunca certeza
 * inventada.
 */
export const VERSAO_JEV_V1 = "jev-v1.0.0";

export const CLASSES_JEV = {
  INTENT: ["CONSULTA", "SOLICITAR_ACAO", "ALTERAR_DADO", "FINANCEIRO", "CONTRATO", "FESTA", "CLIENTE", "CONFIGURACAO", "OUTRO", "DESCONHECIDA"],
  /** Consultivo: a Policy é a autoridade final e pode ser mais restritiva. */
  ACTION_SENSITIVITY: ["READ", "SUGGEST", "CONFIRM", "FORBIDDEN", "UNKNOWN"],
  HUMAN_NEED: ["NAO", "RECOMENDADO", "OBRIGATORIO"],
  RISK: ["LOW", "MEDIUM", "HIGH", "UNKNOWN"],
  CONTEXT_SUFFICIENCY: ["SUFFICIENT", "INSUFFICIENT"],
} as const;

export type ClassificadorJev = keyof typeof CLASSES_JEV;
export const CLASSIFICADORES_JEV = Object.keys(CLASSES_JEV) as ClassificadorJev[];
export type ClasseJev<K extends ClassificadorJev> = (typeof CLASSES_JEV)[K][number];

/**
 * Códigos de motivo ENUMERADOS. Qualquer código fora desta lista (inclusive vindo de um modelo) invalida a saída.
 * São explicação legível, nunca autorização.
 */
export const MOTIVOS_JEV = [
  // sinais de intenção
  "SINAL_CONSULTA", "SINAL_PERGUNTA", "SINAL_ACAO", "SINAL_ALTERACAO", "SINAL_SUGESTAO", "SINAL_ENVIO_EXTERNO",
  "SINAL_CANCELAMENTO", "SINAL_FINANCEIRO", "SINAL_CONTRATO", "SINAL_FESTA", "SINAL_CLIENTE", "SINAL_CONFIGURACAO",
  "SINAL_SAUDACAO", "SEM_SINAL", "AMBIGUO",
  // sinais proibidos ou de alto risco
  "SINAL_EXCLUSAO", "SINAL_SQL", "SINAL_SEGREDO", "SINAL_PERMISSAO", "SINAL_OUTRO_TENANT", "SINAL_OUTRO_ESTABELECIMENTO",
  "SINAL_MUTACAO_FINANCEIRA", "SINAL_DESCONTO", "SINAL_CONTRATO_ASSINADO", "SINAL_AUTONOMIA", "INSTRUCAO_IGNORADA",
  // texto e privacidade
  "TEXTO_VAZIO", "TEXTO_TRUNCADO", "PII_REMOVIDA", "CARACTERE_OCULTO_REMOVIDO", "ESCRITA_MISTA",
  // contexto
  "ENTIDADE_NECESSARIA", "ENTIDADE_PRESENTE", "ENTIDADE_AUSENTE", "TELA_COMPATIVEL", "TELA_INCOMPATIVEL", "CONTEXTO_GERAL",
  // combinação e fallback
  "REGRA_DETERMINISTICA", "MODELO_CONCORDA", "MODELO_DIVERGE", "REGRA_MAIS_RESTRITIVA", "CONFIANCA_LIMITADA",
  "MODELO_INDISPONIVEL", "MODELO_SAIDA_INVALIDA", "ORCAMENTO_INDISPONIVEL", "PRAZO_EXCEDIDO", "FALLBACK_REGRAS",
] as const;

export type MotivoJev = (typeof MOTIVOS_JEV)[number];

export type ResultadoJev<K extends ClassificadorJev = ClassificadorJev> = {
  classification: ClasseJev<K>;
  confidence: number;
  reasonCodes: MotivoJev[];
  insufficientEvidence: boolean;
  version: typeof VERSAO_JEV_V1;
  source: "JEV";
};

const confianca = z.number().finite().min(0).max(1);
const motivos = z.array(z.enum(MOTIVOS_JEV)).max(16);

/** Schema fechado do resultado de UM classificador. Campo extra (ex.: "executar", "empresaId") ⇒ inválido. */
export function schemaResultadoJev<K extends ClassificadorJev>(classificador: K) {
  return z.object({
    classification: z.enum(CLASSES_JEV[classificador] as unknown as [ClasseJev<K>, ...ClasseJev<K>[]]),
    confidence: confianca,
    reasonCodes: motivos,
    insufficientEvidence: z.boolean(),
    version: z.literal(VERSAO_JEV_V1),
    source: z.literal("JEV"),
  }).strict();
}

/** Julgamento completo: os cinco classificadores, sempre juntos e coerentes entre si. */
export type JulgamentoJev = {
  intent: ResultadoJev<"INTENT">;
  actionSensitivity: ResultadoJev<"ACTION_SENSITIVITY">;
  humanNeed: ResultadoJev<"HUMAN_NEED">;
  risk: ResultadoJev<"RISK">;
  contextSufficiency: ResultadoJev<"CONTEXT_SUFFICIENCY">;
  /** De onde veio: só regras, regras + modelo, ou regras depois de o modelo falhar. */
  origem: "REGRAS" | "COMBINADO" | "FALLBACK_REGRAS";
};

export const julgamentoSchema = z.object({
  intent: schemaResultadoJev("INTENT"),
  actionSensitivity: schemaResultadoJev("ACTION_SENSITIVITY"),
  humanNeed: schemaResultadoJev("HUMAN_NEED"),
  risk: schemaResultadoJev("RISK"),
  contextSufficiency: schemaResultadoJev("CONTEXT_SUFFICIENCY"),
  origem: z.enum(["REGRAS", "COMBINADO", "FALLBACK_REGRAS"]),
}).strict();

/** Telas que o JEV conhece. A entidade em si nunca chega ao JEV: só se há uma aberta. */
export const TELAS_JEV = ["dashboard", "festa", "cliente", "contrato", "financeiro", "pacotes", "configuracoes", "agenda", "geral"] as const;
export type TelaJev = (typeof TELAS_JEV)[number];

export type EntradaJev = {
  /** Texto do operador. É DADO: instruções escritas nele nunca mudam o julgamento para menos restritivo. */
  texto: string;
  tela: TelaJev | null;
  /** Há uma entidade (festa, cliente, contrato) aberta na tela? O id não é informado ao JEV. */
  temEntidade: boolean;
};

/**
 * Saída que um MODELO pode propor ao JEV (economy). Schema fechado, enums fechados, códigos enumerados.
 * Não tem campo de ferramenta, tenant, id ou texto livre: só classificações.
 */
export const saidaModeloJevSchema = z.object({
  intent: z.enum(CLASSES_JEV.INTENT),
  actionSensitivity: z.enum(CLASSES_JEV.ACTION_SENSITIVITY),
  humanNeed: z.enum(CLASSES_JEV.HUMAN_NEED),
  risk: z.enum(CLASSES_JEV.RISK),
  contextSufficiency: z.enum(CLASSES_JEV.CONTEXT_SUFFICIENCY),
  confidence: confianca,
  reasonCodes: motivos,
}).strict();

export type SaidaModeloJev = z.infer<typeof saidaModeloJevSchema>;

/** JSON Schema equivalente, enviado ao provedor (`json_schema` estrito). */
export const JSON_SCHEMA_SAIDA_MODELO: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "actionSensitivity", "humanNeed", "risk", "contextSufficiency", "confidence", "reasonCodes"],
  properties: {
    intent: { type: "string", enum: [...CLASSES_JEV.INTENT] },
    actionSensitivity: { type: "string", enum: [...CLASSES_JEV.ACTION_SENSITIVITY] },
    humanNeed: { type: "string", enum: [...CLASSES_JEV.HUMAN_NEED] },
    risk: { type: "string", enum: [...CLASSES_JEV.RISK] },
    contextSufficiency: { type: "string", enum: [...CLASSES_JEV.CONTEXT_SUFFICIENCY] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasonCodes: { type: "array", maxItems: 16, items: { type: "string", enum: [...MOTIVOS_JEV] } },
  },
};

/** Ordens de restrição: na combinação, o mais restritivo sempre vence. */
export const RESTRICAO_SENSIBILIDADE: Readonly<Record<ClasseJev<"ACTION_SENSITIVITY">, number>> = { READ: 0, SUGGEST: 1, UNKNOWN: 2, CONFIRM: 3, FORBIDDEN: 4 };
export const RESTRICAO_HUMANO: Readonly<Record<ClasseJev<"HUMAN_NEED">, number>> = { NAO: 0, RECOMENDADO: 1, OBRIGATORIO: 2 };
export const RESTRICAO_RISCO: Readonly<Record<ClasseJev<"RISK">, number>> = { LOW: 0, UNKNOWN: 1, MEDIUM: 2, HIGH: 3 };
export const RESTRICAO_CONTEXTO: Readonly<Record<ClasseJev<"CONTEXT_SUFFICIENCY">, number>> = { SUFFICIENT: 0, INSUFFICIENT: 1 };
