import { z } from 'zod';
import type { DbExecutor } from '../../db/contracts';
import { withTransaction } from '../../db/postgres';
import { atualizarAniversariante, bloquearNomeAniversariante, buscarAniversarianteAtivoPorNome, buscarAniversariantePorId, buscarClienteCanonicoPorId, buscarClientePorId, criarAniversariante, registrarAuditoria, registrarEventoHistorico } from '../repositories';
import { ClienteServiceError } from './errors';
import { auditoriaActor, type ClienteServiceContext } from './context';

const dadosAniversarianteSchema = z.object({
  nome: z.string().trim().min(2).max(200),
  dataNascimento: z.string().date().nullable().optional(),
  temaPadrao: z.string().trim().max(2000).nullable().optional(),
  observacoes: z.string().trim().max(2000).nullable().optional(),
}).strict();

/**
 * Cliente pai no tenant comprovado. Cliente de outra empresa, ou legado sem empresa, responde
 * como inexistente: a rota de aniversariante não contorna o GET/PATCH principal do cliente.
 */
async function clienteCanonicoParaAniversariante(clienteId: string, empresaId: string, tx: DbExecutor) {
  if (typeof empresaId !== 'string' || empresaId === '')
    throw new ClienteServiceError('AUTENTICACAO_ADMINISTRATIVA', 'Empresa administrativa não comprovada.', 403);
  await tx.query('SELECT id FROM clientes WHERE id=$1 AND empresa_id=$2::uuid FOR UPDATE', [clienteId, empresaId]);
  const original = await buscarClientePorId(clienteId, tx);
  if (!original || original.empresaId === null || original.empresaId !== empresaId)
    throw new ClienteServiceError('CLIENTE_NAO_ENCONTRADO', 'Cliente não encontrado.', 404);
  const cliente = await buscarClienteCanonicoPorId(clienteId, tx);
  if (!cliente || cliente.empresaId === null || cliente.empresaId !== empresaId)
    throw new ClienteServiceError('CLIENTE_NAO_ENCONTRADO', 'Cliente não encontrado.', 404);
  return cliente;
}

export async function cadastrarAniversarianteInterno(
  clienteId: string,
  empresaId: string,
  dados: z.input<typeof dadosAniversarianteSchema>,
  context: ClienteServiceContext,
  customDb?: DbExecutor,
) {
  const input = dadosAniversarianteSchema.parse(dados);
  const executar = async (tx: DbExecutor) => {
    const cliente = await clienteCanonicoParaAniversariante(clienteId, empresaId, tx);
    await bloquearNomeAniversariante(cliente.id, input.nome, tx);
    const duplicado = await buscarAniversarianteAtivoPorNome(cliente.id, input.nome, undefined, tx);
    if (duplicado) {
      throw new ClienteServiceError(
        'DADOS_INVALIDOS',
        'Já existe um aniversariante ativo com este nome para o Cliente. Selecione ou edite o cadastro existente.',
        409,
        { aniversarianteId: duplicado.id },
      );
    }
    const criado = await criarAniversariante({ clienteId: cliente.id, ...input, usuarioId: context.usuarioId ?? null }, tx);
    await registrarEventoHistorico({
      clienteId: cliente.id, clienteOrigemId: cliente.id, tipoEvento: 'ANIVERSARIANTE_CRIADO',
      origem: context.origem, entidadeTipo: 'ANIVERSARIANTE', entidadeId: criado.id,
      usuarioId: context.usuarioId ?? null, detalhe: 'Aniversariante cadastrado no CRM.',
    }, tx);
    await registrarAuditoria({
      clienteId: cliente.id, ...auditoriaActor(context), acao: 'ANIVERSARIANTE_CRIADO',
      entidadeTipo: 'ANIVERSARIANTE', entidadeId: criado.id,
      dadosDepois: { nome: criado.nome, dataNascimento: criado.dataNascimento, temaPadrao: criado.temaPadrao, observacoes: criado.observacoes },
      origem: context.origem, requestId: context.requestId ?? null, ip: context.ip ?? null, userAgent: context.userAgent ?? null,
    }, tx);
    return criado;
  };
  return customDb ? executar(customDb) : withTransaction(executar);
}

export async function editarAniversarianteInterno(
  clienteId: string,
  empresaId: string,
  aniversarianteId: string,
  dados: z.input<typeof dadosAniversarianteSchema>,
  context: ClienteServiceContext,
  customDb?: DbExecutor,
) {
  const input = dadosAniversarianteSchema.parse(dados);
  const executar = async (tx: DbExecutor) => {
    const cliente = await clienteCanonicoParaAniversariante(clienteId, empresaId, tx);
    await tx.query('SELECT id FROM aniversariantes WHERE id=$1 FOR UPDATE', [aniversarianteId]);
    const antes = await buscarAniversariantePorId(aniversarianteId, tx);
    if (!antes?.ativo || antes.clienteId !== cliente.id)
      throw new ClienteServiceError('DADOS_INVALIDOS', 'Aniversariante não pertence ao Cliente ou está inativo.', 409);
    await bloquearNomeAniversariante(cliente.id, input.nome, tx);
    const duplicado = await buscarAniversarianteAtivoPorNome(cliente.id, input.nome, aniversarianteId, tx);
    if (duplicado)
      throw new ClienteServiceError('DADOS_INVALIDOS', 'Já existe outro aniversariante ativo com este nome para o Cliente.', 409, { aniversarianteId: duplicado.id });
    const depois = await atualizarAniversariante(aniversarianteId, { ...input, usuarioId: context.usuarioId ?? null }, tx);
    if (!depois)
      throw new ClienteServiceError('DADOS_INVALIDOS', 'Aniversariante não pôde ser atualizado.', 409);
    await registrarEventoHistorico({
      clienteId: cliente.id, clienteOrigemId: cliente.id, tipoEvento: 'ANIVERSARIANTE_ATUALIZADO',
      origem: context.origem, entidadeTipo: 'ANIVERSARIANTE', entidadeId: depois.id,
      usuarioId: context.usuarioId ?? null, detalhe: 'Cadastro do aniversariante atualizado no CRM.',
    }, tx);
    await registrarAuditoria({
      clienteId: cliente.id, ...auditoriaActor(context), acao: 'ANIVERSARIANTE_ATUALIZADO',
      entidadeTipo: 'ANIVERSARIANTE', entidadeId: depois.id,
      dadosAntes: { nome: antes.nome, dataNascimento: antes.dataNascimento, temaPadrao: antes.temaPadrao, observacoes: antes.observacoes },
      dadosDepois: { nome: depois.nome, dataNascimento: depois.dataNascimento, temaPadrao: depois.temaPadrao, observacoes: depois.observacoes },
      origem: context.origem, requestId: context.requestId ?? null, ip: context.ip ?? null, userAgent: context.userAgent ?? null,
    }, tx);
    return depois;
  };
  return customDb ? executar(customDb) : withTransaction(executar);
}

/**
 * Correção cadastral pelo domínio de Clientes, na transação da operação chamadora.
 * `empresaId` é o tenant comprovado do chamador; o cliente pai precisa ser dessa empresa.
 */
export async function atualizarAniversarianteInterno(
  id: string,
  clienteId: string,
  empresaId: string,
  dados: { nome: string; dataNascimento: string | null },
  context: ClienteServiceContext,
  tx: DbExecutor,
) {
  const patch = z.object({ nome: z.string().trim().min(2).max(200), dataNascimento: z.string().date().nullable() }).strict().parse(dados);
  await clienteCanonicoParaAniversariante(clienteId, empresaId, tx);
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
