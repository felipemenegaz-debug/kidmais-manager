import type { DbExecutor } from '../db/contracts.ts';
import { registrarEventoHistorico } from '../clientes/repositories/historico.repository.ts';
import { perdaSchema, type Alvo } from './modelo.ts';

/** Chamador trava o alvo, prova o tenant e valida o cancelamento antes de entrar aqui. */
export async function gravarPerda(tx: DbExecutor, empresaId: string, usuarioId: string, alvo: Alvo, clienteId: string, entrada: unknown) {
  const perda = perdaSchema.parse(entrada);
  const tabela = alvo.tipo === 'CONTATO' ? 'marketing_contatos' : 'fechamentos';
  await tx.query(`UPDATE ${tabela} SET perda_motivo=$3, perda_observacao=$4, perdida_em=clock_timestamp() WHERE empresa_id=$1::uuid AND id=$2::uuid`,
    [empresaId, alvo.id, perda.motivo, perda.observacao || null]);
  await tx.query(`UPDATE oportunidades_acoes SET encerrada_em=clock_timestamp(),resultado='PERDIDA'
    WHERE empresa_id=$1::uuid AND ${alvo.tipo === 'CONTATO' ? 'contato_id' : 'fechamento_id'}=$2::uuid AND encerrada_em IS NULL`, [empresaId, alvo.id]);
  await registrarEventoHistorico({ clienteId, usuarioId, tipoEvento: 'OPORTUNIDADE_PERDIDA', origem: 'CRM_INTERNO',
    entidadeTipo: alvo.tipo, entidadeId: alvo.id, detalhe: perda.motivo, metadata: { motivo: perda.motivo, observacao: perda.observacao || null } }, tx);
}
