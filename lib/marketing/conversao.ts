import type { DbExecutor } from '../db/contracts.ts';
import { MarketingError, naoEncontrado } from './erros.ts';
import { atribuicaoVigente, registrarSeAusente } from './atribuicao.ts';
import { registrarEventoHistorico } from '../clientes/repositories/historico.repository.ts';

/** Vínculo e herança comuns, na transação do chamador; repetição do mesmo par não escreve. */
export async function vincularContatoNegociacao(tx: DbExecutor, empresaId: string, usuarioId: string, acao: {id:string;fechamentoId:string}) {
  const contato=(await tx.query<{cliente_id:string|null;fechamento_id:string|null}>(
    'SELECT cliente_id::text,fechamento_id::text FROM marketing_contatos WHERE empresa_id=$1::uuid AND id=$2::uuid FOR UPDATE',[empresaId,acao.id])).rows[0];
  if (!contato) naoEncontrado('Contato não encontrado nesta empresa.');
  // vincular-negociacao: a negociação herda a origem do contato (se ainda não tiver uma). Contrato herda da negociação.
  if (contato.fechamento_id && contato.fechamento_id !== acao.fechamentoId) throw new MarketingError("MARKETING_CONTATO_CONVERTIDO", "Contato já vinculado a uma negociação.", 409);
  if (!contato.cliente_id) throw new MarketingError("MARKETING_CONTATO_SEM_CLIENTE", "Vincule o contato a um cliente antes da negociação.", 409);
  const fechamento = await tx.query<{ id: string }>(
    `SELECT id::text FROM fechamentos WHERE id = $1::uuid AND empresa_id = $2::uuid AND cliente_id = $3::uuid`,
    [acao.fechamentoId, empresaId, contato.cliente_id],
  );
  if (fechamento.rows.length !== 1) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Negociação não encontrada para este cliente.", 404);
  if (contato.fechamento_id === acao.fechamentoId) return { id: acao.id, origemNegociacaoExistente: true };
  try {
    await tx.query(
      `UPDATE marketing_contatos SET fechamento_id = $2::uuid, status = 'CONVERTIDO', atualizado_por = $3::uuid, atualizado_em = clock_timestamp() WHERE id = $1::uuid`,
      [acao.id, acao.fechamentoId, usuarioId],
    );
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "marketing_contatos_fechamento_uk") {
      throw new MarketingError("MARKETING_NEGOCIACAO_JA_VINCULADA", "Esta negociação já está vinculada a outro contato.", 409);
    }
    throw error;
  }
  const origemContato = await atribuicaoVigente(tx, empresaId, "CONTATO", acao.id);
  const herdada = origemContato ? await registrarSeAusente(tx, empresaId, {
    alvoTipo: "FECHAMENTO", alvoId: acao.fechamentoId,
    origemCodigo: origemContato.origemCodigo, canalAtendimento: origemContato.canalAtendimento, campanhaId: origemContato.campanhaId,
    metodo: origemContato.metodo === "DESCONHECIDO" ? "DESCONHECIDO" : "HERDADO", detalhe: origemContato.detalhe, utm: origemContato.utm,
    contatoId: acao.id, registradoPor: usuarioId,
  }) : null;
  await registrarEventoHistorico({
    clienteId: contato.cliente_id, tipoEvento: "CONTATO_MARKETING_NEGOCIACAO", origem: "CRM_INTERNO", entidadeTipo: "FECHAMENTO", entidadeId: acao.fechamentoId,
    usuarioId, metadata: { contatoMarketingId: acao.id, origemHerdada: Boolean(herdada) },
  }, tx);
  return {id:acao.id,origemNegociacaoExistente:!herdada};
}
