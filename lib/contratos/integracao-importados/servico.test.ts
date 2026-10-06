import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DbExecutor } from '../../db/contracts.ts';
import type { TenantComprovado } from '../../saas/provar-tenant.ts';
import { decisoesBase, snapshotBase } from './fixtures.ts';
import type { DecisoesIntegracao } from './modelo.ts';
import {
  conferirFinanceiro, confirmarIntegracao, instanteDoRecebimento, IntegracaoImportadoError, opcoesIntegracao, recusaDoPlanoNativo, simularFinanceiro, simularIntegracao,
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
  /** Conferência posterior: versão conferida ainda vigente, revisão aberta, obrigação nativa já existente. */
  versaoVigente: boolean; revisaoAberta: boolean; comPagamento: boolean;
  sqlVinculos: string[];
  /** Parâmetros de cada busca de possíveis duplicados. */
  paramsVinculos: Array<readonly unknown[]>;
  /** Candidatos que só aparecem a partir da 2ª consulta da mesma confirmação (commit concorrente antes do lock). */
  vinculosDepoisDoLock: Array<Record<string, unknown>> | null;
  locks: string[]; sql: string[];
  aniversarianteExistente: string | null;
};

function estadoInicial(): Estado {
  return {
    importacoes: [{ id: IMP, empresa: EMPRESA, cliente: CLIENTE, documento: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'IMPORTADA', snapshot: snapshotBase() }],
    vinculos: [], financeiros: [], inserts: [], ocupado: false, bloqueado: false, disponivel: true, vinculosCliente: [],
    contratoStatus: 'ASSINADO', fechamentoStatus: 'CONFIRMADO', locks: [], sql: [], aniversarianteExistente: null,
    versaoVigente: true, revisaoAberta: false, comPagamento: false, sqlVinculos: [], paramsVinculos: [], vinculosDepoisDoLock: null,
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
    if (sql.includes('FROM clientes')) return linhas(v[0] === CLIENTE && v[1] === EMPRESA ? [{ id: CLIENTE, nome_completo: 'Ana Souza', cpf: '52998224725', telefone: '11999990000', whatsapp: null, email: 'ana@example.invalid', cep: '01001000', logradouro: 'Rua Teste', numero: '1', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP', status: 'ATIVO' }] : []);
    if (sql.includes('FROM estabelecimentos')) return linhas(v[0] === EMPRESA ? [{ id: '22222222-2222-4222-8222-222222222222', nome: 'Unidade Centro' }] : []);
    if (sql.includes('FROM pacotes p')) return linhas([{ id: '33333333-3333-4333-8333-333333333333', codigo: 'COMPLETA', nome: 'Festa Completa', duracao_minutos: 240, ativo: true }]);
    if (sql.includes('FROM pacotes WHERE id')) return linhas(v[0] === '33333333-3333-4333-8333-333333333333' && v[1] === EMPRESA ? [{ id: v[0], codigo: 'COMPLETA', nome: 'Festa Completa', duracao_minutos: 240 }] : []);
    if (sql.includes('FROM precos_pacote pp')) return linhas([{ tabela_preco_id: '44444444-4444-4444-8444-444444444444', preco_pacote_id: '55555555-5555-4555-8555-555555555555', categoria: 'NOBRE' }]);
    if (sql.includes('FROM configuracao_agenda')) return linhas([{ id: '66666666-6666-4666-8666-666666666666' }]);
    if (sql.includes('kidmais_lock_datas_revisao')) { estado.locks.push(`data:${v[0]}`); return linhas([]); }
    if (sql.includes('AS com_pagamento') && sql.includes('AS vigente_conferida')) {
      return linhas([{ com_pagamento: estado.comPagamento, revisao_aberta: estado.revisaoAberta, vigente_conferida: estado.versaoVigente }]);
    }
    if (sql.includes('kidmais:importacao-duplicidade:')) {
      // Uma serialização por EMPRESA (a busca complementar alcança outras datas): a chave não leva a data.
      assert.equal(v.length, 1);
      estado.locks.push(`duplicidade:${v[0]}`);
      return linhas([]);
    }
    if (sql.includes('kidmais062_travar_habilitacao')) { estado.locks.push(`unidade:${v[0]}`); return linhas([]); }
    // Conflito no MESMO recurso (062): empresa comprovada e unidade escolhida vão no SQL.
    if (sql.includes('kidmais062_ocupacoes_escopo')) {
      assert.ok(sql.includes('kidmais062_mesmo_recurso($4::uuid, $5::uuid') && sql.includes('kidmais062_bloqueio_aplica(b.empresa_id, b.estabelecimento_id, $4::uuid, $5::uuid)'));
      assert.equal(v[3], EMPRESA);
      return linhas([{ ocupado: estado.ocupado, bloqueado: estado.bloqueado }]);
    }
    if (sql.includes('WITH base AS')) {
      // Candidatos da empresa comprovada, de qualquer cliente: o filtro é empresa + data + sinal.
      assert.equal(v[0], EMPRESA);
      estado.sqlVinculos.push(sql);
      estado.paramsVinculos.push(v);
      const depoisDoLock = estado.locks.some((l) => l.startsWith('duplicidade:'));
      const linhasVinculo = depoisDoLock && estado.vinculosDepoisDoLock ? estado.vinculosDepoisDoLock : estado.vinculosCliente;
      return linhas(linhasVinculo.map((l) => ({ data_evento: v[2], ...l })));
    }
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
      return linhas(v[2] === EMPRESA ? [{ contrato_status: estado.contratoStatus, fechamento_status: estado.fechamentoStatus, valor: '8500', cliente_id: CLIENTE, data_evento: '2026-11-14',
        vigente: estado.versaoVigente, revisao_aberta: estado.revisaoAberta, com_pagamento: estado.comPagamento }] : []);
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
    snapshotFechamento: async () => ({ comercial: { tabelaPreco: { id: "tabela-nativa" } } }),
    atualizarCliente: async (_tx, clienteId, empresaId, cadastro) => { reg("atualizarCliente", { clienteId, empresaId, cadastro }); },
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
const ctx = { usuarioId: USUARIO, token: 'token-sessao', requestId: '77777777-7777-4777-8777-777777777777', ip: null, userAgent: 'teste', autenticadoEm: new Date().toISOString() };
/** Sessão autenticada por senha há mais de 5 minutos (janela nativa da assinatura e do perfil). */
const ctxAntigo = { ...ctx, autenticadoEm: new Date(Date.now() - 6 * 60 * 1000).toISOString() };
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
  // Ordem única da 062: unidade (empresa → unidade → habilitação) antes da data.
  const lockUnidade = estado.locks.indexOf('unidade:22222222-2222-4222-8222-222222222222');
  const lockDuplicidade = estado.locks.indexOf(`duplicidade:${EMPRESA}`);
  assert.ok(lockUnidade >= 0 && lockUnidade < lockDuplicidade && lockDuplicidade < estado.locks.indexOf('data:2026-11-14'), 'unidade → duplicidade → data');
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
  assert.deepEqual(opcoes.integracao, { contratoId: estado.vinculos[0].contrato_id, financeiroPendente: true, caminhoFinanceiro: 'CONFERIR_HISTORICO', valorContratadoCentavos: 850000, contratoCancelado: false });

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
  assert.ok(estado.locks.includes(`duplicidade:${EMPRESA}`), 'evento passado também passa pela serialização de duplicidade');
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

test('possível duplicidade (outro cliente, mesmo aniversariante/valor): exige "é outro contrato" + motivo auditado; nunca une nem recusa sozinha', async () => {
  const estado = estadoInicial();
  // Reescaneamento do mesmo papel cadastrado em outro cliente: sinais de aniversariante e valor, não de cliente.
  estado.vinculosCliente = [{ fechamento_id: 'f1', contrato_id: 'c1', status: 'ASSINADO', horario_inicio: '14:00', horario_fim: '18:00', com_pagamento: true, importado: true, sinais: ['MESMO_ANIVERSARIANTE', 'MESMO_VALOR'] }];
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, decisoesBase(), HOJE));
  if (sim.integrada) throw new Error('inesperado');
  assert.equal(sim.pronto, false);
  assert.deepEqual(sim.possiveisVinculos.map((v) => [v.importado, v.sinais]), [[true, ['MESMO_ANIVERSARIANTE', 'MESMO_VALOR']]]);
  // A consulta não se limita ao mesmo cliente (filtra empresa e data) e recebe aniversariante, valor e documento.
  const consulta = estado.sqlVinculos[0];
  assert.ok(!/WHERE f\.empresa_id = \$1::uuid AND f\.cliente_id/.test(consulta) && /mesmo_aniversariante/.test(consulta) && /documento_sha256 = \$6/.test(consulta));
  // Só marcar não basta: sem motivo continua bloqueado.
  const semMotivo = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, decisoesBase({ outroContratoConfirmado: true }), HOJE));
  if (semMotivo.integrada) throw new Error('inesperado');
  assert.equal(semMotivo.pronto, false);
  const d = decisoesBase({ outroContratoConfirmado: true, motivoOutroContrato: 'Festa da irmã gêmea, contrato separado' });
  const chamadas: Chamada[] = [];
  const { sim: comMotivo, res } = await simularEConfirmar(estado, d, chamadas);
  assert.equal(comMotivo.pronto, true);
  assert.equal(res.reutilizado, false);
  const auditoria = chamadas.find((c) => c.metodo === 'auditoria' && (c.args as { acao: string }).acao === 'POSSIVEL_DUPLICIDADE_DESCARTADA')!.args as { justificativa: string; dadosDepois: { candidatos: Array<{ sinais: string[] }> } };
  assert.equal(auditoria.justificativa, 'Festa da irmã gêmea, contrato separado');
  assert.deepEqual(auditoria.dadosDepois.candidatos[0].sinais, ['MESMO_ANIVERSARIANTE', 'MESMO_VALOR']);
  // A decisão também fica no vínculo imutável.
  assert.equal((estado.vinculos[0].decisoes as { decisoes: { motivoOutroContrato: string } }).decisoes.motivoOutroContrato, 'Festa da irmã gêmea, contrato separado');
});

test('busca complementar: candidato em OUTRA data (mesmo documento, data lida, dia/mês trocados ou próxima com dois sinais) exige a mesma decisão explícita e auditada', async () => {
  const estado = estadoInicial();
  // Data lida no documento ≠ data decidida: o operador corrigiu a data; a outra importação ficou com a data lida.
  const d0 = decisoesBase({ evento: { data: '2026-11-21', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 }, motivos: { data: 'O contrato foi remarcado à mão no papel.' } });
  estado.vinculosCliente = [{ fechamento_id: 'f-lida', contrato_id: 'k-lida', status: 'ASSINADO', data_evento: '2026-11-14', horario_inicio: '14:00', horario_fim: '18:00', com_pagamento: false, importado: true, sinais: ['MESMO_ANIVERSARIANTE', 'DATA_DO_DOCUMENTO'] }];
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d0, HOJE));
  if (sim.integrada) throw new Error('inesperado');
  assert.equal(sim.pronto, false, 'não integra sem decisão');
  assert.deepEqual(sim.possiveisVinculos.map((v) => [v.data, v.alcance, v.sinais]), [['2026-11-14', 'OUTRA_DATA', ['MESMO_ANIVERSARIANTE', 'DATA_DO_DOCUMENTO']]]);
  assert.ok(sim.bloqueios.some((b) => /neste dia ou em data próxima/.test(b)));
  // Critério: data decidida, data lida no documento, dia/mês trocados, contato só com dígitos, janela de 90 dias.
  const p = estado.paramsVinculos[0];
  assert.deepEqual([p[0], p[2], p[6], p[7], p[8], p[9], p[10]], [EMPRESA, '2026-11-21', '2026-11-14', null, '52998224725', ['11999990000'], 90]);
  // Nunca une nem descarta sozinho: com "é outro contrato" + motivo integra e audita data e alcance do candidato.
  const d = { ...d0, outroContratoConfirmado: true, motivoOutroContrato: 'Festa do irmão, contrato separado' };
  const chamadas: Chamada[] = [];
  const { sim: comMotivo, res } = await simularEConfirmar(estado, d, chamadas);
  assert.equal(comMotivo.pronto, true);
  assert.equal(res.reutilizado, false);
  const auditoria = chamadas.find((c) => c.metodo === 'auditoria' && (c.args as { acao: string }).acao === 'POSSIVEL_DUPLICIDADE_DESCARTADA')!.args as { justificativa: string; dadosDepois: { candidatos: Array<Record<string, unknown>> } };
  assert.equal(auditoria.justificativa, 'Festa do irmão, contrato separado');
  assert.deepEqual(auditoria.dadosDepois.candidatos, [{ fechamentoId: 'f-lida', contratoId: 'k-lida', data: '2026-11-14', alcance: 'OUTRA_DATA', sinais: ['MESMO_ANIVERSARIANTE', 'DATA_DO_DOCUMENTO'] }]);
  assert.ok(estado.locks.includes(`duplicidade:${EMPRESA}`));
});

