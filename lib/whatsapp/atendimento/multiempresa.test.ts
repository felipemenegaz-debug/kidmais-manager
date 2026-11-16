import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import * as me from './multiempresa.ts';

/**
 * E-ME1 sem banco (executor simulado): chave, modo efetivo, direito comercial na ordem fixa (§2.3, D-ME-1), erros
 * transitórios (§2.3, casos 7 e 8b), portão da piloto sem consulta e unicidade do identificador (§5). Nenhuma rede.
 */
register('../../../scripts/walle-avaliacao/alias-hooks.mjs', import.meta.url);
type Linhas = Record<string, unknown>[];
function executor(responder: (sql: string, args: unknown[]) => Linhas | Error) {
  const sqls: string[] = [];
  return { sqls, tx: { query: async (sql: string, args: unknown[] = []) => { sqls.push(sql); const r = responder(sql, args); if (r instanceof Error) throw r; return { rows: r, rowCount: r.length }; } } as never };
}
const env = (valor?: string) => (valor === undefined ? {} : { WHATSAPP_ATENDIMENTO_MULTIEMPRESA: valor }) as NodeJS.ProcessEnv;
// Catálogo: UMA consulta por transação (P3 da revisão) com as tabelas da 117 e o schema comercial (074).
const CATALOGO = "to_regclass('public.whatsapp_atendimento_rodizio')";
const tabelas = (rodizio: boolean, colisoes: boolean, comercial = true) => (sql: string): Linhas | null => (sql.includes(CATALOGO) ? [{ rodizio, colisoes, comercial }] : null);

test('6: chave exatamente "true" liga; ausente, "false" ou inválida desliga', () => {
  assert.equal(me.chaveMultiempresa(env()), 'PILOTO');
  assert.equal(me.chaveMultiempresa(env('false')), 'PILOTO');
  for (const v of ['TRUE', '1', 'yes', ' true', '']) assert.equal(me.chaveMultiempresa(env(v)), 'INVALIDA', v);
  assert.equal(me.chaveMultiempresa(env('true')), 'MULTI');
});

test('§2.1: modo efetivo MULTI só com a chave E as duas tabelas da 117; sem a chave não consulta o banco', async () => {
  const sem = executor(() => { throw new Error('não deveria consultar'); });
  assert.equal(await me.modoEfetivo(sem.tx, env()), 'PILOTO');
  assert.equal(await me.modoEfetivo(sem.tx, env('TRUE')), 'PILOTO');
  assert.equal(sem.sqls.length, 0);
  for (const [r, c, esperado] of [[true, true, 'MULTI'], [true, false, 'PILOTO'], [false, true, 'PILOTO'], [false, false, 'PILOTO']] as const)
    assert.equal(await me.modoEfetivo(executor((sql) => tabelas(r, c)(sql) ?? []).tx, env('true')), esperado, `rodízio=${r} colisões=${c}`);
});

/** Banco comercial simulado na ordem de §2.3. */
function comercial(op: { schema?: boolean; isenta?: boolean; plano?: string | null; assinatura?: { teste: boolean } | null; falha?: string }) {
  return executor((sql) => {
    if (op.falha && sql.includes(op.falha)) return new Error('falha simulada de leitura');
    if (sql.includes(CATALOGO)) return [{ rodizio: true, colisoes: true, comercial: op.schema ?? true }];
    if (sql.includes('FROM assinatura_isencoes')) return [{ isenta: op.isenta ?? false }];
    if (sql.includes('JOIN assinatura_contratacoes')) return op.plano ? [{ plano: op.plano }] : [];
    if (sql.includes("situacao='TESTE'")) return op.assinatura ? [op.assinatura] : [];
    return [];
  });
}
test('8: direito comercial na ordem fixa (§2.3) com D-ME-1 e D-OF-1', async () => {
  const casos: [Parameters<typeof comercial>[0], me.SituacaoDireito, boolean][] = [
    [{ isenta: true, plano: 'essencial' }, 'ISENCAO', true],
    [{ plano: 'essencial' }, 'PLANO_NAO_INCLUI', false],
    [{ plano: 'PROFISSIONAL' }, 'PLANO_NAO_INCLUI', false],
    [{ plano: 'PREMIUM' }, 'PLANO_INCLUI', true],
    [{ plano: 'profissional', assinatura: { teste: true } }, 'PLANO_NAO_INCLUI', false],
    [{ plano: 'premium', assinatura: { teste: true } }, 'PLANO_INCLUI', true],
    [{ assinatura: { teste: true } }, 'TESTE', true],
    [{ assinatura: { teste: false } }, 'LEGADO', false],
    [{}, 'SEM_INFORMACAO', false],
  ];
  for (const [op, situacao, direito] of casos) {
    assert.equal(await me.situacaoDireitoAtendimento(comercial(op).tx, 'b'), situacao, JSON.stringify(op));
    assert.equal(await me.direitoAtendimentoWhatsApp(comercial(op).tx, 'b'), direito, JSON.stringify(op));
  }
  assert.deepEqual([...me.PLANOS_ATENDIMENTO_WHATSAPP].sort(), ['premium'], 'D-OF-1: só o Premium');
});

