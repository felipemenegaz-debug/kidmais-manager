import { z } from "zod";
import type { TipoEntidade } from "../contratos.ts";
import type { CapacidadeCatalogo } from "../intencao.ts";

/**
 * Planner (AI V1.1, PR 6): contrato FECHADO de um plano curto de capacidades.
 *
 * O Planner decide COMO combinar capacidades já permitidas; não escolhe tenant, não cria tool, SQL ou shell e nunca
 * fornece id de domínio. Ids só entram por `entradaDe`: entidade devolvida por um passo anterior (saída validada do
 * Core) ou âncora de tela/foco já revalidada. Cada passo é executado pelas mesmas portas guardadas (Policy + Tenant
 * Context por passo). Plano inválido ⇒ rejeitado inteiro, nada é executado.
 */
export const VERSAO_PLANEJADOR = "planejador-v1.0.0";

export const LIMITES_PLANO = Object.freeze({
  /** Passos por plano. Mais que isso ⇒ capacidade insuficiente (nunca laço até encontrar resultado). */
  maxPassos: 5,
  /** Ações por plano: no máximo uma, sempre no fim, sempre como proposta (Human Gate). */
  maxAcoes: 1,
});

export const TIPOS_ENTIDADE = ["FESTA", "CLIENTE", "CONTRATO", "ITEM", "CATEGORIA"] as const satisfies readonly TipoEntidade[];
const ACOES = ["CONSULTAR", "LOCALIZAR", "ABRIR", "CRIAR", "EDITAR", "EXCLUIR", "ENVIAR", "REGISTRAR", "CANCELAR"] as const;
const RECURSOS = ["DASHBOARD", "FESTA", "CLIENTE", "CONTRATO", "PAGAMENTO", "FINANCEIRO", "AGENDA", "CATEGORIA", "ITEM", "PACOTE", "MENSAGEM", "CONFIGURACAO", "FECHAMENTO"] as const;
const IDS_PASSO = ["p1", "p2", "p3", "p4", "p5"] as const;

const tipoEntidade = z.enum(TIPOS_ENTIDADE);
const idPasso = z.enum(IDS_PASSO);

/** De onde vem o id que o passo recebe. Nunca de um literal. */
const entradaDe = z.discriminatedUnion("de", [
  z.object({ de: z.literal("PASSO"), passo: idPasso, entidade: tipoEntidade }).strict(),
  z.object({ de: z.literal("CONTEXTO"), entidade: tipoEntidade }).strict(),
]);

/** Parâmetros não-id: texto curto, inteiro ou booleano. Chaves simples (sem aninhamento). */
const parametros = z.record(z.string().regex(/^[a-zA-Z]{1,20}$/), z.union([z.string().max(60), z.number().int().min(-1000).max(1000), z.boolean()]));

const passoSchema = z.object({
  id: idPasso,
  capacidade: z.string().regex(/^[a-z_]{3,40}$/),
  parametros: parametros.optional(),
  entradaDe: entradaDe.optional(),
  /** Como escolher a entidade que sai DESTE passo: UNICA (0 ⇒ sem dados; 2+ ⇒ ambíguo) ou PRIMEIRA (lista ordenada, empate ⇒ ambíguo). */
  selecao: z.enum(["UNICA", "PRIMEIRA"]).optional(),
}).strict();

export const planoSchema = z.object({
  objetivo: z.string().refine((o) => {
    const [acao, recurso, ...resto] = o.split(":");
    return !resto.length && (ACOES as readonly string[]).includes(acao) && (RECURSOS as readonly string[]).includes(recurso ?? "");
  }),
  recursoFinal: tipoEntidade.nullable(),
  passos: z.array(passoSchema).min(1).max(LIMITES_PLANO.maxPassos),
}).strict();

export type Plano = z.infer<typeof planoSchema>;
export type PassoPlano = z.infer<typeof passoSchema>;