test('sem candidato de duplicidade nenhuma decisão é exigida nem auditada', async () => {
  const estado = estadoInicial(); const chamadas: Chamada[] = [];
  await simularEConfirmar(estado, decisoesBase(), chamadas);
  assert.ok(!chamadas.some((c) => c.metodo === 'auditoria' && (c.args as { acao: string }).acao === 'POSSIVEL_DUPLICIDADE_DESCARTADA'));
});

test('idempotência: a MESMA chave com outro conteúdo é recusada (409), sem escrita, na integração e na conferência de pagamentos', async () => {
  const estado = estadoInicial();
  await simularEConfirmar(estado, decisoesBase({ financeiro: { situacao: 'NAO_CONFERIDO' } }), []);
  const inserts = estado.inserts.length;
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: decisoesBase(), resumoHash: '5'.repeat(64), chave: CHAVE }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'IDEMPOTENCIA_CONFLITANTE' && e.httpStatus === 409);
  assert.equal(estado.inserts.length, inserts);
  const financeiro = { situacao: 'PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-09-01', recebimento: { data: '2026-09-01', forma: 'PIX' } }] };
  const sim = await emTransacao(estado, (tx) => simularFinanceiro(tx, tenant(), IMP, financeiro, HOJE));
  if (sim.conferido) throw new Error('inesperado');
  const chaveFin = '14141414-1414-4141-8141-141414141414';
  await emTransacao(estado, (tx) => conferirFinanceiro(tx, tenant(), ctx, IMP, { financeiro, resumoHash: sim.resumoHash, chave: chaveFin }, HOJE, coreFalso([])));
  const depois = estado.inserts.length;
  assert.ok(depois > inserts);
  await assert.rejects(emTransacao(estado, (tx) => conferirFinanceiro(tx, tenant(), ctx, IMP, { financeiro, resumoHash: '6'.repeat(64), chave: chaveFin }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'IDEMPOTENCIA_CONFLITANTE');
  assert.equal(estado.inserts.length, depois);
  assert.equal(estado.financeiros.length, 1);
});