test('8b/7: schema comercial ausente, plano desconhecido ou erro de leitura = transitório (nunca SIM nem NÃO)', async () => {
  for (const op of [{ schema: false, isenta: true }, { schema: false }, { plano: 'diamante' }, { falha: 'FROM assinatura_isencoes' }, { falha: 'JOIN assinatura_contratacoes' }, { falha: "situacao='TESTE'" }]) {
    await assert.rejects(me.direitoAtendimentoWhatsApp(comercial(op).tx, 'b'), (e: unknown) => me.eTransitorio(e), JSON.stringify(op));
  }
});

test('§3: a piloto opera sem nenhuma consulta (regras de antes); outra empresa só no MULTI com C2 e C4', async () => {
  const nada = executor(() => { throw new Error('não deveria consultar'); });
  assert.equal(await me.empresaOperaAtendimento(nada.tx, 'A0', { piloto: 'a0', ambiente: 'staging', env: env('true') }), true);
  assert.equal(await me.empresaOperaAtendimento(nada.tx, 'b', { piloto: 'a', ambiente: 'staging', env: env() }), false, 'PILOTO: outra empresa não opera');
  const banco = (conectada: boolean, isenta: boolean) => executor((sql) => tabelas(true, true)(sql)
    ?? (sql.includes('FROM whatsapp_conexoes') ? (conectada ? [{ '?column?': 1 }] : []) : null)
    ?? (sql.includes('FROM assinatura_isencoes') ? [{ isenta }] : []));
  assert.equal(await me.empresaOperaAtendimento(banco(true, true).tx, 'b', { piloto: 'a', ambiente: 'staging', env: env('true') }), true);
  assert.equal(await me.empresaOperaAtendimento(banco(false, true).tx, 'b', { piloto: 'a', ambiente: 'staging', env: env('true') }), false, 'C2: sem conexão');
  // F4: escrever configuração/biblioteca exige só o modo efetivo (configurar antes de conectar); a piloto sem consulta.
  assert.equal(await me.escritaPermitida(banco(false, false).tx, 'b', { piloto: 'a', env: env('true') }), true, 'MULTI: configurar antes de conectar');
  assert.equal(await me.escritaPermitida(executor((sql) => tabelas(true, false)(sql) ?? []).tx, 'b', { piloto: 'a', env: env('true') }), false, '3c: 117 incompleta = PILOTO, B não escreve');
  assert.equal(await me.escritaPermitida(nada.tx, 'b', { piloto: 'a', env: env() }), false, 'PILOTO: B não escreve');
  assert.equal(await me.escritaPermitida(nada.tx, 'A', { piloto: 'a', env: env() }), true, 'a piloto como antes');
  assert.equal(await me.empresaOperaAtendimento(banco(true, false).tx, 'b', { piloto: null, ambiente: 'staging', env: env('true') }), false, 'C4: sem informação');
  await assert.rejects(me.empresaOperaAtendimento(executor(() => new Error('banco fora')).tx, 'b', { piloto: 'a', ambiente: 'staging', env: env('true') }), (e: unknown) => me.eTransitorio(e));
});

