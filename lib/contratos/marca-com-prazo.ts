import type { DbExecutor } from '../db/contracts.ts';
import { transacaoComPrazo, type AbrirConexao } from '../db/transacao-com-prazo.ts';
import { MARCA_CONTRATO_NEUTRA, type MarcaContrato } from './marca-contrato.ts';

/**
 * A marca é enriquecimento opcional (nome ou logo no cabeçalho): não pode segurar a resposta. Um orçamento curto cobre a
 * fila do pool, a conexão e as consultas; vencido ou com falha, a tela segue neutra e a conexão é descartada.
 */
export const PRAZO_MARCA_MS = 1500;

export function lerMarcaComPrazo(
  abrir: AbrirConexao,
  ler: (tx: DbExecutor) => Promise<MarcaContrato>,
  prazoMs = PRAZO_MARCA_MS,
): Promise<MarcaContrato> {
  return transacaoComPrazo(abrir, prazoMs)(ler).catch(() => MARCA_CONTRATO_NEUTRA);
}