test('autenticação recente: senha há mais de 5 minutos recusa integrar e conferir pagamentos (403), sem escrita; repetição não exige', async () => {
  const estado = estadoInicial();
  const d = decisoesBase({ financeiro: { situacao: 'NAO_CONFERIDO' } });
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d, HOJE));
  if (sim.integrada) throw new Error('inesperado');
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctxAntigo, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'REAUTENTICACAO_NECESSARIA' && e.httpStatus === 403);
  assert.equal(estado.inserts.length, 0);
  await emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso([])));
  // Repetir o pedido já gravado não escreve nada: devolve o resultado mesmo com sessão antiga.
  const repetida = await emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctxAntigo, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso([])));
  assert.equal(repetida.reutilizado, true);
  const financeiro = { situacao: 'NAO_PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-11-14', recebimento: null }] };
  const simFin = await emTransacao(estado, (tx) => simularFinanceiro(tx, tenant(), IMP, financeiro, HOJE));
  if (simFin.conferido) throw new Error('inesperado');
  const antes = estado.inserts.length;
  await assert.rejects(emTransacao(estado, (tx) => conferirFinanceiro(tx, tenant(), ctxAntigo, IMP, { financeiro, resumoHash: simFin.resumoHash, chave: '15151515-1515-4151-8151-151515151515' }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'REAUTENTICACAO_NECESSARIA');
  assert.equal(estado.inserts.length, antes);
});

