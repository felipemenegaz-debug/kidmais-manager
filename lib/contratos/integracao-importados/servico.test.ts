import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DbExecutor } from '../../db/contracts.ts';
import type { TenantComprovado } from '../../saas/provar-tenant.ts';
import { decisoesBase, snapshotBase } from './fixtures.ts';
import type { DecisoesIntegracao } from './modelo.ts';
import {
  conferirFinanceiro, confirmarIntegracao, instanteDoRecebimento, IntegracaoImportadoError, opcoesIntegracao, simularFinanceiro, simularIntegracao,
  type Core,
} from './servico.ts';

/**
 * Banco em memória com a semântica que o serviço usa: tenant no WHERE, vínculo único por importação, transação com
 * rollback total. Os gatilhos 019/057/061 do commit são cobertos pelo teste Postgres descartável (integracao.postgres.test.ts).
 */
const EMPRESA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IMP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLIENTE = '11111111-1111-4111-8111-111111111111';
const USUARIO = '99999999-9999-4999-8999-999999999999';
const HOJE = '2026-10-02';

type Estado = {
  importacoes: Array<{ id: string; empresa: string; cliente: string; documento: string; status: string; snapshot: unknown }>;
  vinculos: Array<Record<string, unknown>>;
  financeiros: Array<Record<string, unknown>>;
  inserts: Array<{ tabela: string; valores: readonly unknown[] }>;
  ocupado: boolean; bloqueado: boolean; disponivel: boolean;
  vinculosCliente: Array<Record<string, unknown>>;
  contratoStatus: string; fechamentoStatus: string;
  locks: string[]; sql: string[];
  aniversarianteExistente: string | null;
};

function estadoInicial(): Estado {
  return {
    importacoes: [{ id: IMP, empresa: EMPRESA, cliente: CLIENTE, documento: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'IMPORTADA', snapshot: snapshotBase() }],
    vinculos: [], financeiros: [], inserts: [], ocupado: false, bloqueado: false, disponivel: true, vinculosCliente: [],
    contratoStatus: 'ASSINADO', fechamentoStatus: 'CONFIRMADO', locks: [], sql: [], aniversarianteExistente: null,
  };
}

