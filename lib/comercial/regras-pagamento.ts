import type { DbExecutor } from "../db/contracts.ts";
import type { FormaComercial } from "./condicao-pagamento.ts";

/**
 * Regras de pagamento de cada empresa (migration 077, `empresa_regras_pagamento`).
 *
 *   Sem a 077 instalada → REGRAS_LEGADAS para todas as empresas: o comportamento atual, idêntico.
 *   Com a 077 → a linha da empresa; empresa sem linha → REGRAS_NEUTRAS (nenhum desconto automático prometido).
 *   A 077 grava a linha da Kidmais com as regras legadas, então a Kidmais não muda em nenhum momento.
 *
 * O percentual vale no momento em que a condição é criada: ele é gravado na própria condição
 * (`descontoPercentual`) e o contrato usa o gravado. Condição sem o campo (todas as anteriores) usa o legado.
 */
export type RegrasPagamento = {
  pixAvistaPercentual: number;
  pixParceladoPercentual: number;
  /** Rótulo exibido para o cartão (ex.: “Cielo”). */
  cartaoRotulo: string;
  /** Selo automático de -15% de segunda a quinta no calendário público (regra da tela da Kidmais). */
  descontoDiaUtil: boolean;
};

export const REGRAS_LEGADAS: RegrasPagamento = Object.freeze({
  pixAvistaPercentual: 10, pixParceladoPercentual: 3, cartaoRotulo: "Cielo", descontoDiaUtil: true,
});
export const REGRAS_NEUTRAS: RegrasPagamento = Object.freeze({
  pixAvistaPercentual: 0, pixParceladoPercentual: 0, cartaoRotulo: "Cartão de crédito", descontoDiaUtil: false,
});

export function percentualDaForma(regras: RegrasPagamento, forma: FormaComercial): number {
  return forma === "PIX_AVISTA" ? regras.pixAvistaPercentual : forma === "PIX_PARCELADO" ? regras.pixParceladoPercentual : 0;
}

export async function regrasPagamentoInstaladas(tx: DbExecutor) {
  return (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.empresa_regras_pagamento') IS NOT NULL AS ok")).rows[0]?.ok === true;
}

/** Regras da empresa; null = 077 ausente (o chamador mantém o comportamento legado sem gravar nada). */
export async function lerRegrasPagamento(tx: DbExecutor, empresaId: string | null): Promise<RegrasPagamento | null> {
  if (!await regrasPagamentoInstaladas(tx)) return null;
  if (!empresaId) return REGRAS_NEUTRAS;
  const linha = (await tx.query<{ pix_avista_percentual: number; pix_parcelado_percentual: number; cartao_rotulo: string; desconto_dia_util: boolean }>(
    `SELECT pix_avista_percentual, pix_parcelado_percentual, cartao_rotulo, desconto_dia_util
       FROM public.empresa_regras_pagamento WHERE empresa_id = $1::uuid`, [empresaId])).rows[0];
  if (!linha) return REGRAS_NEUTRAS;
  return {
    pixAvistaPercentual: Number(linha.pix_avista_percentual), pixParceladoPercentual: Number(linha.pix_parcelado_percentual),
    cartaoRotulo: linha.cartao_rotulo, descontoDiaUtil: linha.desconto_dia_util,
  };
}

/**
 * Revisão de uma condição já gravada (edição administrativa, revisão operacional). Mesma forma → mantém o percentual
 * gravado; condição antiga sem o campo continua sem ele (legado). Só forma nova consulta a regra vigente: mudar a tela de
 * Descontos nunca reaplica percentual a fechamento existente (Astra r1, P1, 16/11/2026).
 *
 * Fechamento anterior à condição (migration 012: `condicao_pagamento` nula) com a mesma `formaPagamentoPretendida`:
 * o contrato dele usa a base integral (sem condição não há desconto), então a revisão grava 0% explícito para manter o
 * valor; nem a regra vigente nem o legado 10/3 entram (Astra r2, P1, 16/11/2026).
 */
export async function regraNaRevisao(tx: DbExecutor, empresaId: string | null, forma: FormaComercial,
  anterior: { forma?: string | null; descontoPercentual?: number | null } | null | undefined,
  formaRegistrada?: string | null) {
  if (anterior && anterior.forma === forma)
    return typeof anterior.descontoPercentual === "number" ? { descontoPercentual: anterior.descontoPercentual } : {};
  if (!anterior && formaRegistrada === forma) return { descontoPercentual: 0 };
  return regraNaCondicao(tx, empresaId, forma);
}

/**
 * Criação com a confirmação da tela: `exibido` é o percentual que o cliente viu para a forma escolhida. Se a regra
 * vigente (ou o legado, sem a 077) diverge, lança RegrasPagamentoMudaramError com as regras atuais, sem gravar nada,
 * para a tela mostrar os valores novos e pedir nova confirmação. Sem `exibido`, igual a regraNaCondicao.
 */
export async function regraConferidaNaCriacao(tx: DbExecutor, empresaId: string | null, forma: FormaComercial, exibido?: number) {
  const regras = await lerRegrasPagamento(tx, empresaId);
  if (typeof exibido === "number") {
    const vigentes = regras ?? REGRAS_LEGADAS;
    const vigente = percentualDaForma(vigentes, forma);
    if (vigente !== exibido) throw new RegrasPagamentoMudaramError(exibido, vigente, vigentes);
  }
  return regras ? { descontoPercentual: percentualDaForma(regras, forma) } : {};
}

export class RegrasPagamentoMudaramError extends Error {
  readonly exibido: number;
  readonly vigente: number;
  readonly regras: RegrasPagamento;
  constructor(exibido: number, vigente: number, regras: RegrasPagamento) {
    super(`O desconto desta forma de pagamento mudou de ${exibido}% para ${vigente}%. Confira o novo valor e envie de novo.`);
    this.name = "RegrasPagamentoMudaramError";
    this.exibido = exibido;
    this.vigente = vigente;
    this.regras = regras;
  }
}

/** Campo a acrescentar na condição nova: `{ descontoPercentual }` com a 077; `{}` sem ela (legado inalterado). */
export async function regraNaCondicao(tx: DbExecutor, empresaId: string | null, forma: FormaComercial) {
  const regras = await lerRegrasPagamento(tx, empresaId);
  if (!regras) return {};
  return { descontoPercentual: percentualDaForma(regras, forma) };
}