test('conferência posterior de pagamentos: só na versão conferida ainda vigente, sem revisão aberta e sem obrigação nativa', async () => {
  const financeiro = { situacao: 'NAO_PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-11-14', recebimento: null }] };
  const casos: Array<[Partial<Estado>, RegExp]> = [
    [{ versaoVigente: false }, /revisado depois da integração/],
    [{ revisaoAberta: true }, /revisão do contrato em andamento/],
    [{ comPagamento: true }, /já tem obrigação financeira/],
  ];
  for (const [mudar, motivo] of casos) {
    const estado = estadoInicial();
    await simularEConfirmar(estado, decisoesBase({ financeiro: { situacao: 'NAO_CONFERIDO' } }), []);
    Object.assign(estado, mudar);
    const sim = await emTransacao(estado, (tx) => simularFinanceiro(tx, tenant(), IMP, financeiro, HOJE));
    if (sim.conferido) throw new Error('inesperado');
    assert.equal(sim.pronto, false);
    assert.match(sim.bloqueios.join(' '), motivo);
    const antes = estado.inserts.length;
    await assert.rejects(emTransacao(estado, (tx) => conferirFinanceiro(tx, tenant(), ctx, IMP, { financeiro, resumoHash: sim.resumoHash, chave: '16161616-1616-4161-8161-161616161616' }, HOJE, coreFalso([]))),
      (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'INTEGRACAO_BLOQUEADA');
    assert.equal(estado.inserts.length, antes, 'nenhuma obrigação na versão antiga');
  }
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

test('plano de pagamento segue as regras nativas (validarPlanoPagamento): parcela depois da festa SEM confirmação bloqueia integração e conferência posterior', async () => {
  const depoisDaFesta = { situacao: 'NAO_PAGO' as const, parcelas: [{ valorCentavos: 850000, vencimento: '2026-12-01', recebimento: null }] };
  const estado = estadoInicial();
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, decisoesBase({ financeiro: depoisDaFesta }), HOJE));
  if (sim.integrada) throw new Error('inesperado');
  assert.equal(sim.pronto, false);
  // Sem a confirmação explícita da exceção histórica, a regra nativa vale.
  assert.match(sim.bloqueios.join(' '), /Parcela 1: vence depois da festa. Confirme que isso consta do contrato original/);
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: decisoesBase({ financeiro: depoisDaFesta }), resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'INTEGRACAO_BLOQUEADA');
  assert.equal(estado.inserts.length, 0);
  // Conferência posterior: mesma regra, com a data da festa da contratação.
  await simularEConfirmar(estado, decisoesBase({ financeiro: { situacao: 'NAO_CONFERIDO' } }), []);
  const simFin = await emTransacao(estado, (tx) => simularFinanceiro(tx, tenant(), IMP, depoisDaFesta, HOJE));
  if (simFin.conferido) throw new Error('inesperado');
  assert.equal(simFin.pronto, false);
  assert.match(simFin.bloqueios.join(' '), /vence depois da festa/);
});