function banco(estado: Estado): DbExecutor & { estado: Estado } {
  let seq = 0;
  const id = (p: string) => `${p}${String(++seq).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36);
  const query = async (sql: string, v: readonly unknown[] = []) => {
    estado.sql.push(sql);
    const linhas = (rows: unknown[]) => ({ rows: rows as never[], rowCount: rows.length });
    if (sql.includes("to_regclass('public.contrato_importacoes')")) return linhas([{ ok: estado.disponivel }]);
    if (sql.includes('FROM ia_importacoes WHERE id')) {
      if (sql.includes('FOR UPDATE')) estado.locks.push(`importacao:${v[0]}`);
      return linhas(estado.importacoes.filter((i) => i.id === v[0] && i.empresa === v[1]).map((i) => ({ id: i.id, cliente_id: i.cliente, documento_id: i.documento, status: i.status, snapshot: structuredClone(i.snapshot) })));
    }
    if (sql.includes('FROM ia_documento_originais')) return linhas(v[1] === EMPRESA ? [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sha256: 'f'.repeat(64) }] : []);
    if (sql.includes('FROM clientes')) return linhas(v[0] === CLIENTE && v[1] === EMPRESA ? [{ id: CLIENTE, nome_completo: 'Ana Souza', cpf: null, telefone: '11999990000', whatsapp: null, email: null, status: 'ATIVO' }] : []);
    if (sql.includes('FROM estabelecimentos')) return linhas(v[0] === EMPRESA ? [{ id: '22222222-2222-4222-8222-222222222222', nome: 'Unidade Centro' }] : []);
    if (sql.includes('FROM pacotes p')) return linhas([{ id: '33333333-3333-4333-8333-333333333333', codigo: 'COMPLETA', nome: 'Festa Completa', duracao_minutos: 240, ativo: true }]);
    if (sql.includes('FROM pacotes WHERE id')) return linhas(v[0] === '33333333-3333-4333-8333-333333333333' && v[1] === EMPRESA ? [{ id: v[0], codigo: 'COMPLETA', nome: 'Festa Completa', duracao_minutos: 240 }] : []);
    if (sql.includes('FROM precos_pacote pp')) return linhas([{ tabela_preco_id: '44444444-4444-4444-8444-444444444444', preco_pacote_id: '55555555-5555-4555-8555-555555555555', categoria: 'NOBRE' }]);
    if (sql.includes('FROM configuracao_agenda')) return linhas([{ id: '66666666-6666-4666-8666-666666666666' }]);
    if (sql.includes('kidmais_lock_datas_revisao')) { estado.locks.push(`data:${v[0]}`); return linhas([]); }
    // Conflito no MESMO recurso (062): empresa comprovada e unidade escolhida vão no SQL.
    if (sql.includes('kidmais062_ocupacoes_escopo')) {
      assert.ok(sql.includes('kidmais062_mesmo_recurso($4::uuid, $5::uuid') && sql.includes('kidmais062_bloqueio_aplica(b.empresa_id, b.estabelecimento_id, $4::uuid, $5::uuid)'));
      assert.equal(v[3], EMPRESA);
      return linhas([{ ocupado: estado.ocupado, bloqueado: estado.bloqueado }]);
    }
    if (sql.includes('FROM fechamentos f LEFT JOIN contratos c')) return linhas(estado.vinculosCliente);
    if (sql.includes('FROM aniversariantes')) return linhas(estado.aniversarianteExistente ? [{ id: estado.aniversarianteExistente }] : []);
    if (sql.includes('kidmais061_historico_passado(ci.fechamento_id)')) {
      const ci = estado.vinculos.find((x) => x.id === v[0] && x.empresa_id === v[1]);
      if (!ci) return linhas([]);
      const f = estado.financeiros.find((x) => x.contrato_importacao_id === ci.id);
      return linhas([{ contrato_id: ci.contrato_id, fechamento_id: ci.fechamento_id, festa_id: 'festa-gravada', agenda: true, situacao: f?.situacao ?? null, recebido: f ? String(f.recebido) : null, saldo: f ? String(f.saldo) : null, pagamento_id: f?.pagamento_id ?? null }]);
    }
    if (sql.includes('FROM contrato_importacoes ci LEFT JOIN contrato_importacao_financeiro')) {
      const ci = estado.vinculos.find((x) => x.importacao_id === v[0] && x.empresa_id === v[1]);
      if (!ci) return linhas([]);
      const f = estado.financeiros.find((x) => x.contrato_importacao_id === ci.id);
      return linhas([{ id: ci.id, contrato_id: ci.contrato_id, fechamento_id: ci.fechamento_id, versao_id: ci.contrato_versao_id, payload_hash: ci.payload_hash, chave: ci.chave_idempotencia, declarado: ci.financeiro_declarado,
        fin_id: f?.id ?? null, pagamento_id: f?.pagamento_id ?? null, fin_hash: f?.payload_hash ?? null, fin_chave: f?.chave_idempotencia ?? null, valor_contratado: '8500' }]);
    }
    if (sql.includes('importacao_id <> $2::uuid')) {
      const outra = estado.vinculos.some((x) => x.chave_idempotencia === v[0] && x.importacao_id !== v[1]) || estado.financeiros.some((x) => x.chave_idempotencia === v[0]);
      return linhas([{ outra }]);
    }
    if (sql.includes('FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id JOIN contrato_versoes v')) {
      return linhas(v[2] === EMPRESA ? [{ contrato_status: estado.contratoStatus, fechamento_status: estado.fechamentoStatus, valor: '8500', cliente_id: CLIENTE }] : []);
    }
    if (sql.includes('kidmais019_bloquear_contrato') || sql.includes('kidmais019_validar_destino')) { estado.locks.push(sql.includes('validar') ? 'validar_destino' : 'bloquear_contrato'); return linhas([]); }
    const insert = sql.match(/INSERT INTO (?:public\.)?(\w+)/);
    if (insert) {
      const tabela = insert[1];
      estado.inserts.push({ tabela, valores: v });
      if (tabela === 'contrato_importacoes') {
        if (estado.vinculos.some((x) => x.importacao_id === v[1])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        const linha = { id: id('ci'), empresa_id: v[0], importacao_id: v[1], fechamento_id: v[4], contrato_id: v[5], contrato_versao_id: v[6], financeiro_declarado: v[9], decisoes: JSON.parse(String(v[10])), chave_idempotencia: v[12], payload_hash: v[13] };
        estado.vinculos.push(linha);
        return linhas([{ id: linha.id, agenda_a_partir_de: HOJE, conferido_em: '2026-10-02T12:00:00Z' }]);
      }
      if (tabela === 'contrato_importacao_financeiro') {
        const linha = { id: id('cf'), contrato_importacao_id: v[1], pagamento_id: v[2], situacao: v[3], contratado: v[4], recebido: v[5], saldo: v[6], chave_idempotencia: v[8], payload_hash: v[9] };
        estado.financeiros.push(linha);
        return linhas([{ id: linha.id }]);
      }
      return linhas([{ id: id(tabela.slice(0, 2)) }]);
    }
    throw new Error(`SQL não previsto no teste: ${sql.slice(0, 120)}`);
  };
  return { query, estado } as unknown as DbExecutor & { estado: Estado };
}

/** Transação com rollback total, como withTransaction: falha no meio não deixa nada gravado. */
async function emTransacao<T>(estado: Estado, trabalho: (tx: DbExecutor) => Promise<T>) {
  const antes = structuredClone(estado);
  try {
    return await trabalho(banco(estado));
  } catch (e) {
    Object.assign(estado, antes);
    throw e;
  }
}

type Chamada = { metodo: string; args: unknown };
function coreFalso(chamadas: Chamada[], falharNoRecebimento = false): Core {
  let n = 0;
  const reg = (metodo: string, args: unknown) => { chamadas.push({ metodo, args }); return { id: `${metodo}-${++n}` }; };
  return {
    criarFechamento: async (_tx, input) => reg('criarFechamento', input),
    registrarAuditoria: async (_tx, input) => reg('auditoria', input),
    registrarEventoHistorico: async (_tx, input) => reg('historico', input),
    criarPagamento: async (_tx, input) => reg('criarPagamento', input),
    confirmarReserva: async (_tx, id) => reg('confirmarReserva', id),
    criarPlano: async (_tx, input) => reg('criarPlano', input),
    criarParcela: async (_tx, input) => reg('criarParcela', input),
    registrarRecebimento: async (input, ctx) => {
      if (falharNoRecebimento) throw new Error('falha simulada no recebimento');
      reg('registrarRecebimento', { input, token: ctx.token, executorMesmoTx: !!ctx.executor });
      await ctx.aoConfirmar(ctx.executor);
      return { reutilizado: false };
    },
    cadastrarAniversariante: async (_tx, input) => reg('cadastrarAniversariante', input),
    chaveRecebimento: (empresa, chave) => `${empresa}:${chave}`,
    meioDoRecebimento: (f) => (f === 'CARTAO_CREDITO' || f === 'CARTAO_DEBITO' ? 'CARTAO' : f === 'BOLETO' ? 'OUTRO' : f),
    auditarRecebimento: async (_tx, empresa, ator, parcela, valor) => { reg('auditarRecebimento', { empresa, ator, parcela, valor }); },
  };
}

process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = 'true';
const tenant = (papel = 'ADMINISTRATIVO', empresa = EMPRESA): TenantComprovado => ({ empresaComprovada: empresa, membershipId: 'm', usuarioId: USUARIO, papelAtual: papel } as TenantComprovado);
const ctx = { usuarioId: USUARIO, token: 'token-sessao', requestId: '77777777-7777-4777-8777-777777777777', ip: null, userAgent: 'teste' };
const CHAVE = '88888888-8888-4888-8888-888888888888';

async function simularEConfirmar(estado: Estado, d: DecisoesIntegracao, chamadas: Chamada[], opcoes: { chave?: string; falhar?: boolean; papel?: string; empresa?: string } = {}) {
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(opcoes.papel, opcoes.empresa), IMP, d, HOJE));
  if (sim.integrada) throw new Error('já integrada');
  return { sim, res: await emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(opcoes.papel, opcoes.empresa), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: opcoes.chave ?? CHAVE }, HOJE, coreFalso(chamadas, opcoes.falhar))) };
}

const tabelas = (e: Estado) => e.inserts.map((i) => i.tabela);

test('parcialmente pago, evento futuro: Core completo, agenda travada e revalidada, recebimento histórico no ledger nativo', async () => {
  const estado = estadoInicial();
  const chamadas: Chamada[] = [];
  const { sim, res } = await simularEConfirmar(estado, decisoesBase(), chamadas);
  assert.equal(sim.pronto, true);
  assert.equal(res.reutilizado, false);
  if (res.reutilizado) return;
  assert.equal(res.agendaOcupada, true);
  assert.deepEqual(tabelas(estado), ['contratos', 'contrato_versoes', 'contrato_edicoes', 'contrato_fluxos', 'contrato_importacoes', 'festas', 'festa_eventos', 'contrato_importacao_financeiro']);
  assert.ok(estado.locks.indexOf(`importacao:${IMP}`) < estado.locks.indexOf('data:2026-11-14'), 'lock da importação antes do lock da data');
  assert.ok(estado.locks.includes('bloquear_contrato') && estado.locks.includes('validar_destino'));
  const fech = chamadas.find((c) => c.metodo === 'criarFechamento')!.args as Record<string, unknown>;
  assert.deepEqual([fech.status, fech.origemFechamento, fech.valorTabela, fech.valorAdicionais, fech.dataEvento, fech.convidados], ['CONFIRMADO', 'IMPORTACAO_HISTORICA', 8500, 500, '2026-11-14', 80]);
  // A contratação nasce na unidade conferida (recurso de agenda da 062), a mesma gravada no vínculo.
  assert.equal(fech.estabelecimentoId, '22222222-2222-4222-8222-222222222222');
  // Versão: conferência em papel com o sha256 do original — sem assinatura, OTP ou documento gerado.
  const versao = estado.inserts.find((i) => i.tabela === 'contrato_versoes')!;
  assert.equal(versao.valores[4], 'f'.repeat(64));
  assert.ok(estado.sql.find((s) => s.includes('INSERT INTO contrato_versoes'))!.includes("'CONFERENCIA_PAPEL'"));
  assert.ok(!estado.sql.some((s) => /contrato_assinaturas|validacoes_identidade_cliente|contrato_documentos/.test(s) && /INSERT/.test(s)), 'nenhuma assinatura/OTP/comprovante fabricado');
  const snap = JSON.parse(String(versao.valores[1]));
  assert.deepEqual(snap.historico.contratoHistorico, snapshotBase());
  assert.equal(snap.comercial.valorFinalContrato, 8500);
  // Financeiro nativo: obrigação, reserva já confirmada, plano 2 parcelas, 1 recebimento na data efetiva.
  // Aniversariante do documento criado no CRM do cliente e vinculado ao fechamento e ao snapshot.
  const aniv = chamadas.find((c) => c.metodo === 'cadastrarAniversariante')!.args as Record<string, unknown>;
  assert.deepEqual([aniv.clienteId, aniv.empresaId, aniv.nome, aniv.tema], [CLIENTE, EMPRESA, 'Lia', 'Fundo do mar']);
  assert.equal(fech.aniversarianteId, 'cadastrarAniversariante-1');
  assert.equal(snap.aniversariante.id, 'cadastrarAniversariante-1');
  assert.deepEqual(chamadas.filter((c) => /criar|confirmar|registrar|auditarRec/.test(c.metodo)).map((c) => c.metodo),
    ['criarFechamento', 'criarPagamento', 'confirmarReserva', 'criarPlano', 'criarParcela', 'criarParcela', 'registrarRecebimento', 'auditarRecebimento']);
  const rec = chamadas.find((c) => c.metodo === 'registrarRecebimento')!.args as { input: Record<string, unknown>; token: string; executorMesmoTx: boolean };
  assert.equal(rec.input.recebidoEm, '2026-08-03T12:00:00.000Z');
  assert.equal(rec.input.valorBruto, 2550);
  assert.equal(rec.input.chaveIdempotencia, `${EMPRESA}:importacao:${IMP}:parcela:1`);
  assert.deepEqual([rec.token, rec.executorMesmoTx], ['token-sessao', true]);
  const plano = chamadas.find((c) => c.metodo === 'criarPlano')!.args as Record<string, unknown>;
  assert.deepEqual([plano.modalidade, plano.quantidadeParcelas, plano.meioPagamento], ['PARCELADO', 2, 'PIX']);
  const fin = estado.financeiros[0];
  assert.deepEqual([fin.situacao, fin.contratado, fin.recebido, fin.saldo], ['PARCIALMENTE_PAGO', 850000, 255000, 595000]);
  assert.ok(chamadas.some((c) => c.metodo === 'auditoria' && (c.args as { acao: string }).acao === 'CONTRATO_HISTORICO_INTEGRADO'));
});

test('não pago: obrigação e parcelas a receber, nenhum recebimento; totalmente pago: todas as parcelas recebidas', async () => {
  const e1 = estadoInicial(); const c1: Chamada[] = [];
  await simularEConfirmar(e1, decisoesBase({ financeiro: { situacao: 'NAO_PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-11-14', recebimento: null }] } }), c1);
  assert.equal(c1.filter((c) => c.metodo === 'registrarRecebimento').length, 0);
  assert.equal((c1.find((c) => c.metodo === 'criarPlano')!.args as Record<string, unknown>).modalidade, 'AVISTA');
  assert.equal(e1.financeiros[0].situacao, 'NAO_PAGO');
  const e2 = estadoInicial(); const c2: Chamada[] = [];
  await simularEConfirmar(e2, decisoesBase({ financeiro: { situacao: 'PAGO', parcelas: [
    { valorCentavos: 425000, vencimento: '2026-07-01', recebimento: { data: '2026-07-01', forma: 'CARTAO_CREDITO' } },
    { valorCentavos: 425000, vencimento: '2026-08-01', recebimento: { data: '2026-08-02', forma: 'CARTAO_DEBITO' } },
  ] } }), c2);
  const recs = c2.filter((c) => c.metodo === 'registrarRecebimento').map((c) => (c.args as { input: Record<string, unknown> }).input);
  assert.deepEqual(recs.map((r) => [r.recebidoEm, r.meioPagamento]), [['2026-07-01T12:00:00.000Z', 'CARTAO'], ['2026-08-02T12:00:00.000Z', 'CARTAO']]);
  assert.equal((c2.find((c) => c.metodo === 'criarPlano')!.args as Record<string, unknown>).meioPagamento, 'CARTAO');
  assert.deepEqual([e2.financeiros[0].situacao, e2.financeiros[0].saldo], ['PAGO', 0]);
});

test('pagamento não conferido: integra sem financeiro; a pendência é concluída depois, com idempotência', async () => {
  const estado = estadoInicial(); const chamadas: Chamada[] = [];
  const { res } = await simularEConfirmar(estado, decisoesBase({ financeiro: { situacao: 'NAO_CONFERIDO' } }), chamadas);
  if (res.reutilizado) throw new Error('inesperado');
  assert.deepEqual(res.financeiro, { situacao: 'NAO_CONFERIDO', pendente: true });
  assert.equal(chamadas.filter((c) => c.metodo === 'criarPagamento').length, 0);
  assert.equal(estado.vinculos[0].financeiro_declarado, 'NAO_CONFERIDO');
  const opcoes = await emTransacao(estado, (tx) => opcoesIntegracao(tx, tenant(), IMP, HOJE));
  assert.deepEqual(opcoes.integracao, { contratoId: estado.vinculos[0].contrato_id, financeiroPendente: true, valorContratadoCentavos: 850000 });

  const financeiro = { situacao: 'PARCIALMENTE_PAGO', parcelas: [{ valorCentavos: 300000, vencimento: '2026-09-01', recebimento: { data: '2026-09-01', forma: 'BOLETO' } }, { valorCentavos: 550000, vencimento: '2026-11-14', recebimento: null }] };
  const sim = await emTransacao(estado, (tx) => simularFinanceiro(tx, tenant(), IMP, financeiro, HOJE));
  if (sim.conferido) throw new Error('inesperado');
  assert.equal(sim.pronto, true);
  const chave2 = '12121212-1212-4121-8121-121212121212';
  const c2: Chamada[] = [];
  const r = await emTransacao(estado, (tx) => conferirFinanceiro(tx, tenant(), ctx, IMP, { financeiro, resumoHash: sim.resumoHash, chave: chave2 }, HOJE, coreFalso(c2)));
  assert.equal(r.reutilizado, false);
  assert.equal((c2.find((c) => c.metodo === 'registrarRecebimento')!.args as { input: Record<string, unknown> }).input.meioPagamento, 'OUTRO');
  const repetido = await emTransacao(estado, (tx) => conferirFinanceiro(tx, tenant(), ctx, IMP, { financeiro, resumoHash: sim.resumoHash, chave: chave2 }, HOJE, coreFalso([])));
  assert.equal(repetido.reutilizado, true);
  assert.equal(estado.financeiros.length, 1);
  // Conferência diferente da já gravada (outra situação/parcelas): recusada; ajustes seguem o financeiro do contrato.
  const outra = { situacao: 'NAO_PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-11-14', recebimento: null }] };
  await assert.rejects(emTransacao(estado, (tx) => conferirFinanceiro(tx, tenant(), ctx, IMP, { financeiro: outra, resumoHash: '2'.repeat(64), chave: '34343434-3434-4343-8343-343434343434' }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'FINANCEIRO_JA_CONFERIDO');
});

test('repetir a confirmação não duplica; outra confirmação da mesma importação é recusada', async () => {
  const estado = estadoInicial(); const chamadas: Chamada[] = [];
  const d = decisoesBase();
  const { sim } = await simularEConfirmar(estado, d, chamadas);
  const inserts = estado.inserts.length;
  const repetida = await emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso(chamadas)));
  assert.equal(repetida.reutilizado, true);
  assert.equal(estado.inserts.length, inserts);
  // Outra decisão (outro conteúdo) para a mesma importação: recusada pelo vínculo único, mesmo com outra chave.
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: decisoesBase({ financeiro: { situacao: 'NAO_CONFERIDO' } }), resumoHash: '3'.repeat(64), chave: '56565656-5656-4565-8565-565656565656' }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'IMPORTACAO_JA_INTEGRADA' && e.httpStatus === 409);
  // Integrada: a simulação não reabre o assistente.
  assert.deepEqual(await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d, HOJE)), { integrada: true, contratoId: estado.vinculos[0].contrato_id });
});

test('falha no meio da transação desfaz tudo (nenhum contrato, festa ou vínculo parcial)', async () => {
  const estado = estadoInicial();
  await assert.rejects(simularEConfirmar(estado, decisoesBase(), [], { falhar: true }), /falha simulada/);
  assert.deepEqual([estado.inserts.length, estado.vinculos.length, estado.financeiros.length], [0, 0, 0]);
  // Depois da falha, a mesma confirmação funciona normalmente.
  const { res } = await simularEConfirmar(estado, decisoesBase(), []);
  assert.equal(res.reutilizado, false);
});

test('evento passado: Histórico, sem lock nem revalidação de agenda futura', async () => {
  const estado = estadoInicial(); const chamadas: Chamada[] = [];
  const d = decisoesBase({ evento: { data: '2025-05-10', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 }, motivos: { data: 'Contrato de 2025 (o OCR leu o ano errado).' },
    financeiro: { situacao: 'PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2025-05-01', recebimento: { data: '2025-05-01', forma: 'PIX' } }] } });
  estado.ocupado = true; // mesmo com o horário ocupado no passado, não há conflito para evento histórico
  const { res } = await simularEConfirmar(estado, d, chamadas);
  if (res.reutilizado) throw new Error('inesperado');
  assert.equal(res.agendaOcupada, false);
  assert.ok(!estado.locks.some((l) => l.startsWith('data:')) && !estado.locks.includes('validar_destino'));
  assert.equal((chamadas.find((c) => c.metodo === 'registrarRecebimento')!.args as { input: Record<string, unknown> }).input.recebidoEm, '2025-05-01T12:00:00.000Z');
});

test('contrato cancelado ou não comprovado: nada é gravado e não vira festa', async () => {
  for (const situacaoContrato of ['CANCELADO', 'NAO_COMPROVADA'] as const) {
    const estado = estadoInicial();
    const d = decisoesBase({ situacaoContrato });
    const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d, HOJE));
    if (sim.integrada) throw new Error('inesperado');
    assert.equal(sim.pronto, false);
    await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso([]))),
      (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'INTEGRACAO_BLOQUEADA' && e.httpStatus === 422);
    assert.equal(estado.inserts.length, 0);
  }
});

test('conflito de agenda e bloqueio: recusados na simulação e revalidados depois do lock na confirmação', async () => {
  const estado = estadoInicial();
  const d = decisoesBase();
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d, HOJE));
  if (sim.integrada) throw new Error('inesperado');
  // Outra confirmação ocupou o horário entre a simulação e o clique: o lock + revalidação recusam.
  estado.ocupado = true;
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'CONFLITO_AGENDA');
  assert.equal(estado.inserts.length, 0);
  estado.ocupado = false; estado.bloqueado = true;
  const bloqueada = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d, HOJE));
  if (bloqueada.integrada) throw new Error('inesperado');
  assert.match(bloqueada.bloqueios.join(' '), /bloqueado na agenda/);
});

test('duas confirmações concorrentes: a segunda espera o lock da importação e não duplica (mesmo conteúdo reaproveita; outro conteúdo é recusado)', async () => {
  const estado = estadoInicial();
  const d = decisoesBase();
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d, HOJE));
  if (sim.integrada) throw new Error('inesperado');
  const c1: Chamada[] = [], c2: Chamada[] = [];
  await emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso(c1)));
  const segunda = await emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: '78787878-7878-4787-8787-787878787878' }, HOJE, coreFalso(c2)));
  assert.equal(segunda.reutilizado, true);
  assert.equal(c2.length, 0, 'segunda confirmação não escreve nada');
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: decisoesBase({ outroContratoConfirmado: true }), resumoHash: '4'.repeat(64), chave: '79797979-7979-4797-8797-797979797979' }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'IMPORTACAO_JA_INTEGRADA');
  assert.equal(estado.vinculos.length, 1);
  assert.ok(estado.locks.filter((l) => l === `importacao:${IMP}`).length >= 3, 'cada confirmação travou a importação antes de decidir');
});

test('resumo desatualizado: confirmar exige exatamente o que o operador viu', async () => {
  const estado = estadoInicial();
  const d = decisoesBase();
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d, HOJE));
  if (sim.integrada) throw new Error('inesperado');
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: '0'.repeat(64), chave: CHAVE }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'RESUMO_DESATUALIZADO' && typeof e.details?.resumoHash === 'string');
  assert.equal(estado.inserts.length, 0);
});

test('isolamento: outra empresa não encontra a importação; papel sem acesso é recusado; IA não escolhe tenant', async () => {
  const estado = estadoInicial();
  await assert.rejects(emTransacao(estado, (tx) => simularIntegracao(tx, tenant('ADMINISTRATIVO', OUTRA), IMP, decisoesBase(), HOJE)),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.httpStatus === 404);
  await assert.rejects(emTransacao(estado, (tx) => opcoesIntegracao(tx, tenant('OPERADOR'), IMP, HOJE)),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.httpStatus === 403);
  // O payload não aceita empresa/tenant: campos extras são recusados pelo esquema.
  await assert.rejects(emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, { ...decisoesBase(), empresaId: OUTRA }, HOJE)));
});

test('possível vínculo: mesmo cliente com contratação no dia exige confirmar "é outro contrato" (nunca deduplica sozinho)', async () => {
  const estado = estadoInicial();
  estado.vinculosCliente = [{ fechamento_id: 'f1', contrato_id: 'c1', status: 'ASSINADO', horario_inicio: '10:00', horario_fim: '12:00', com_pagamento: true }];
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, decisoesBase(), HOJE));
  if (sim.integrada) throw new Error('inesperado');
  assert.equal(sim.pronto, false);
  assert.equal(sim.possiveisVinculos.length, 1);
  const confirmado = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, decisoesBase({ outroContratoConfirmado: true }), HOJE));
  if (confirmado.integrada) throw new Error('inesperado');
  assert.equal(confirmado.pronto, true);
});

test('sem a migration 061 a integração responde indisponível (sem tocar o Core)', async () => {
  const estado = estadoInicial();
  estado.disponivel = false;
  await assert.rejects(emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, decisoesBase(), HOJE)),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'INTEGRACAO_INDISPONIVEL' && e.httpStatus === 503);
  const opcoes = await emTransacao(estado, (tx) => opcoesIntegracao(tx, tenant(), IMP, HOJE));
  assert.equal(opcoes.disponivel, false);
});

test('instante do recebimento: meio-dia UTC da data efetiva, nunca no futuro', () => {
  assert.equal(instanteDoRecebimento('2026-08-03', new Date('2026-10-02T15:00:00Z')), '2026-08-03T12:00:00.000Z');
  assert.equal(instanteDoRecebimento('2026-10-02', new Date('2026-10-02T11:00:00Z')), '2026-10-02T11:00:00.000Z');
});

test('aniversariante já cadastrado no cliente com o mesmo nome é reaproveitado (nada é criado)', async () => {
  const estado = estadoInicial();
  estado.aniversarianteExistente = 'abababab-abab-4bab-8bab-abababababab';
  const chamadas: Chamada[] = [];
  const { sim } = await simularEConfirmar(estado, decisoesBase(), chamadas);
  assert.equal(sim.resumo.festa.aniversarianteCadastro, 'EXISTENTE');
  assert.equal(chamadas.filter((c) => c.metodo === 'cadastrarAniversariante').length, 0);
  assert.equal((chamadas.find((c) => c.metodo === 'criarFechamento')!.args as Record<string, unknown>).aniversarianteId, 'abababab-abab-4bab-8bab-abababababab');
});

test('idempotência: repetição após timeout (mesma chave) e reenvio do mesmo conteúdo (outra chave) devolvem o resultado gravado', async () => {
  const estado = estadoInicial(); const chamadas: Chamada[] = [];
  const d = decisoesBase();
  const { sim } = await simularEConfirmar(estado, d, chamadas);
  const inserts = estado.inserts.length, recebimentos = chamadas.filter((c) => c.metodo === 'registrarRecebimento').length;
  for (const chave of [CHAVE, '90909090-9090-4909-8909-909090909090']) {
    const r = await emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave }, HOJE, coreFalso(chamadas)));
    if (!r.reutilizado) throw new Error('deveria reutilizar');
    assert.equal(r.festaId, 'festa-gravada');
    assert.equal(r.agendaOcupada, true);
    assert.deepEqual({ ...r.financeiro, pagamentoId: undefined }, { situacao: 'PARCIALMENTE_PAGO', pendente: false, pagamentoId: undefined, recebidoCentavos: 255000, saldoCentavos: 595000 });
    assert.match(String((r.financeiro as { pagamentoId?: string }).pagamentoId), /^criarPagamento-/);
  }
  assert.equal(estado.inserts.length, inserts, 'nada novo gravado');
  assert.equal(chamadas.filter((c) => c.metodo === 'registrarRecebimento').length, recebimentos, 'nenhum recebimento duplicado');
  // Conteúdo diferente com outra chave: recusado, sem escrita.
  const outro = decisoesBase({ outroContratoConfirmado: true });
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: outro, resumoHash: '1'.repeat(64), chave: '91919191-9191-4919-8919-919191919191' }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'IMPORTACAO_JA_INTEGRADA');
});

test('financeiro: repetição após timeout (mesma chave ou mesmo conteúdo) devolve o resultado existente sem novo recebimento', async () => {
  const estado = estadoInicial();
  await simularEConfirmar(estado, decisoesBase({ financeiro: { situacao: 'NAO_CONFERIDO' } }), []);
  const financeiro = { situacao: 'PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-09-01', recebimento: { data: '2026-09-01', forma: 'PIX' } }] };
  const sim = await emTransacao(estado, (tx) => simularFinanceiro(tx, tenant(), IMP, financeiro, HOJE));
  if (sim.conferido) throw new Error('inesperado');
  const c1: Chamada[] = [];
  await emTransacao(estado, (tx) => conferirFinanceiro(tx, tenant(), ctx, IMP, { financeiro, resumoHash: sim.resumoHash, chave: '12121212-1212-4121-8121-121212121212' }, HOJE, coreFalso(c1)));
  assert.equal(c1.filter((c) => c.metodo === 'registrarRecebimento').length, 1);
  for (const chave of ['12121212-1212-4121-8121-121212121212', '13131313-1313-4131-8131-131313131313']) {
    const c2: Chamada[] = [];
    const r: { reutilizado: boolean; situacao?: string } = await emTransacao(estado, (tx) => conferirFinanceiro(tx, tenant(), ctx, IMP, { financeiro, resumoHash: sim.resumoHash, chave }, HOJE, coreFalso(c2)));
    assert.equal(r.reutilizado, true);
    assert.equal(r.situacao, 'PAGO');
    assert.equal(c2.length, 0, 'nenhuma escrita na repetição');
  }
  assert.equal(estado.financeiros.length, 1);
});

test('chave de ativação desligada: integração indisponível mesmo com a 061 (recuperação sem desfazer schema)', async () => {
  const estado = estadoInicial();
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = 'false';
  try {
    await assert.rejects(emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, decisoesBase(), HOJE)),
      (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'INTEGRACAO_INDISPONIVEL' && e.httpStatus === 503);
    assert.equal((await emTransacao(estado, (tx) => opcoesIntegracao(tx, tenant(), IMP, HOJE))).disponivel, false);
    assert.equal(estado.inserts.length, 0);
  } finally {
    process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = 'true';
  }
});
