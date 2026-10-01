import { createHash } from "node:crypto";
import type { EstornoRecord, RecebimentoAlocacaoRecord, RecebimentoRecord } from "../repositories";
import type { RegistrarEstornoInput, RegistrarRecebimentoInput } from "./models";
import { dinheiroParaCentavos } from "./financeiro-core.ts";
import { PagamentoServiceError } from "./errors.ts";

/**
 * E2 — idempotência interna tenant-safe. A chave informada pelo cliente vale só dentro de (empresa, pagamento,
 * operação): o valor gravado é `v2:` + sha256 desse escopo, então a unicidade global da coluna equivale à
 * unicidade por (empresa, pagamento, operação, chave) — consulta e restrição concordam. A mesma chave em outra
 * empresa ou outro pagamento é outra chave (sem colisão nem oráculo). Referência do provedor externo NÃO passa
 * por aqui: é identificador real do provedor, com unicidade própria (provedor + referência).
 */
export function chaveIdempotenciaNoPagamento(empresaId: string, pagamentoId: string, operacao: "recebimento" | "estorno", chave: string | null | undefined) {
  const informada = chave?.trim();
  if (!informada) return null;
  return "v2:" + createHash("sha256").update(`${operacao}\0${empresaId.toLowerCase()}\0${pagamentoId.toLowerCase()}\0${informada}`).digest("hex");
}

function referenciaDiverge(existente: { provedorCodigo?: string | null; referenciaExterna?: string | null }, input: { provedorCodigo?: string | null; referenciaExterna?: string | null }) {
  return (input.provedorCodigo != null && (input.provedorCodigo.trim() || null) !== (existente.provedorCodigo ?? null)) ||
    (input.referenciaExterna != null && (input.referenciaExterna.trim() || null) !== (existente.referenciaExterna ?? null));
}

export function validarRepeticaoRecebimento(
  existente: RecebimentoRecord,
  alocacoes: RecebimentoAlocacaoRecord[],
  input: RegistrarRecebimentoInput,
) {
  const porParcela = new Map(input.alocacoes.map((item) => [item.parcelaId.toLowerCase(), item.valor]));
  if (
    existente.pagamentoId.toLowerCase() !== input.pagamentoId.toLowerCase() ||
    existente.meioPagamento !== input.meioPagamento ||
    referenciaDiverge(existente, input) ||
    dinheiroParaCentavos(existente.valorBruto) !== dinheiroParaCentavos(input.valorBruto) ||
    porParcela.size !== input.alocacoes.length ||
    alocacoes.length !== input.alocacoes.length ||
    alocacoes.some((item) => {
      const valor = porParcela.get(item.parcelaId.toLowerCase());
      return valor === undefined || dinheiroParaCentavos(valor) !== dinheiroParaCentavos(item.valorAlocado);
    })
  ) {
    throw new PagamentoServiceError("RECEBIMENTO_INVALIDO", "Chave de idempotência já utilizada com dados financeiros diferentes.", 409);
  }
}

export function validarRepeticaoEstorno(
  existente: EstornoRecord,
  pagamentoDoRecebimentoId: string,
  input: RegistrarEstornoInput,
) {
  if (
    pagamentoDoRecebimentoId.toLowerCase() !== input.pagamentoId.toLowerCase() ||
    existente.recebimentoId.toLowerCase() !== input.recebimentoId.toLowerCase() ||
    existente.parcelaId.toLowerCase() !== input.parcelaId.toLowerCase() ||
    referenciaDiverge(existente, input) ||
    dinheiroParaCentavos(existente.valor) !== dinheiroParaCentavos(input.valor)
  ) {
    throw new PagamentoServiceError("ESTORNO_INVALIDO", "Chave de idempotência já utilizada com dados financeiros diferentes.", 409);
  }
}