test('exceção histórica: parcela depois da festa só com confirmação explícita; vencimento nunca alterado; exceção auditada', async () => {
  const parcelas = (confirmada?: boolean) => ({ situacao: 'NAO_PAGO' as const, parcelas: [
    { valorCentavos: 300000, vencimento: '2026-11-01', recebimento: null },
    { valorCentavos: 550000, vencimento: '2026-12-15', recebimento: null, ...(confirmada === undefined ? {} : { aposFestaConfirmada: confirmada }) },
  ] });
  const estado = estadoInicial();
  for (const sem of [parcelas(), parcelas(false)]) {
    const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, decisoesBase({ financeiro: sem }), HOJE));
    if (sim.integrada) throw new Error('inesperado');
    assert.equal(sim.pronto, false);
    assert.match(sim.bloqueios.join(' '), /Parcela 2: vence depois da festa\. Confirme que isso consta do contrato original/);
  }
  const chamadas: Chamada[] = [];
  const { sim, res } = await simularEConfirmar(estado, decisoesBase({ financeiro: parcelas(true) }), chamadas);
  assert.equal(sim.pronto, true);
  assert.equal(res.reutilizado, false);
  const vencimentos = chamadas.filter((c) => c.metodo === 'criarParcela').map((c) => (c.args as { vencimento: string }).vencimento);
  assert.deepEqual(vencimentos, ['2026-11-01', '2026-12-15'], 'vencimentos gravados exatamente como confirmados');
  const excecao = chamadas.find((c) => c.metodo === 'auditoria' && (c.args as { acao: string }).acao === 'EXCECAO_HISTORICA_VENCIMENTO_APOS_FESTA')!.args as { dadosDepois: unknown; justificativa: string };
  assert.deepEqual(excecao.dadosDepois, { dataFesta: '2026-11-14', parcelas: [{ numero: 2, vencimento: '2026-12-15' }] });
  assert.match(excecao.justificativa, /conforme o contrato original, confirmado pelo operador/);
  // A decisão gravada no registro financeiro carrega a confirmação (o gatilho da 061 confere no banco).
  assert.equal(JSON.stringify(estado.inserts.find((i) => i.tabela === 'contrato_importacao_financeiro')!.valores).includes('aposFestaConfirmada'), true);
});