test('§5: unicidade do identificador — marca vigente bloqueia; duplicado grava a marca (com a 117) ou só registra (sem a 117)', async () => {
  const banco = (colisoes: boolean, marca: boolean, saidas: number) => executor((sql) => tabelas(true, colisoes)(sql)
    ?? (sql.startsWith('SELECT 1 FROM whatsapp_atendimento_status_colisoes') ? (marca ? [{ '?column?': 1 }] : []) : null)
    ?? (sql.includes('count(*) AS n') ? [{ n: String(saidas) }] : []));
  const unica = banco(true, false, 1);
  assert.equal(await me.identificadorUnico(unica.tx, 'staging', 'w'), true);
  const marcada = banco(true, true, 1);
  assert.equal(await me.identificadorUnico(marcada.tx, 'staging', 'w'), false, '1e: marca vigente');
  const dup = banco(true, false, 2);
  assert.equal(await me.identificadorUnico(dup.tx, 'staging', 'w'), false);
  assert.ok(dup.sqls.some((s) => s.startsWith('INSERT INTO whatsapp_atendimento_status_colisoes')), '1b: marca gravada');
  const sem117 = banco(false, false, 2);
  assert.equal(await me.identificadorUnico(sem117.tx, 'staging', 'w'), false);
  assert.ok(!sem117.sqls.some((s) => s.includes('status_colisoes') && !s.includes('to_regclass')), '3c-col: tabela ausente nunca é consultada');
});

test('12 / D-ME-4: no MULTI o modelo exige teto por empresa positivo; sem a chave nada muda', async () => {
  const { exigirTetoPorEmpresa } = await import(new URL('../../../app/api/admin/inteligencia/whatsapp/modelo.ts', import.meta.url).href) as typeof import('../../../app/api/admin/inteligencia/whatsapp/modelo.ts');
  const multi = env('true');
  assert.throws(() => exigirTetoPorEmpresa({}, multi), /ATENDIMENTO_ORCAMENTO_SEM_TETO_EMPRESA/, 'ausente');
  assert.throws(() => exigirTetoPorEmpresa({ porEmpresa: {} }, multi), /ATENDIMENTO_ORCAMENTO_SEM_TETO_EMPRESA/, '{}');
  assert.throws(() => exigirTetoPorEmpresa({ porCapacidade: { whatsapp_atendimento: { tokensDiario: 100 } } }, multi), /ATENDIMENTO_ORCAMENTO_SEM_TETO_EMPRESA/, 'só da capacidade');
  assert.doesNotThrow(() => exigirTetoPorEmpresa({ porEmpresa: { tokensDiario: 1000 } }, multi));
  assert.doesNotThrow(() => exigirTetoPorEmpresa({}, env()), 'PILOTO: regra de antes');
});

test('P3: o catálogo (117 + 074) é consultado UMA vez por transação, mesmo com várias empresas candidatas', async () => {
  const b = executor((sql) => tabelas(true, true)(sql) ?? (sql.includes('FROM whatsapp_conexoes') ? [{ '?column?': 1 }] : sql.includes('FROM assinatura_isencoes') ? [{ isenta: true }] : []));
  for (const empresa of ['b', 'c', 'd']) assert.equal(await me.empresaOperaAtendimento(b.tx, empresa, { piloto: 'a', ambiente: 'staging', env: env('true') }), true);
  assert.equal(b.sqls.filter((s) => s.includes(CATALOGO)).length, 1);
  const outra = executor((sql) => tabelas(true, true)(sql) ?? []);
  await me.modoEfetivo(outra.tx, env('true'));
  assert.equal(outra.sqls.filter((s) => s.includes(CATALOGO)).length, 1, 'outra transação consulta de novo');
  const falha = executor(() => new Error('catálogo fora'));
  await assert.rejects(me.modoEfetivo(falha.tx, env('true')));
  await assert.rejects(me.modoEfetivo(falha.tx, env('true')));
  assert.equal(falha.sqls.length, 2, 'falha não fica memorizada');
});

test('P3: a matriz de planos declara o Atendimento WhatsApp e o portão lê dela', async () => {
  const { RECURSOS_POR_PLANO } = await import('../../assinatura/recursos-plano.ts');
  assert.deepEqual([...RECURSOS_POR_PLANO.ATENDIMENTO_WHATSAPP], [...me.PLANOS_ATENDIMENTO_WHATSAPP]);
  assert.equal(me.PLANOS_ATENDIMENTO_WHATSAPP, RECURSOS_POR_PLANO.ATENDIMENTO_WHATSAPP);
});

