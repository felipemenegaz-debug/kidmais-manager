import { preservarPrecoHistorico } from '../revisao-preco.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core.ts';

test('corrigir cadastro de importado conserva preço e itens e cria aniversariante ausente no CRM', async () => {
  const f = { id: 'f', origemFechamento: 'IMPORTACAO_HISTORICA', clienteId: 'cliente', aniversarianteId: null,
    pacoteId: 'p', convidados: 50, dataEvento: '2026-11-20', horarioInicio: '10:00', horarioFim: '14:00', configuracaoAgendaId: 'turno',
    valorTabela: 7811.50, valorAdicionais: 100, condicaoPagamento: null, valorAprovado: null };
  const r = { id: 'r', fechamento_id: 'f', contrato_versao_id: 'v2', operacao: f, estado: 'EM_ELABORACAO', revisao: 1, conteudo_hash: 'h' };
  const cliente = { id: 'cliente' }, itens = [{ adicionalId: 'historico', valorTotal: 100 }];
  let salvo: typeof f | null = null; let aniversario = false, cadastro = false;
  const mocks: Record<string, unknown> = {
    "../revisao-preco": { preservarPrecoHistorico },
    '../repositories': { empresaDoFechamentoSemTrava: async () => 'empresa', empresaDoFechamentoComTrava: async () => 'empresa', buscarFechamentoPorIdParaAtualizacao: async () => f },
    '../repositories/revisao.repository': { buscarRevisaoDaVersao: async () => r, listarItensRevisao: async () => itens,
      salvarOperacaoPreparada: async (_tx: unknown, _r: unknown, novo: typeof f, recebidos: unknown) => { salvo = novo; assert.deepEqual(recebidos, itens); return { ...r, operacao: novo }; } },
    '../../clientes/repositories': { buscarClientePorId: async () => cliente, registrarAuditoria: async () => {} },
    '../../clientes/services': { atualizarClienteInterno: async (_id: string, empresa: string) => { assert.equal(empresa, 'empresa'); cadastro = true; } },
    '../../clientes/services/aniversariante.service': { cadastrarAniversarianteInterno: async (id: string, empresa: string) => { assert.equal(id, 'cliente'); assert.equal(empresa, 'empresa'); aniversario = true; return { id: 'aniversariante' }; } },
    '../../contratos/services/snapshot-core': { hashSnapshotContrato },
    '../../disponibilidade/services': { consultarDisponibilidadeData: async () => ({ periodos: [] }), intervaloSemConflito: async () => true },
    '../../comercial/services': { calcularResumoComercial: async () => { throw Error('Correção cadastral não pode consultar preços atuais'); } },
  };
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(readFileSync('lib/fechamentos/services/revisao-operacional.service.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', code)((id: string) => mocks[id] ?? {}, exports);
  const tx = { query: async (sql: string) => ({ rows: sql.includes('kidmais019_ocupa') ? [{ ocupa: false }] : [] }) };
  const editar = exports.editarPreparacao as (tx: unknown, r: unknown, input: unknown, ctx: unknown) => Promise<unknown>;
  await editar(tx, r, { ...f, cliente: { email: 'cliente@example.invalid' }, aniversariante: { nome: 'Lia', dataNascimento: null },
    adicionais: [], motivo: 'Completar cadastro importado', fonteHash: hashSnapshotContrato({ revisao: 1, conteudo: 'h', cliente, aniversariante: null }) }, { usuarioId: 'u', empresaAutorizada: 'empresa' });
  assert(cadastro && aniversario); assert(salvo);
  assert.equal((salvo as typeof f).valorTabela, 7811.50); assert.equal((salvo as typeof f).valorAdicionais, 100);
  assert.equal((salvo as typeof f).condicaoPagamento, null);
  assert.equal((salvo as unknown as { aniversarianteId: string }).aniversarianteId, 'aniversariante');
  assert.equal(f.aniversarianteId, null, 'operação vigente permanece preservada');
});