test('exceção histórica não relaxa as outras regras nativas do plano (soma, quantidade, primeira parcela)', () => {
  const recusa = recusaDoPlanoNativo({ situacao: 'NAO_PAGO', parcelas: [{ valorCentavos: 100000, vencimento: '2027-01-10', recebimento: null, aposFestaConfirmada: true }] }, 850000, '2026-11-14');
  assert.match(String(recusa), /fora das regras do financeiro: .*soma/i);
  // Contrato sem parcela pós-festa: nada muda.
  assert.equal(recusaDoPlanoNativo({ situacao: 'NAO_PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-11-14', recebimento: null }] }, 850000, '2026-11-14'), null);
});

test('caminho financeiro da importação integrada: obrigação existente leva ao Financeiro do contrato, nunca a "Conferir pagamentos"', async () => {
  const casos: Array<[Partial<Estado>, string, boolean]> = [
    [{}, 'CONFERIR_HISTORICO', true],
    [{ comPagamento: true }, 'CONCLUIDO', false],
    [{ revisaoAberta: true }, 'AGUARDAR_REVISAO', true],
    [{ versaoVigente: false }, 'PLANO_NA_VERSAO_VIGENTE', true],
  ];
  for (const [mudar, caminho, pendente] of casos) {
    const estado = estadoInicial();
    await simularEConfirmar(estado, decisoesBase({ financeiro: { situacao: 'NAO_CONFERIDO' } }), []);
    Object.assign(estado, mudar);
    const o = await emTransacao(estado, (tx) => opcoesIntegracao(tx, tenant(), IMP, HOJE));
    assert.deepEqual([o.integracao?.caminhoFinanceiro, o.integracao?.financeiroPendente], [caminho, pendente], JSON.stringify(mudar));
  }
  // Conferida na integração: concluído, mesmo sem consultar outra obrigação.
  const estado = estadoInicial();
  await simularEConfirmar(estado, decisoesBase(), []);
  assert.equal((await emTransacao(estado, (tx) => opcoesIntegracao(tx, tenant(), IMP, HOJE))).integracao?.caminhoFinanceiro, 'CONCLUIDO');
});

