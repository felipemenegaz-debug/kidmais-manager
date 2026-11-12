import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import * as calculos from './calculos.ts';
import * as abertura from './abertura.ts';
import type { AberturaVigente, MovimentoCaixa } from './abertura.ts';
import type { DbExecutor } from '../db/contracts.ts';

/**
 * P2 fase B — escritor com banco simulado. O leitor da fase A (`servico.ts`) é simulado só nas quatro funções que o
 * escritor usa; cálculo, hashes e pendências são os reais. Concorrência real fica em `escritor-p2.postgres.test.ts`.
 */
const EMPRESA = '11111111-1111-4111-8111-111111111111';
const ATOR = '22222222-2222-4222-8222-222222222222';
const ENTRADA = '33333333-3333-4333-8333-333333333333';
const CONTA = '44444444-4444-4444-8444-444444444444';
const SAIDA = '55555555-5555-4555-8555-555555555555';
const HOJE = '2026-11-10';
const FLAGS = ['FINANCEIRO_LIQUIDACAO_ATIVA', 'FINANCEIRO_REVERSAO_ATIVA', 'FINANCEIRO_ABERTURA_ATIVA'];

type Linha = Record<string, unknown>;
type Resposta = { rows: Linha[]; rowCount: number };
type Regra = [RegExp, (valores: unknown[]) => Linha[] | Error];