export type MotivoRejeicao =
  | "SCHEMA" | "CAMPO_EXTRA" | "LIMITE_PASSOS" | "TOOL_DESCONHECIDA" | "ID_LITERAL" | "REFERENCIA_INVALIDA" | "ACAO_FORA_DO_FIM" | "NAVEGACAO_FORA_DO_FIM";

export type ValidacaoPlano = { ok: true; plano: Plano } | { ok: false; motivo: MotivoRejeicao };

/** Capacidades que abrem tela: só como último passo. */
export const CAPACIDADES_NAVEGACAO: ReadonlySet<string> = new Set(["abrir_tela", "abrir_festa"]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Chaves que carregam autoridade ou id: nunca aceitas num plano (o id vem de `entradaDe`). */
const CHAVE_PROIBIDA = /ids?$|^(empresa|tenant|unidade|estabelecimento|usuario|papel|sql|query|url|destino)/i;

/**
 * Valida um plano bruto (do modelo ou das regras) contra o schema fechado E o catálogo que o operador pode usar agora.
 * Qualquer violação rejeita o plano inteiro.
 */
export function validarPlano(bruto: unknown, catalogo: readonly CapacidadeCatalogo[]): ValidacaoPlano {
  if (bruto && typeof bruto === "object" && Array.isArray((bruto as { passos?: unknown }).passos) && (bruto as { passos: unknown[] }).passos.length > LIMITES_PLANO.maxPassos) {
    return { ok: false, motivo: "LIMITE_PASSOS" };
  }
  // Id literal em qualquer lugar do plano (chave ou valor): rejeitado antes de qualquer outra análise.
  if (temIdLiteral(bruto)) return { ok: false, motivo: "ID_LITERAL" };
  const lido = planoSchema.safeParse(bruto);
  if (!lido.success) {
    const extra = lido.error.issues.some((i) => i.code === "unrecognized_keys");
    return { ok: false, motivo: extra ? "CAMPO_EXTRA" : "SCHEMA" };
  }
  const plano = lido.data;
  const vistos = new Set<string>();
  let acoes = 0;
  for (const [i, passo] of plano.passos.entries()) {
    // Ids em ordem (p1, p2, …): referência só para trás, sem ciclo nem recursão.
    if (passo.id !== IDS_PASSO[i]) return { ok: false, motivo: "REFERENCIA_INVALIDA" };
    const item = catalogo.find((c) => c.id === passo.capacidade);
    if (!item) return { ok: false, motivo: "TOOL_DESCONHECIDA" };
    const ultimo = i === plano.passos.length - 1;
    if (item.tipo === "acao") {
      acoes += 1;
      if (!ultimo || acoes > LIMITES_PLANO.maxAcoes) return { ok: false, motivo: "ACAO_FORA_DO_FIM" };
    }
    if (CAPACIDADES_NAVEGACAO.has(passo.capacidade) && !ultimo) return { ok: false, motivo: "NAVEGACAO_FORA_DO_FIM" };
    if (passo.entradaDe?.de === "PASSO" && !vistos.has(passo.entradaDe.passo)) return { ok: false, motivo: "REFERENCIA_INVALIDA" };
    if (passo.entradaDe?.de === "CONTEXTO" && i !== 0) return { ok: false, motivo: "REFERENCIA_INVALIDA" };
    vistos.add(passo.id);
  }
  return { ok: true, plano };
}

/** Uuid ou sequência longa de dígitos em qualquer valor; chave de id/autoridade em qualquer objeto. `id: "p1"` é o do passo. */
function temIdLiteral(valor: unknown, profundidade = 0): boolean {
  if (profundidade > 6) return true;
  if (typeof valor === "string") return UUID.test(valor) || /\d{6,}/.test(valor);
  if (Array.isArray(valor)) return valor.some((v) => temIdLiteral(v, profundidade + 1));
  if (valor && typeof valor === "object") {
    return Object.entries(valor).some(([chave, v]) => {
      if (chave === "id") return !(typeof v === "string" && (IDS_PASSO as readonly string[]).includes(v));
      return CHAVE_PROIBIDA.test(chave) || temIdLiteral(v, profundidade + 1);
    });
  }
  return false;
}

