import type { EstornoRecord, RecebimentoAlocacaoRecord, RecebimentoRecord } from "../repositories";
import type { RegistrarEstornoInput, RegistrarRecebimentoInput } from "./models";
import { dinheiroParaCentavos } from "./financeiro-core.ts";
import { PagamentoServiceError } from "./errors.ts";

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