/** Banco simulado: a primeira regra cujo padrão casa responde; sem regra, devolve vazio. Guarda todas as consultas. */
function banco(regras: Regra[]) {
  const consultas: Array<{ sql: string; valores: unknown[] }> = [];
  return {
    consultas,
    tx: {
      async query(sql: string, valores: unknown[] = []): Promise<Resposta> {
        consultas.push({ sql, valores });
        for (const [padrao, responder] of regras) {
          if (!padrao.test(sql)) continue;
          const r = responder(valores);
          if (r instanceof Error) throw r;
          return { rows: r, rowCount: r.length };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as DbExecutor,
    feitas: (padrao: RegExp) => consultas.filter((c) => padrao.test(c.sql)),
  };
}

type Leitor = {
  esquema?: { movimentos: boolean; abertura: boolean };
  vigente?: AberturaVigente | null;
  movimentos?: MovimentoCaixa[];
  conferidos?: Map<string, string>;
};

function carregar(leitor: Leitor = {}) {
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync('lib/financeiro/escritor-p2.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const deps: Record<string, unknown> = {
    'node:crypto': crypto,
    '../comercial/pacotes-admin.ts': { PacoteAdminError },
    './calculos.ts': calculos,
    './abertura.ts': abertura,
    './servico.ts': {
      esquemaP2: async () => leitor.esquema ?? { movimentos: true, abertura: true },
      aberturaVigente: async () => leitor.vigente ?? null,
      conferidosDaAbertura: async () => leitor.conferidos ?? new Map(),
      movimentosCaixa: async (_tx: unknown, _e: string, de: string, ate: string) =>
        (leitor.movimentos ?? []).filter((m) => (!de || m.data >= de) && (!ate || m.data <= ate)),
    },
  };
  new Function('require', 'exports', js)((id: string) => { assert(id in deps, `Dependência não simulada: ${id}`); return deps[id]; }, exports);
  return exports as unknown as typeof import('./escritor-p2.ts');
}

function ligar(...nomes: string[]) {
  for (const f of FLAGS) delete process.env[f];
  for (const f of nomes) process.env[f] = 'true';
}

async function recusa(promessa: Promise<unknown>, codigo: string, status = 409) {
  await assert.rejects(promessa, (erro: unknown) => {
    assert.ok(erro instanceof PacoteAdminError, String(erro));
    assert.equal(erro.code, codigo);
    assert.equal(erro.httpStatus, status);
    return true;
  });
}

const repetida = () => Object.assign(new Error('duplicate key'), { code: '23505' });

// ---------------------------------------------------------------------------------------------------------------------
// Guarda por operação
// ---------------------------------------------------------------------------------------------------------------------

test('flags: só o texto exato "true" liga, cada operação tem a sua, padrão desligado', () => {
  const { escritaP2Ligada, operacoesP2 } = carregar();
  assert.equal(escritaP2Ligada('LIQUIDACAO', {}), false);
  assert.equal(escritaP2Ligada('LIQUIDACAO', { FINANCEIRO_LIQUIDACAO_ATIVA: ' true ' }), true);
  for (const valor of ['1', 'TRUE', 'yes', 'on', '']) assert.equal(escritaP2Ligada('REVERSAO', { FINANCEIRO_REVERSAO_ATIVA: valor }), false);
  assert.deepEqual(operacoesP2({ FINANCEIRO_ABERTURA_ATIVA: 'true' }), { liquidacao: false, reversao: false, abertura: true });
});

test('operação desligada recusa antes de qualquer leitura do banco; ligada sem schema também recusa', async () => {
  const mod = carregar();
  ligar();
  const b = banco([]);
  const pedido = { entradaId: ENTRADA, valor: 10, data: HOJE, forma: 'PIX' as const, chave: 'chave-liq-0001' };
  await recusa(mod.liquidarEntradaManual(b.tx, EMPRESA, ATOR, HOJE, pedido), 'OPERACAO_DESLIGADA');
  await recusa(mod.reverterPagamentoConta(b.tx, EMPRESA, ATOR, HOJE, { contaId: CONTA, saidaId: SAIDA, valor: 1, data: HOJE, motivo: 'erro', chave: 'chave-rev-0001' }), 'OPERACAO_DESLIGADA');
  await recusa(mod.confirmarAbertura(b.tx, EMPRESA, ATOR, { dataBase: HOJE, saldo: 0, justificativa: 'abc', versaoEsperada: 0, conjuntoHash: '0'.repeat(64), chave: 'chave-ab-0001' }), 'OPERACAO_DESLIGADA');
  assert.equal(b.consultas.length, 0);

  ligar(...FLAGS);
  const semSchema = carregar({ esquema: { movimentos: false, abertura: false } });
  await recusa(semSchema.liquidarEntradaManual(b.tx, EMPRESA, ATOR, HOJE, pedido), 'OPERACAO_DESLIGADA');
  assert.equal(b.consultas.length, 0);
  // Ligar uma não liga a outra.
  ligar('FINANCEIRO_ABERTURA_ATIVA');
  await recusa(mod.liquidarEntradaManual(b.tx, EMPRESA, ATOR, HOJE, pedido), 'OPERACAO_DESLIGADA');
});

// ---------------------------------------------------------------------------------------------------------------------
// Liquidação
// ---------------------------------------------------------------------------------------------------------------------

const PEDIDO_LIQ = { entradaId: ENTRADA, valor: 100, data: '2026-11-09', forma: 'PIX' as const, taxa: 2, observacao: ' parte ', chave: 'chave-liq-0001' };
const LIQ_GRAVADA = { id: 'liq-1', entrada_id: ENTRADA, valor: '100.00', taxa: '2.00', recebido_em: '2026-11-09', forma: 'PIX', observacao: 'parte' };

function bancoLiquidacao(opcoes: { chave?: Linha[]; aposTrava?: Linha[]; entrada?: Linha | null; recebido?: string; insert?: () => Linha[] | Error } = {}) {
  let releituras = 0;
  return banco([
    [/FROM financeiro_entradas_liquidacoes\s+WHERE empresa_id = \$1::uuid AND chave_idempotencia/, () => { releituras++; return releituras === 1 ? opcoes.chave ?? [] : releituras === 2 ? opcoes.aposTrava ?? [] : [LIQ_GRAVADA]; }],
    [/FROM financeiro_entradas_manuais/, (v) => (v[1] === EMPRESA && opcoes.entrada !== null ? [opcoes.entrada ?? { valor: '300.00', recebido_em: null, descricao: 'Locação' }] : [])],
    [/SUM\(valor\)/, () => [{ recebido: opcoes.recebido ?? '0' }]],
    [/INSERT INTO financeiro_entradas_liquidacoes/, () => (opcoes.insert ? opcoes.insert() : [{ id: 'liq-1' }])],
  ]);
}

test('liquidação parcial: trava a entrada, grava em savepoint com os valores certos e audita', async () => {
  ligar(...FLAGS);
  const b = bancoLiquidacao();
  const r = await carregar().liquidarEntradaManual(b.tx, EMPRESA, ATOR, HOJE, PEDIDO_LIQ);
  assert.deepEqual(r, { reutilizado: false, id: 'liq-1' });
  assert.match(b.feitas(/FROM financeiro_entradas_manuais/)[0].sql, /FOR UPDATE/);
  const insert = b.feitas(/INSERT INTO financeiro_entradas_liquidacoes/)[0];
  assert.deepEqual(insert.valores, [EMPRESA, ENTRADA, '100.00', '2.00', '2026-11-09', 'PIX', 'parte', 'chave-liq-0001', ATOR]);
  assert.equal(b.feitas(/SAVEPOINT liquidacao_idempotente/).length, 2, 'savepoint e release');
  assert.equal(b.feitas(/INSERT INTO financeiro_auditoria/)[0].valores[1], 'ENTRADA_LIQUIDADA');
});

test('liquidação: a mesma chave devolve o mesmo resultado; chave com outro conteúdo é 409', async () => {
  ligar(...FLAGS);
  const igual = bancoLiquidacao({ chave: [LIQ_GRAVADA] });
  assert.deepEqual(await carregar().liquidarEntradaManual(igual.tx, EMPRESA, ATOR, HOJE, PEDIDO_LIQ), { reutilizado: true, id: 'liq-1' });
  assert.equal(igual.feitas(/INSERT/).length, 0);
  assert.equal(igual.feitas(/FROM financeiro_entradas_manuais/).length, 0, 'repetida não trava nem relê a entrada');
  const outra = bancoLiquidacao({ chave: [{ ...LIQ_GRAVADA, valor: '99.00' }] });
  await recusa(carregar().liquidarEntradaManual(outra.tx, EMPRESA, ATOR, HOJE, PEDIDO_LIQ), 'IDEMPOTENCIA_CONFLITANTE');
});

test('liquidação: corrida na mesma chave (23505) volta ao savepoint e devolve a linha vencedora', async () => {
  ligar(...FLAGS);
  const b = bancoLiquidacao({ insert: () => repetida() });
  const r = await carregar().liquidarEntradaManual(b.tx, EMPRESA, ATOR, HOJE, PEDIDO_LIQ);
  assert.deepEqual(r, { reutilizado: true, id: 'liq-1' });
  assert.equal(b.feitas(/ROLLBACK TO SAVEPOINT liquidacao_idempotente/).length, 1);
  assert.equal(b.feitas(/INSERT INTO financeiro_auditoria/).length, 0, 'não audita duas vezes');
});

test('liquidação: recusa data futura de Brasília, taxa acima do valor, saldo excedido e entrada legada já recebida', async () => {
  ligar(...FLAGS);
  const mod = carregar();
  await recusa(mod.liquidarEntradaManual(bancoLiquidacao().tx, EMPRESA, ATOR, HOJE, { ...PEDIDO_LIQ, data: '2026-11-11' }), 'DADOS_INVALIDOS');
  await recusa(mod.liquidarEntradaManual(bancoLiquidacao().tx, EMPRESA, ATOR, HOJE, { ...PEDIDO_LIQ, taxa: 100.01 }), 'DADOS_INVALIDOS');
  await recusa(mod.liquidarEntradaManual(bancoLiquidacao({ recebido: '250.00' }).tx, EMPRESA, ATOR, HOJE, PEDIDO_LIQ), 'VALOR_EXCEDE_SALDO');
  await recusa(mod.liquidarEntradaManual(bancoLiquidacao({ entrada: { valor: '300.00', recebido_em: '2026-10-01', descricao: 'x' } }).tx, EMPRESA, ATOR, HOJE, PEDIDO_LIQ), 'JA_RECEBIDA');
  // Exatamente o saldo passa (total).
  const total = bancoLiquidacao({ recebido: '200.00' });
  assert.equal((await mod.liquidarEntradaManual(total.tx, EMPRESA, ATOR, HOJE, PEDIDO_LIQ)).reutilizado, false);
});

test('liquidação: entrada de outra empresa é 404 e nada é gravado', async () => {
  ligar(...FLAGS);
  const b = bancoLiquidacao();
  await recusa(carregar().liquidarEntradaManual(b.tx, '99999999-9999-4999-8999-999999999999', ATOR, HOJE, PEDIDO_LIQ), 'NAO_ENCONTRADO', 404);
  assert.equal(b.feitas(/INSERT/).length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Reversão
// ---------------------------------------------------------------------------------------------------------------------

const PEDIDO_REV = { contaId: CONTA, saidaId: SAIDA, valor: 40, data: '2026-11-09', motivo: ' pago em duplicidade ', chave: 'chave-rev-0001' };
const REV_GRAVADA = { id: 'rev-1', saida_id: SAIDA, conta_id: CONTA, valor: '40.00', revertido_em: '2026-11-09', motivo: 'pago em duplicidade' };

function bancoReversao(opcoes: { chave?: Linha[]; aposTrava?: Linha[]; conta?: boolean; saida?: Linha | null; insert?: () => Linha[] | Error } = {}) {
  let releituras = 0;
  return banco([
    [/FROM financeiro_saidas_reversoes rev\s+JOIN/, () => { releituras++; return releituras === 1 ? opcoes.chave ?? [] : releituras === 2 ? opcoes.aposTrava ?? [] : [REV_GRAVADA]; }],
    [/FROM financeiro_contas_pagar/, (v) => (v[1] === EMPRESA && opcoes.conta !== false ? [{ descricao: 'Buffet' }] : [])],
    [/FROM financeiro_saidas saida\s+WHERE/, (v) => (v[2] === EMPRESA && v[1] === CONTA && opcoes.saida !== null ? [opcoes.saida ?? { valor: '100.00', pago_em: '2026-11-01', revertido: '0' }] : [])],
    [/INSERT INTO financeiro_saidas_reversoes/, () => (opcoes.insert ? opcoes.insert() : [{ id: 'rev-1' }])],
  ]);
}

test('reversão: trava a conta (mesma trava do pagamento), grava, audita e devolve o id', async () => {
  ligar(...FLAGS);
  const b = bancoReversao();
  assert.deepEqual(await carregar().reverterPagamentoConta(b.tx, EMPRESA, ATOR, HOJE, PEDIDO_REV), { reutilizado: false, id: 'rev-1' });
  assert.match(b.feitas(/FROM financeiro_contas_pagar/)[0].sql, /FOR UPDATE/);
  assert.deepEqual(b.feitas(/INSERT INTO financeiro_saidas_reversoes/)[0].valores, [EMPRESA, SAIDA, '40.00', '2026-11-09', 'pago em duplicidade', 'chave-rev-0001', ATOR]);
  assert.equal(b.feitas(/INSERT INTO financeiro_auditoria/)[0].valores[1], 'PAGAMENTO_REVERTIDO');
  // A trava da conta vem antes da leitura da soma das reversões.
  const ordem = b.consultas.map((c) => c.sql);
  assert.ok(ordem.findIndex((s) => /financeiro_contas_pagar/.test(s)) < ordem.findIndex((s) => /FROM financeiro_saidas saida/.test(s)));
});

test('reversão: idempotente, 409 em chave com outro conteúdo, corrida 23505 devolve a vencedora', async () => {
  ligar(...FLAGS);
  const mod = carregar();
  assert.deepEqual(await mod.reverterPagamentoConta(bancoReversao({ chave: [REV_GRAVADA] }).tx, EMPRESA, ATOR, HOJE, PEDIDO_REV), { reutilizado: true, id: 'rev-1' });
  await recusa(mod.reverterPagamentoConta(bancoReversao({ chave: [{ ...REV_GRAVADA, saida_id: CONTA }] }).tx, EMPRESA, ATOR, HOJE, PEDIDO_REV), 'IDEMPOTENCIA_CONFLITANTE');
  const corrida = bancoReversao({ insert: () => repetida() });
  assert.deepEqual(await mod.reverterPagamentoConta(corrida.tx, EMPRESA, ATOR, HOJE, PEDIDO_REV), { reutilizado: true, id: 'rev-1' });
});

test('reversão: recusa data futura, data anterior ao pagamento, motivo curto e soma acima do pagamento', async () => {
  ligar(...FLAGS);
  const mod = carregar();
  await recusa(mod.reverterPagamentoConta(bancoReversao().tx, EMPRESA, ATOR, HOJE, { ...PEDIDO_REV, data: '2026-11-11' }), 'DADOS_INVALIDOS');
  await recusa(mod.reverterPagamentoConta(bancoReversao().tx, EMPRESA, ATOR, HOJE, { ...PEDIDO_REV, data: '2026-10-31' }), 'DADOS_INVALIDOS');
  await recusa(mod.reverterPagamentoConta(bancoReversao().tx, EMPRESA, ATOR, HOJE, { ...PEDIDO_REV, motivo: '  a ' }), 'DADOS_INVALIDOS');
  await recusa(mod.reverterPagamentoConta(bancoReversao({ saida: { valor: '100.00', pago_em: '2026-11-01', revertido: '60.01' } }).tx, EMPRESA, ATOR, HOJE, PEDIDO_REV), 'VALOR_EXCEDE_PAGAMENTO');
  const resto = bancoReversao({ saida: { valor: '100.00', pago_em: '2026-11-01', revertido: '60.00' } });
  assert.equal((await mod.reverterPagamentoConta(resto.tx, EMPRESA, ATOR, HOJE, PEDIDO_REV)).reutilizado, false, 'exatamente o restante passa');
});

test('reversão: conta de outra empresa ou pagamento de outra conta é 404', async () => {
  ligar(...FLAGS);
  const mod = carregar();
  await recusa(mod.reverterPagamentoConta(bancoReversao({ conta: false }).tx, EMPRESA, ATOR, HOJE, PEDIDO_REV), 'NAO_ENCONTRADO', 404);
  await recusa(mod.reverterPagamentoConta(bancoReversao({ saida: null }).tx, EMPRESA, ATOR, HOJE, PEDIDO_REV), 'NAO_ENCONTRADO', 404);
});

test('retry da mesma chave que esperou a trava devolve a gravação da primeira, sem julgar saldo de novo', async () => {
  ligar(...FLAGS);
  const mod = carregar();
  // A primeira levou o saldo todo; a segunda (mesma chave) acorda depois do commit dela.
  const liq = bancoLiquidacao({ aposTrava: [LIQ_GRAVADA], recebido: '300.00' });
  assert.deepEqual(await mod.liquidarEntradaManual(liq.tx, EMPRESA, ATOR, HOJE, PEDIDO_LIQ), { reutilizado: true, id: 'liq-1' });
  assert.equal(liq.feitas(/INSERT/).length, 0);
  const rev = bancoReversao({ aposTrava: [REV_GRAVADA], saida: { valor: '100.00', pago_em: '2026-11-01', revertido: '100.00' } });
  assert.deepEqual(await mod.reverterPagamentoConta(rev.tx, EMPRESA, ATOR, HOJE, PEDIDO_REV), { reutilizado: true, id: 'rev-1' });
  assert.equal(rev.feitas(/INSERT/).length, 0);
  await recusa(mod.liquidarEntradaManual(bancoLiquidacao({ aposTrava: [{ ...LIQ_GRAVADA, forma: 'DINHEIRO' }] }).tx, EMPRESA, ATOR, HOJE, PEDIDO_LIQ), 'IDEMPOTENCIA_CONFLITANTE');
});

// ---------------------------------------------------------------------------------------------------------------------
// Abertura
// ---------------------------------------------------------------------------------------------------------------------

function mov(tipo: MovimentoCaixa['tipo'], n: number, data: string, centavos: number): MovimentoCaixa {
  return { tipo, origemId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, data, centavos, taxaCentavos: 0, estado: 'EFETIVO', descricao: 'x', festaId: null, forma: 'PIX' };
}
const MOVS = [mov('RECEBIMENTO', 1, '2026-11-05', 50_000), mov('SAIDA', 2, '2026-11-08', -20_000), mov('RECEBIMENTO', 3, HOJE, 10_000)];

function bancoAbertura(opcoes: { chave?: Linha[]; ja?: Linha[]; seq?: number } = {}) {
  return banco([
    [/now\(\) AT TIME ZONE 'America\/Sao_Paulo'/, () => [{ hoje: HOJE }]],
    [/FROM financeiro_aberturas\s+WHERE empresa_id = \$1::uuid AND chave_idempotencia/, () => opcoes.chave ?? []],
    [/INSERT INTO financeiro_aberturas/, () => [{ id: 'ab-novo' }]],
    [/conf\.chave_idempotencia LIKE \$2/, () => opcoes.ja ?? []],
    [/MAX\(sequencia\)/, () => [{ proxima: opcoes.seq ?? 2 }]],
  ]);
}

test('prévia: janela de D0 até ontem, hash do conjunto e movimento até hoje; D0 = hoje dá janela vazia', async () => {
  ligar(...FLAGS);
  const mod = carregar({ movimentos: MOVS });
  const l = await mod.leituraAbertura(bancoAbertura().tx, EMPRESA, '2026-11-01');
  assert.deepEqual(l.previa.janela, { de: '2026-11-01', ate: '2026-11-09' });
  assert.equal(l.previa.movimentos.length, 2);
  assert.equal(l.previa.conjuntoHash, abertura.hashConjunto(MOVS.slice(0, 2)));
  assert.equal(l.previa.movimentoDesdeD0Centavos, 40_000);
  assert.equal(l.previa.movimentos[0].atributosHash, abertura.atributosMovimento(MOVS[0]));
  const hoje = await mod.leituraAbertura(bancoAbertura().tx, EMPRESA, null);
  assert.equal(hoje.previa.janela, null);
  assert.equal(hoje.previa.movimentos.length, 0);
  await recusa(mod.leituraAbertura(bancoAbertura().tx, EMPRESA, '2026-11-11'), 'DADOS_INVALIDOS');
});

const PEDIDO_AB = { dataBase: '2026-11-01', saldo: -1234.56, justificativa: ' saldo do extrato ', versaoEsperada: 0, conjuntoHash: abertura.hashConjunto(MOVS.slice(0, 2)), chave: 'chave-ab-0001' };

test('confirmar: trava a empresa, grava versão 1 com o hash visto e as origens da janela como PREVIA', async () => {
  ligar(...FLAGS);
  const b = bancoAbertura();
  const r = await carregar({ movimentos: MOVS }).confirmarAbertura(b.tx, EMPRESA, ATOR, PEDIDO_AB);
  assert.deepEqual(r, { reutilizado: false, id: 'ab-novo', versao: 1 });
  assert.match(b.consultas[0].sql, /pg_advisory_xact_lock\(hashtext\('kidmais:financeiro-abertura'\)/, 'a trava vem antes de tudo');
  assert.deepEqual(b.feitas(/INSERT INTO financeiro_aberturas/)[0].valores, [EMPRESA, 1, '2026-11-01', '-1234.56', 'saldo do extrato', PEDIDO_AB.conjuntoHash, null, 'chave-ab-0001', ATOR]);
  const previas = b.feitas(/INSERT INTO financeiro_abertura_conferencias/);
  assert.equal(previas.length, 2);
  assert.match(previas[0].sql, /'PREVIA', 1/);
  assert.equal(previas[0].valores[4], abertura.atributosMovimento(MOVS[0]));
  for (const p of previas) assert.equal(String(p.valores[5]).length, 64, 'chave por linha cabe em 160');
  assert.notEqual(previas[0].valores[5], previas[1].valores[5]);
  assert.equal(b.feitas(/INSERT INTO financeiro_auditoria/)[0].valores[1], 'ABERTURA_CONFIRMADA');
});

test('corrigir: versão seguinte aponta para a vigente; versão divergente é 409 com a revisão atual e nada é gravado', async () => {
  ligar(...FLAGS);
  const vigente = { id: 'ab-1', versao: 1, dataBase: '2026-10-01', saldoCentavos: 0, confirmadaEm: '2026-10-05' };
  const b = bancoAbertura();
  const r = await carregar({ movimentos: MOVS, vigente }).confirmarAbertura(b.tx, EMPRESA, ATOR, { ...PEDIDO_AB, versaoEsperada: 1 });
  assert.equal(r.versao, 2);
  assert.equal(b.feitas(/INSERT INTO financeiro_aberturas/)[0].valores[6], 'ab-1');
  assert.equal(b.feitas(/INSERT INTO financeiro_auditoria/)[0].valores[1], 'ABERTURA_CORRIGIDA');

  const velho = bancoAbertura();
  await assert.rejects(carregar({ movimentos: MOVS, vigente }).confirmarAbertura(velho.tx, EMPRESA, ATOR, PEDIDO_AB), (erro: PacoteAdminError) => {
    assert.equal(erro.code, 'VERSAO_DIVERGENTE');
    assert.equal(erro.httpStatus, 409);
    assert.equal((erro.details as { vigente: { versao: number } }).vigente.versao, 1);
    return true;
  });
  assert.equal(velho.feitas(/INSERT/).length, 0);
});

test('confirmar: conjunto mudou desde a prévia é 409 com a nova prévia e nada é gravado', async () => {
  ligar(...FLAGS);
  const mudou = [MOVS[0], { ...MOVS[1], centavos: -20_001 }, MOVS[2]];
  const b = bancoAbertura();
  await assert.rejects(carregar({ movimentos: mudou }).confirmarAbertura(b.tx, EMPRESA, ATOR, PEDIDO_AB), (erro: PacoteAdminError) => {
    assert.equal(erro.code, 'CONJUNTO_MUDOU');
    assert.equal((erro.details as { previa: { conjuntoHash: string } }).previa.conjuntoHash, abertura.hashConjunto(mudou.slice(0, 2)));
    return true;
  });
  assert.equal(b.feitas(/INSERT/).length, 0);
});

test('confirmar: D0 futura e justificativa curta são recusadas; retry com a mesma chave devolve a mesma revisão', async () => {
  ligar(...FLAGS);
  const mod = carregar({ movimentos: MOVS });
  await recusa(mod.confirmarAbertura(bancoAbertura().tx, EMPRESA, ATOR, { ...PEDIDO_AB, dataBase: '2026-11-11' }), 'DADOS_INVALIDOS');
  await recusa(mod.confirmarAbertura(bancoAbertura().tx, EMPRESA, ATOR, { ...PEDIDO_AB, justificativa: ' x ' }), 'DADOS_INVALIDOS');
  const gravada = { id: 'ab-1', versao: 1, data_base: '2026-11-01', saldo: '-1234.56', justificativa: 'saldo do extrato', conjunto_hash: PEDIDO_AB.conjuntoHash };
  // Mesmo depois de outra revisão (a vigente agora é a 2), o retry devolve a 1 sem gravar.
  const retry = bancoAbertura({ chave: [gravada] });
  assert.deepEqual(await carregar({ movimentos: MOVS, vigente: { id: 'ab-2', versao: 2, dataBase: '2026-11-01', saldoCentavos: 0, confirmadaEm: HOJE } }).confirmarAbertura(retry.tx, EMPRESA, ATOR, PEDIDO_AB), { reutilizado: true, id: 'ab-1', versao: 1 });
  assert.equal(retry.feitas(/INSERT/).length, 0);
  await recusa(mod.confirmarAbertura(bancoAbertura({ chave: [{ ...gravada, saldo: '0.00' }] }).tx, EMPRESA, ATOR, PEDIDO_AB), 'IDEMPOTENCIA_CONFLITANTE');
});

// ---------------------------------------------------------------------------------------------------------------------
// Conferência
// ---------------------------------------------------------------------------------------------------------------------

const VIGENTE = { id: 'ab-1', versao: 3, dataBase: '2026-11-01', saldoCentavos: 0, confirmadaEm: HOJE };
const item = (m: MovimentoCaixa) => ({ tipo: m.tipo, origemId: m.origemId, atributosHash: abertura.atributosMovimento(m) });

test('conferir: grava CONFERIDO na sequência seguinte, por item, sob a trava da empresa', async () => {
  ligar(...FLAGS);
  const b = bancoAbertura({ seq: 2 });
  const r = await carregar({ movimentos: MOVS, vigente: VIGENTE }).conferirPendencias(b.tx, EMPRESA, ATOR, { versaoAbertura: 3, itens: [item(MOVS[0]), item(MOVS[1])], chave: 'chave-conf-001' });
  assert.deepEqual(r, { reutilizado: false, conferidos: 2 });
  assert.match(b.consultas[0].sql, /pg_advisory_xact_lock/);
  const linhas = b.feitas(/INSERT INTO financeiro_abertura_conferencias/);
  assert.equal(linhas.length, 2);
  assert.match(linhas[0].sql, /'CONFERIDO'/);
  assert.deepEqual(linhas[0].valores.slice(0, 6), [EMPRESA, 'ab-1', 'RECEBIMENTO', MOVS[0].origemId, abertura.atributosMovimento(MOVS[0]), 2]);
});

test('conferir: revisão trocada é 409 com a vigente; nada é gravado', async () => {
  ligar(...FLAGS);
  const b = bancoAbertura();
  await assert.rejects(carregar({ movimentos: MOVS, vigente: VIGENTE }).conferirPendencias(b.tx, EMPRESA, ATOR, { versaoAbertura: 2, itens: [item(MOVS[0])], chave: 'chave-conf-001' }), (erro: PacoteAdminError) => {
    assert.equal(erro.code, 'VERSAO_DIVERGENTE');
    assert.equal((erro.details as { vigente: { versao: number } }).vigente.versao, 3);
    return true;
  });
  assert.equal(b.feitas(/INSERT/).length, 0);
});

test('conferir: lote com um item cujos atributos mudaram recusa o lote inteiro e devolve o item divergente', async () => {
  ligar(...FLAGS);
  const visto = item(MOVS[1]);
  const mudou = [MOVS[0], { ...MOVS[1], estado: 'ESTORNADO' }];
  const b = bancoAbertura();
  await assert.rejects(carregar({ movimentos: mudou, vigente: VIGENTE }).conferirPendencias(b.tx, EMPRESA, ATOR, { versaoAbertura: 3, itens: [item(MOVS[0]), visto], chave: 'chave-conf-001' }), (erro: PacoteAdminError) => {
    assert.equal(erro.code, 'ATRIBUTOS_MUDARAM');
    assert.deepEqual((erro.details as { divergentes: unknown[] }).divergentes, [visto]);
    return true;
  });
  assert.equal(b.feitas(/INSERT/).length, 0, 'o estado novo nunca é registrado como visto');
});

test('conferir: item que já não está pendente (conferido com o mesmo hash) é divergente; item repetido no lote é recusado', async () => {
  ligar(...FLAGS);
  const conferidos = new Map([[abertura.chaveOrigem(MOVS[0]), abertura.atributosMovimento(MOVS[0])]]);
  await recusa(carregar({ movimentos: MOVS, vigente: VIGENTE, conferidos }).conferirPendencias(bancoAbertura().tx, EMPRESA, ATOR, { versaoAbertura: 3, itens: [item(MOVS[0])], chave: 'chave-conf-001' }), 'ATRIBUTOS_MUDARAM');
  await recusa(carregar({ movimentos: MOVS, vigente: VIGENTE }).conferirPendencias(bancoAbertura().tx, EMPRESA, ATOR, { versaoAbertura: 3, itens: [item(MOVS[0]), item(MOVS[0])], chave: 'chave-conf-001' }), 'DADOS_INVALIDOS');
});

test('conferir: retry com a mesma chave e o mesmo conteúdo devolve sem gravar; outro conteúdo é 409', async () => {
  ligar(...FLAGS);
  const it = item(MOVS[0]);
  const mod = carregar({ movimentos: MOVS, vigente: { ...VIGENTE, versao: 4 } });
  const { prefixo, chaves } = mod.chavesDaConferencia('chave-conf-001', 3, [it]);
  assert.ok(chaves.every((c: string) => c.length <= 160 && c.startsWith(`${prefixo}:`)), 'cabe no varchar(160) e começa pelo prefixo do pedido');
  const ja = chaves.map((c: string) => ({ chave_idempotencia: c }));
  const b = bancoAbertura({ ja });
  assert.deepEqual(await mod.conferirPendencias(b.tx, EMPRESA, ATOR, { versaoAbertura: 3, itens: [it], chave: 'chave-conf-001' }), { reutilizado: true, conferidos: 1 });
  assert.equal(b.feitas(/INSERT/).length, 0);
  assert.deepEqual(b.consultas.find((c) => /LIKE \$2/.test(c.sql))?.valores, [EMPRESA, `${prefixo}:%`], 'procura todas as linhas da chave, de qualquer lote');
  await recusa(carregar({ movimentos: MOVS, vigente: VIGENTE }).conferirPendencias(bancoAbertura({ ja }).tx, EMPRESA, ATOR, { versaoAbertura: 3, itens: [{ ...it, atributosHash: 'f'.repeat(64) }], chave: 'chave-conf-001' }), 'IDEMPOTENCIA_CONFLITANTE');
});

test('conferir: a mesma chave só reaproveita o lote inteiro; subconjunto, superconjunto, lote disjunto e outra versão são 409', async () => {
  ligar(...FLAGS);
  const [a, bItem, c] = [item(MOVS[0]), item(MOVS[1]), item({ ...MOVS[1], origemId: '99999999-9999-4999-8999-999999999999' })];
  const mod = carregar({ movimentos: MOVS, vigente: VIGENTE });
  const gravado = mod.chavesDaConferencia('chave-conf-001', 3, [a, bItem]).chaves.map((chave: string) => ({ chave_idempotencia: chave }));
  const pedir = (itens: Array<ReturnType<typeof item>>, versaoAbertura = 3) => {
    const b = bancoAbertura({ ja: gravado });
    return { b, p: mod.conferirPendencias(b.tx, EMPRESA, ATOR, { versaoAbertura, itens, chave: 'chave-conf-001' }) };
  };
  const mesmo = pedir([bItem, a]);
  assert.deepEqual(await mesmo.p, { reutilizado: true, conferidos: 2 }, 'mesma lista em outra ordem é o mesmo pedido');
  const repetido = pedir([a, a]);
  await recusa(repetido.p, 'DADOS_INVALIDOS');
  assert.equal(repetido.b.feitas(/LIKE \$2/).length, 0, 'item repetido é recusado antes de olhar o retry');
  for (const [nome, itens, versao] of [['subconjunto', [a], 3], ['superconjunto', [a, bItem, c], 3], ['disjunto', [c], 3], ['outra versão', [a, bItem], 4]] as const) {
    const { b, p } = pedir([...itens], versao);
    await recusa(p, 'IDEMPOTENCIA_CONFLITANTE');
    assert.equal(b.feitas(/INSERT/).length, 0, nome);
  }
});

test('pagamentos da conta: restante = valor − revertido; sem schema da 120 não consulta a tabela nova', async () => {
  const b = banco([[/FROM financeiro_saidas saida/, () => [{ id: SAIDA, pago_em: '2026-11-01', valor: '100.00', revertido: '30.00', forma: 'PIX' }]]]);
  const lista = await carregar().pagamentosDaConta(b.tx, EMPRESA, CONTA);
  assert.deepEqual(lista, [{ id: SAIDA, data: '2026-11-01', forma: 'PIX', valorCentavos: 10_000, revertidoCentavos: 3_000, restanteCentavos: 7_000 }]);
  assert.deepEqual(b.consultas[0].valores, [CONTA, EMPRESA]);
  const sem = banco([[/FROM financeiro_saidas saida/, () => []]]);
  await carregar({ esquema: { movimentos: false, abertura: false } }).pagamentosDaConta(sem.tx, EMPRESA, CONTA);
  assert.doesNotMatch(sem.consultas[0].sql, /financeiro_saidas_reversoes/);
});