const candidato = (id: string) => ({ fechamento_id: id, contrato_id: `k-${id}`, status: 'ASSINADO', horario_inicio: '19:00', horario_fim: '21:00', com_pagamento: false, importado: true, sinais: ['MESMO_ANIVERSARIANTE', 'MESMO_VALOR'] });

test('duplicidade concorrente: candidato confirmado por outro operador antes do lock de duplicidade é visto e exige nova revisão', async () => {
  const estado = estadoInicial();
  // Evento passado: não trava a agenda — a serialização de duplicidade é que cobre.
  const d = decisoesBase({ evento: { data: '2025-05-10', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 }, motivos: { data: 'Contrato de 2025 (ano lido errado).' }, financeiro: { situacao: 'NAO_CONFERIDO' } });
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d, HOJE));
  if (sim.integrada) throw new Error('inesperado');
  assert.equal(sim.pronto, true);
  estado.vinculosDepoisDoLock = [candidato('f-concorrente')];
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'RESUMO_DESATUALIZADO' && Array.isArray(e.details?.possiveisVinculos) && (e.details!.possiveisVinculos as unknown[]).length === 1);
  assert.equal(estado.inserts.length, 0, 'nada gravado');
  // (A transação falsa desfaz o próprio registro de locks na falha; a serialização do passado é provada no teste 'evento passado'.)
});

test('decisão "é outro contrato" vale só para os candidatos revisados: candidato novo exige nova decisão', async () => {
  const estado = estadoInicial();
  estado.vinculosCliente = [candidato('f-a')];
  const d = decisoesBase({ outroContratoConfirmado: true, motivoOutroContrato: 'Festa da irmã, contrato separado', financeiro: { situacao: 'NAO_CONFERIDO' } });
  const sim = await emTransacao(estado, (tx) => simularIntegracao(tx, tenant(), IMP, d, HOJE));
  if (sim.integrada) throw new Error('inesperado');
  assert.equal(sim.pronto, true);
  estado.vinculosDepoisDoLock = [candidato('f-a'), candidato('f-b')];
  await assert.rejects(emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso([]))),
    (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'RESUMO_DESATUALIZADO');
  assert.equal(estado.inserts.length, 0);
  // Sem candidato novo, a mesma decisão confirma e é auditada com os candidatos revisados.
  estado.vinculosDepoisDoLock = null;
  const chamadas: Chamada[] = [];
  const r = await emTransacao(estado, (tx) => confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: d, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso(chamadas)));
  assert.equal(r.reutilizado, false);
  const auditoria = chamadas.find((c) => c.metodo === 'auditoria' && (c.args as { acao: string }).acao === 'POSSIVEL_DUPLICIDADE_DESCARTADA')!.args as { justificativa: string; dadosDepois: { candidatos: Array<{ fechamentoId: string }> } };
  assert.deepEqual([auditoria.justificativa, auditoria.dadosDepois.candidatos.map((c) => c.fechamentoId)], ['Festa da irmã, contrato separado', ['f-a']]);
});