test('F7: lerPortao converte qualquer falha de leitura em transitória (e mantém a transitória)', async () => {
  await assert.rejects(me.lerPortao('X', async () => { throw new Error('conexão caiu'); }), (e: unknown) => me.eTransitorio(e) && (e as me.ErroTransitorioAtendimento).motivo === 'X');
  await assert.rejects(me.lerPortao('X', async () => { throw new me.ErroTransitorioAtendimento('Y'); }), (e: unknown) => (e as me.ErroTransitorioAtendimento).motivo === 'Y');
  assert.equal(await me.lerPortao('X', async () => 7), 7);
});

test('12 (r2): fase B e Wall-e NÃO chamam o adaptador sem teto por empresa no MULTI (espiã de rede)', async () => {
  const modelo = await import(new URL('../../../app/api/admin/inteligencia/whatsapp/modelo.ts', import.meta.url).href) as typeof import('../../../app/api/admin/inteligencia/whatsapp/modelo.ts');
  const fetchAntes = globalThis.fetch;
  let rede = 0;
  globalThis.fetch = (async () => { rede++; throw new Error('rede proibida no teste'); }) as typeof fetch;
  const salvo = { multi: process.env.WHATSAPP_ATENDIMENTO_MULTIEMPRESA, orcamento: process.env.AI_BUDGET_JSON };
  const registro = { reservar: async () => { throw new Error('registro não deveria ser usado'); } } as never;
  const capacidade = { porCapacidade: { whatsapp_atendimento: { tokensDiario: 100_000 } } };
  const casos: [string, string, RegExp][] = [
    ['porEmpresa ausente', JSON.stringify(capacidade), /ATENDIMENTO_ORCAMENTO_SEM_TETO_EMPRESA/],
    ['porEmpresa {}', JSON.stringify({ ...capacidade, porEmpresa: {} }), /ATENDIMENTO_ORCAMENTO_SEM_TETO_EMPRESA/],
    ['porEmpresa inválido', JSON.stringify({ ...capacidade, porEmpresa: { tokensDiario: -5 } }), /ATENDIMENTO_ORCAMENTO_(INVALIDO|SEM_TETO_EMPRESA)/],
    ['orçamento ilegível', '{não é json', /ATENDIMENTO_ORCAMENTO_INVALIDO/],
  ];
  try {
    for (const [rotulo, orcamento, erro] of casos) {
      const ambiente = { WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'true', AI_BUDGET_JSON: orcamento } as unknown as NodeJS.ProcessEnv;
      await assert.rejects(modelo.entenderPeloRoteador(registro, ambiente)('b', 'quanto custa?', {} as never, {} as never), erro, `Wall-e: ${rotulo}`);
      Object.assign(process.env, ambiente);
      await assert.rejects(modelo.interpretarMensagem('b', 'quanto custa?', { perguntas: [] } as never), erro, `fase B: ${rotulo}`);
    }
    assert.equal(rede, 0, 'nenhuma chamada ao adaptador (rede) sem teto por empresa');
    // Com teto por empresa válido, o portão do teto deixa passar (o erro, se houver, vem depois dele — nunca SEM_TETO).
    const valido = { WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'true', AI_BUDGET_JSON: JSON.stringify({ ...capacidade, porEmpresa: { tokensDiario: 1_000_000 } }) } as unknown as NodeJS.ProcessEnv;
    await assert.rejects(modelo.entenderPeloRoteador(registro, valido)('b', 'quanto custa?', {} as never, {} as never), (e: Error) => !/SEM_TETO|ORCAMENTO_INVALIDO/.test(e.message), 'Wall-e: teto válido passa do portão');
  } finally {
    globalThis.fetch = fetchAntes;
    if (salvo.multi === undefined) delete process.env.WHATSAPP_ATENDIMENTO_MULTIEMPRESA; else process.env.WHATSAPP_ATENDIMENTO_MULTIEMPRESA = salvo.multi;
    if (salvo.orcamento === undefined) delete process.env.AI_BUDGET_JSON; else process.env.AI_BUDGET_JSON = salvo.orcamento;
  }
});
