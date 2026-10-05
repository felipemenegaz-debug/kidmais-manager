import { carregarSnapshot } from '../services/contrato.service';
import { buscarFechamentoPorId } from '../../fechamentos/repositories';
import { atualizarClienteInterno } from '../../clientes/services/cliente.service';
import { registrarAuditoria } from '../../clientes/repositories/auditoria.repository';
import { registrarEventoHistorico } from '../../clientes/repositories/historico.repository';
import { cadastrarAniversarianteInterno } from '../../clientes/services/aniversariante.service';
import { criarFechamento } from '../../fechamentos/repositories/fechamento.repository';
import type { CreateFechamentoInput } from '../../fechamentos/repositories/models';
import { formaParaRecebimento } from '../../financeiro/calculos';
import { chaveNoTenant } from '../../financeiro/idempotencia';
import { auditarRecebimento } from '../../financeiro/servico';
import { criarPagamento, criarParcelaPagamento, criarPlanoPagamento, marcarReservaPagamento } from '../../pagamentos/repositories/pagamento.repository';
import { registrarRecebimentoPagamento } from '../../pagamentos/services/pagamento.service';
import type { Core } from './servico';

/** Porta `Core` ligada aos repositórios e serviços nativos, sempre no executor da transação do tenant. */
export const coreNativo: Core = {
  snapshotFechamento: async (tx, fechamentoId) => { const f = await buscarFechamentoPorId(fechamentoId, tx); if (!f) throw Error("Fechamento da integração não encontrado."); return { ...(await carregarSnapshot(f, tx)).snapshot }; },
  atualizarCliente: async (tx, clienteId, empresaId, cadastro, ctx) => { await atualizarClienteInterno(clienteId, empresaId, cadastro, { ...ctx, origem: "CRM_INTERNO" }, tx); },
  criarFechamento: async (tx, input) => criarFechamento(input as unknown as CreateFechamentoInput, tx),
  registrarAuditoria: (tx, input) => registrarAuditoria(input, tx),
  registrarEventoHistorico: (tx, input) => registrarEventoHistorico(input, tx),
  criarPagamento: (tx, input) => criarPagamento(input, tx),
  confirmarReserva: (tx, pagamentoId) => marcarReservaPagamento(pagamentoId, 'CONFIRMADA', tx),
  criarPlano: (tx, input) => criarPlanoPagamento(input, tx),
  criarParcela: (tx, input) => criarParcelaPagamento(input, tx),
  registrarRecebimento: (input, ctx) => registrarRecebimentoPagamento(input, ctx),
  // Origem do CRM como na composição da importação (cadastro interno); a integração fica na auditoria própria.
  cadastrarAniversariante: async (tx, input, ctx) => ({ id: (await cadastrarAniversarianteInterno(input.clienteId, input.empresaId, { nome: input.nome, temaPadrao: input.tema }, { ...ctx, origem: 'CRM_INTERNO' }, tx)).id }),
  chaveRecebimento: (empresaId, chave) => chaveNoTenant(empresaId, 'recebimento', chave),
  meioDoRecebimento: formaParaRecebimento,
  auditarRecebimento,
};