test('cadastro incompleto bloqueia antes de criar contrato, festa ou financeiro', async () => {
  const estado = estadoInicial(), original = banco(estado);
  const tx: DbExecutor = { query: async <Row extends object>(sql: string, params?: readonly unknown[]) => {
    const r = await original.query<Row>(sql, params);
    if (sql.includes('FROM clientes')) for (const c of r.rows as Record<string, unknown>[]) c.cep = null;
    return r;
  } };
  const sim = await simularIntegracao(tx, tenant(), IMP, decisoesBase(), HOJE);
  assert(!sim.integrada); assert.equal(sim.pronto, false); assert.match(sim.bloqueios.join(' '), /Complete os dados do contratante/);
  await assert.rejects(confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes: decisoesBase(), resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso([])), /Complete os dados do contratante/);
  assert.equal(estado.inserts.length, 0);
});

test('cadastro conferido vai ao CRM e ao snapshot nativo sem recalcular preço nem fabricar recebimentos', async () => {
  const { cadastroBase } = await import('./fixtures.ts');
  const estado = estadoInicial(), chamadas: Chamada[] = [];
  await simularEConfirmar(estado, decisoesBase({ cadastro: { ...cadastroBase(), numero: '42' }, formaPagamento: 'PIX_AVISTA', financeiro: { situacao: 'NAO_CONFERIDO' } }), chamadas);
  const cadastro = chamadas.find(c => c.metodo === 'atualizarCliente')!.args as { empresaId: string; cadastro: { numero: string } };
  assert.equal(cadastro.empresaId, EMPRESA); assert.equal(cadastro.cadastro.numero, '42');
  const snap = JSON.parse(String(estado.inserts.find(i => i.tabela === 'contrato_versoes')!.valores[1]));
  assert.equal(snap.contratante.endereco.numero, '42');
  assert.equal(snap.comercial.tabelaPreco.id, 'tabela-nativa');
  assert.equal(snap.comercial.valorFinalContrato, 8500);
  assert.equal(snap.comercial.formaPagamentoPretendida, 'PIX_AVISTA');
  assert.deepEqual(snap.historico.contratoHistorico, snapshotBase());
  assert(!chamadas.some(c => c.metodo === 'registrarRecebimento'));
});

test('nome ausente do aniversariante bloqueia até o operador complementar', async () => {
  const estado = estadoInicial(); (estado.importacoes[0].snapshot as ReturnType<typeof snapshotBase>).evento.aniversariante = null;
  const sim = await simularIntegracao(banco(estado), tenant(), IMP, decisoesBase(), HOJE);
  assert(!sim.integrada); assert.equal(sim.pronto, false);
  assert.match(sim.bloqueios.join(' '), /nome do aniversariante/);
  const corrigido = await simularIntegracao(banco(estado), tenant(), IMP, decisoesBase({ aniversariante: 'Lia Souza' }), HOJE);
  assert(!corrigido.integrada); assert.equal(corrigido.pronto, true); assert.equal(corrigido.resumo.festa.aniversariante, 'Lia Souza');
});


test('edição concorrente no cadastro invalida a conferência antes de sobrescrever o CRM', async () => {
  const { cadastroBase } = await import('./fixtures.ts');
  const estado = estadoInicial(), original = banco(estado); let mudou = false;
  const tx: DbExecutor = { query: async <Row extends object>(sql: string, params?: readonly unknown[]) => {
    const r = await original.query<Row>(sql, params);
    if (mudou && sql.includes('FROM clientes')) for (const c of r.rows as Record<string, unknown>[]) c.email = 'novo@example.invalid';
    return r;
  } };
  const decisoes = decisoesBase({ cadastro: cadastroBase() });
  const sim = await simularIntegracao(tx, tenant(), IMP, decisoes, HOJE); assert(!sim.integrada); assert(sim.pronto);
  mudou = true;
  const chamadas: Chamada[] = [];
  await assert.rejects(confirmarIntegracao(tx, tenant(), ctx, IMP, { decisoes, resumoHash: sim.resumoHash, chave: CHAVE }, HOJE, coreFalso(chamadas)), (e: unknown) => e instanceof IntegracaoImportadoError && e.code === 'RESUMO_DESATUALIZADO');
  assert.equal(chamadas.length, 0); assert.equal(estado.inserts.length, 0);
});
