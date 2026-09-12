import { z } from 'zod';
import type { DbExecutor } from '../../db/contracts';
import { atualizarAniversariante, buscarAniversariantePorId, registrarAuditoria } from '../repositories';
import { ClienteServiceError } from './errors';
import type { ClienteServiceContext } from './context';

/** Correção cadastral pelo domínio de Clientes, na transação da operação chamadora. */
export async function atualizarAniversarianteInterno(
  id: string,
  clienteId: string,
  dados: { nome: string; dataNascimento: string | null },
  context: ClienteServiceContext,
  tx: DbExecutor,
) {
  const patch = z.object({ nome: z.string().trim().min(2).max(200), dataNascimento: z.string().date().nullable() }).strict().parse(dados);
  await tx.query('SELECT id FROM aniversariantes WHERE id=$1 FOR UPDATE', [id]);
  const antes = await buscarAniversariantePorId(id, tx);
  if (!antes?.ativo || antes.clienteId !== clienteId) {
    throw new ClienteServiceError('DADOS_INVALIDOS', 'Aniversariante não pertence ao contratante ou está inativo.', 409);
  }
  const depois = await atualizarAniversariante(id, { ...patch, usuarioId: context.usuarioId }, tx);
  await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: context.usuarioId, clienteId,
    acao: 'ALTERACAO_ADMINISTRATIVA', entidadeTipo: 'ANIVERSARIANTE', entidadeId: id,
    origem: context.origem, dadosAntes: antes, dadosDepois: depois,
    requestId: context.requestId, ip: context.ip, userAgent: context.userAgent }, tx);
  return depois;
}
