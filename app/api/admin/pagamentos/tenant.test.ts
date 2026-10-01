import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import type { DbExecutor } from '../../../../lib/db/contracts.ts';
import * as contratoTenant from '../../../../lib/contratos/services/contrato-tenant.ts';
import { executarNoTenant, type SessaoParaTenant } from '../../../../lib/saas/provar-tenant.ts';
import { chaveIdempotenciaNoPagamento } from '../../../../lib/pagamentos/services/idempotencia.ts';

/**
 * C1/C2: rotas administrativas de Pagamentos e o financeiro por contrato, carregadas de verdade, com o helper
 * REAL de posse (executarComPosseNoTenant) e o Tenant Context REAL (executarNoTenant) sobre um banco falso.
 * Prova: posse no tenant antes de ler/escrever; outra empresa/legado/inexistente ⇒ 404 igual; autoridade
 * revogada ⇒ nada executa; escrita no MESMO tx da prova; revogação vista na revalidação ⇒ sem commit.
 */
function carregar(path: string, deps: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', js)((id: string) => { assert(id in deps, `Dependência não simulada: ${id}`); return deps[id]; }, exports);
  return exports;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const USUARIO = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEMBERSHIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [PAG_A, PAG_B, PAG_LEGADO, FECH_A, FECH_B, CON_A, CON_B, CON_LEGADO, INEXISTENTE] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
const EMPRESA: Record<string, string | null> = { [PAG_A]: A, [PAG_B]: B, [PAG_LEGADO]: null, [FECH_A]: A, [FECH_B]: B, [CON_A]: A, [CON_B]: B, [CON_LEGADO]: null };

type Estado = { ativo: boolean; papel: string; membership: boolean; empresaAtiva: boolean; revogadaNaRevalidacao: boolean; commits: number; log: string[] };

function banco(estado: Estado) {
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (sql.includes('FROM usuarios_administrativos') && sql.includes('FOR UPDATE')) { estado.log.push('trava-usuario'); return r([{ id: values[0] }]); }
      if (sql.includes('SELECT ativo\n')) return r([{ ativo: estado.ativo }]);
      if (sql.includes('SELECT ativo FROM usuarios_administrativos')) { estado.log.push('revalida'); return r([{ ativo: estado.ativo }]); }
      if (sql.includes('SELECT DISTINCT m.empresa_id')) return r([{ id: A }]);
      if (sql.includes('SELECT status FROM empresas')) return r([{ status: estado.empresaAtiva ? 'ATIVA' : 'SUSPENSA' }]);
      if (sql.includes('FROM empresas')) return r([{ id: values[0] }]);
      if (sql.includes('FROM memberships m') && sql.includes('JOIN empresas')) return r(estado.membership && estado.empresaAtiva ? [{ id: MEMBERSHIP, empresa_id: A, papel: estado.papel }] : []);
      if (sql.includes('m.status AS membership')) return r([{ membership: estado.revogadaNaRevalidacao ? 'REVOGADA' : 'ATIVA' }]);
      if (sql.includes('FROM pagamentos p') || sql.includes('FROM fechamentos fech') || sql.includes('FROM contratos contrato')) {
        estado.log.push('posse');
        // A empresa está no WHERE/JOIN da própria consulta (escopo no servidor).
        assert.match(sql, /fech\.empresa_id = \$2::uuid/);
        assert.match(sql, /JOIN pacotes pac ON pac\.id = fech\.pacote_id AND pac\.empresa_id = \$2::uuid/);
        const empresa = EMPRESA[String(values[0])];
        return r(empresa !== undefined && empresa !== null && empresa === values[1] ? [{ id: values[0] }] : []);
      }
      if (sql.includes('pagamento_devolucao_comprovantes')) { estado.log.push('le-comprovante'); return r([{ conteudo: Buffer.from('%PDF-'), mime_type: 'application/pdf' }]); }
      throw new Error(`consulta inesperada: ${sql.slice(0, 70)}`);
    },
  };
  // Tenant Context REAL sobre o tx falso; "commit" só quando nada falhou (como withTransaction).
  const withTenantTransaction = async <T>(s: SessaoParaTenant, empresa: string | null | undefined, work: (tx: DbExecutor, t: never) => Promise<T>) => {
    const r = await executarNoTenant(tx, s, empresa, work as never);
    estado.commits += 1;
    return r;
  };
  return { tx, withTenantTransaction };
}

const NextResponse = Object.assign(class extends Response {}, { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) });
const erroPagamentoApi = (e: { code?: string; httpStatus?: number; status?: number }) => {
  if (!e?.code) throw e;
  return new Response(JSON.stringify({ ok: false, codigo: e.code }), { status: e.httpStatus ?? e.status ?? 500 });
};
const recusarFinanceiro = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }); };
const sessao = { usuario_id: USUARIO, papel: 'ADMINISTRATIVO' };
const pedido = (url: string, corpo: unknown = null) => ({
  nextUrl: new URL(`http://kidmais.test${url}`), json: async () => corpo,
  headers: new Headers({ 'Idempotency-Key': id(77) }),
});

function ambiente(parcial: Partial<Estado> = {}) {
  const estado: Estado = { ativo: true, papel: 'ADMINISTRATIVO', membership: true, empresaAtiva: true, revogadaNaRevalidacao: false, commits: 0, log: [], ...parcial };
  const { tx, withTenantTransaction } = banco(estado);
  const chamadas: Array<{ servico: string; executor: unknown }> = [];
  const servico = (nome: string, efeito?: () => void) => async (...args: unknown[]) => {
    const ctx = args.find((a) => typeof a === 'object' && a !== null && 'origem' in (a as object) || (typeof a === 'object' && a !== null && 'token' in (a as object))) as { executor?: unknown } | undefined;
    const executor = ctx?.executor ?? args.find((a) => a === tx);
    estado.log.push(`servico:${nome}`);
    chamadas.push({ servico: nome, executor });
    efeito?.();
    return nome === 'obterPagamentoPorFechamento' ? { pagamento: 'ok' } : { reutilizado: false, detalhe: {} };
  };
  const zPermissivo = z.union([z.string(), z.number()]);
  const comum = {
    'next/server': { NextResponse }, zod: { z },
    '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => sessao, contextoCrmDaRequest: () => ({ usuarioId: USUARIO }), tokenAdmin: () => 'token' },
    '@/lib/http/pagamentos-api': { erroPagamentoApi },
    '@/lib/contratos/services/contrato-tenant': contratoTenant,
    '@/lib/saas/provar-tenant': { withTenantTransaction },
    '@/lib/pagamentos/services/idempotencia': { chaveIdempotenciaNoPagamento },
    '../../schemas': { valorMonetarioSchema: zPermissivo, planoPagamentoSchema: z.any(), sugestaoPixSchema: z.any() },
    './schemas': { planoPagamentoSchema: z.object({ meioPagamento: z.string() }).passthrough(), sugestaoPixSchema: z.never() },
    '@/lib/http/cronograma-financeiro-schema': { cronogramaFinanceiroSchema: z.any() },
  };
  let revogarNoServico = false;
  const revogar = () => { if (revogarNoServico) estado.revogadaNaRevalidacao = true; };
  const pagamentos = {
    obterPagamentoPorFechamento: servico('obterPagamentoPorFechamento', revogar), criarPagamentoDoFechamento: servico('criarPagamentoDoFechamento', revogar),
    registrarComprovantePagamento: servico('registrarComprovantePagamento', revogar), registrarEstornoPagamento: servico('registrarEstornoPagamento', revogar),
    substituirPlanoPagamento: servico('substituirPlanoPagamento', revogar), registrarRecebimentoPagamento: servico('registrarRecebimentoPagamento', revogar),
  };
  const P = 'app/api/admin/pagamentos';
  const rota = (arquivo: string) => carregar(arquivo, { ...comum, '@/lib/pagamentos/services': pagamentos });
  const params = (pagamentoId: string) => ({ params: Promise.resolve({ pagamentoId }) });
  type Handler = (r: unknown, c?: unknown) => Promise<Response>;
  const raiz = rota(`${P}/route.ts`);
  const acoes = {
    'GET pagamentos?fechamentoId': (alvo: string) => (raiz.GET as Handler)(pedido(`/api/admin/pagamentos?fechamentoId=${alvo}`)),
    'POST pagamentos': (alvo: string) => (raiz.POST as Handler)(pedido('/api/admin/pagamentos', { fechamentoId: alvo, plano: { meioPagamento: 'PIX' } })),
    'POST comprovantes': (alvo: string) => (rota(`${P}/[pagamentoId]/comprovantes/route.ts`).POST as Handler)(pedido('/x', { recebimentoId: id(40), nomeArquivo: 'a.pdf', mimeType: 'application/pdf', tamanhoBytes: 10, sha256: 'a'.repeat(64), localizadorArquivo: 'x' }), params(alvo)),
    'POST estornos': (alvo: string) => (rota(`${P}/[pagamentoId]/estornos/route.ts`).POST as Handler)(pedido('/x', { recebimentoId: id(40), parcelaId: id(41), valor: '10.00' }), params(alvo)),
    'POST plano': (alvo: string) => (rota(`${P}/[pagamentoId]/plano/route.ts`).POST as Handler)(pedido('/x', { motivo: 'troca de plano', plano: {} }), params(alvo)),
    'POST recebimentos': (alvo: string) => (rota(`${P}/[pagamentoId]/recebimentos/route.ts`).POST as Handler)(pedido('/x', { meioPagamento: 'PIX', valorBruto: '10.00', alocacoes: [{ parcelaId: id(41), valor: '10.00' }] }), params(alvo)),
  };
  return { estado, tx, chamadas, acoes, revogarNaEscrita: () => { revogarNoServico = true; } };
}

const PROPRIO: Record<string, string> = { 'GET pagamentos?fechamentoId': FECH_A, 'POST pagamentos': FECH_A };
const ESTRANGEIROS: Record<string, string[]> = { 'GET pagamentos?fechamentoId': [FECH_B, INEXISTENTE], 'POST pagamentos': [FECH_B, INEXISTENTE] };
const proprio = (acao: string) => PROPRIO[acao] ?? PAG_A;
const estrangeiros = (acao: string) => ESTRANGEIROS[acao] ?? [PAG_B, PAG_LEGADO, INEXISTENTE];

test('C1: cada rota de Pagamentos (GET e mutações) executa no recurso da empresa comprovada, no MESMO tx da prova', async () => {
  for (const acao of Object.keys(ambiente().acoes) as Array<keyof ReturnType<typeof ambiente>['acoes']>) {
    const a = ambiente();
    const r = await a.acoes[acao](proprio(acao));
    assert.ok(r.status < 300, `${acao}: ${r.status} ${await r.clone().text()}`);
    assert.equal(a.chamadas.length, 1, acao);
    assert.equal(a.chamadas[0].executor, a.tx, `${acao}: serviço recebe o tx da prova (C2)`);
    const log = a.estado.log.join(' → ');
    assert.ok(a.estado.log.indexOf('trava-usuario') < a.estado.log.indexOf('posse'), `${acao}: ${log}`);
    assert.ok(a.estado.log.indexOf('posse') < a.estado.log.findIndex((l) => l.startsWith('servico:')), `${acao}: posse antes do serviço`);
    assert.ok(a.estado.log.findIndex((l) => l.startsWith('servico:')) < a.estado.log.lastIndexOf('revalida'), `${acao}: revalidação depois da escrita, antes do commit`);
    assert.equal(a.estado.commits, 1);
  }
});

test('C1 cross-tenant: outra empresa, legado e inexistente ⇒ o mesmo 404 e nenhum serviço chamado, em GET e em todas as mutações', async () => {
  for (const acao of Object.keys(ambiente().acoes) as Array<keyof ReturnType<typeof ambiente>['acoes']>) {
    const corpos = new Set<string>();
    for (const alvo of estrangeiros(acao)) {
      const a = ambiente();
      const r = await a.acoes[acao](alvo);
      assert.equal(r.status, 404, `${acao} ${alvo}`);
      corpos.add(await r.text());
      assert.equal(a.chamadas.length, 0, `${acao} ${alvo}: nada lido nem gravado`);
    }
    assert.equal(corpos.size, 1, `${acao}: resposta não enumerável`);
  }
});

test('C2: autoridade revogada antes da prova (membership, empresa, usuário, papel) ⇒ nada executa', async () => {
  const casos: Array<[string, Partial<Estado>]> = [
    ['membership revogada', { membership: false }], ['empresa suspensa', { empresaAtiva: false }],
    ['usuário inativo', { ativo: false }], ['papel atual sem acesso', { papel: 'VISITANTE' }],
  ];
  for (const acao of Object.keys(ambiente().acoes) as Array<keyof ReturnType<typeof ambiente>['acoes']>) {
    for (const [nome, estado] of casos) {
      const a = ambiente(estado);
      const r = await a.acoes[acao](proprio(acao));
      assert.equal(r.status, 403, `${acao} / ${nome}`);
      assert.equal(a.chamadas.length, 0, `${acao} / ${nome}`);
      assert.equal(a.estado.log.includes('posse'), false, `${acao} / ${nome}: sem consulta do recurso`);
    }
  }
});

test('C2: mudança concorrente percebida na revalidação ⇒ erro dentro da transação da escrita, sem commit (a escrita é desfeita)', async () => {
  for (const acao of Object.keys(ambiente().acoes) as Array<keyof ReturnType<typeof ambiente>['acoes']>) {
    const a = ambiente();
    a.revogarNaEscrita();
    const r = await a.acoes[acao](proprio(acao));
    assert.equal(r.status, 403, acao);
    assert.equal(a.estado.commits, 0, `${acao}: nenhuma escrita comitada com autoridade obsoleta`);
  }
});

// ---------------------------------------------------------------- financeiro por contrato (B2 → C2)

function financeiro(parcial: Partial<Estado> = {}) {
  const estado: Estado = { ativo: true, papel: 'ADMINISTRATIVO', membership: true, empresaAtiva: true, revogadaNaRevalidacao: false, commits: 0, log: [], ...parcial };
  const { tx, withTenantTransaction } = banco(estado);
  const chamadas: Array<{ servico: string; executor: unknown }> = [];
  const servico = (nome: string) => async (...args: unknown[]) => {
    const ctx = args.at(-1) as { executor?: unknown } | DbExecutor;
    chamadas.push({ servico: nome, executor: (ctx as { executor?: unknown })?.executor ?? ctx });
    estado.log.push(`servico:${nome}`);
    return { resultado: nome };
  };
  const rota = carregar('app/api/admin/contratos/[contratoId]/financeiro/[[...acao]]/route.ts', {
    'next/server': { NextResponse }, 'node:crypto': crypto, zod: { z },
    '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => sessao, tokenAdmin: () => 'token' },
    '@/lib/http/pagamentos-api': { erroPagamentoApi },
    '@/lib/pagamentos/services/financeiro-consulta.service': { consultarPainelFinanceiro: servico('consultarPainelFinanceiro') },
    '@/lib/pagamentos/services/alteracao-financeira.service': { iniciarTratamento: servico('iniciarTratamento'), cancelarTratamento: servico('cancelarTratamento'), simularAlteracao: servico('simularAlteracao'), resolverAlteracao: servico('resolverAlteracao'), simularPosicao: () => ({}) },
    '@/lib/pagamentos/services/cronograma.service': { reprogramarCronograma: servico('reprogramarCronograma') },
    '@/lib/pagamentos/services/devolucao.service': { solicitarDevolucao: servico('solicitarDevolucao'), concluirDevolucao: servico('concluirDevolucao'), cancelarDevolucao: servico('cancelarDevolucao'), anexarComprovanteDevolucao: servico('anexarComprovanteDevolucao') },
    '@/lib/pagamentos/services/alteracao-financeira-core': { recusarFinanceiro },
    '@/lib/pagamentos/repositories/alteracao-financeira.repository': { lerPosicaoFinanceira: async () => ({}), serializarFinanceiro: (x: unknown) => x },
    '@/lib/contratos/services/contrato-tenant': contratoTenant,
    '@/lib/saas/provar-tenant': { withTenantTransaction },
  });
  type Handler = (r: unknown, c: unknown) => Promise<Response>;
  const ctx = (contratoId: string, acao: string[] = []) => ({ params: Promise.resolve({ contratoId, acao }) });
  const hash = 'a'.repeat(64);
  const acoes = {
    'GET painel': (c: string) => (rota.GET as Handler)(pedido('/x'), ctx(c)),
    'GET comprovante de devolução': (c: string) => (rota.GET as Handler)(pedido('/x'), ctx(c, ['devolucoes', id(50), 'comprovantes', id(51)])),
    'POST solicitar devolução': (c: string) => (rota.POST as Handler)(pedido('/x', { posicaoHash: hash, valorCentavos: '100', beneficiario: { nome: 'Fulano' }, motivo: 'm', origens: [{ alocacaoId: id(52), valorCentavos: '100' }] }), ctx(c, ['devolucoes'])),
    'POST cancelar devolução': (c: string) => (rota.POST as Handler)(pedido('/x', { motivo: 'm' }), ctx(c, ['devolucoes', id(50), 'cancelar'])),
    'POST cancelar tratamento': (c: string) => (rota.POST as Handler)(pedido('/x', { motivo: 'm' }), ctx(c, ['tratamentos', id(53), 'cancelar'])),
    'POST iniciar tratamento': (c: string) => (rota.POST as Handler)(pedido('/x', { posicaoHash: hash }), ctx(c, ['pendencias', id(54), 'tratamentos'])),
  };
  return { estado, tx, chamadas, acoes };
}

test('C1/C2 financeiro por contrato: leitura, download e ações no MESMO tx da prova; outra empresa ⇒ 404 sem nada lido; revogação ⇒ 403', async () => {
  for (const acao of Object.keys(financeiro().acoes) as Array<keyof ReturnType<typeof financeiro>['acoes']>) {
    const a = financeiro();
    const r = await a.acoes[acao](CON_A);
    assert.ok(r.status < 300, `${acao}: ${r.status}`);
    if (acao === 'GET comprovante de devolução') assert.ok(a.estado.log.indexOf('posse') < a.estado.log.indexOf('le-comprovante'));
    else assert.equal(a.chamadas[0].executor, a.tx, `${acao}: serviço no tx da prova`);
    for (const alvo of [CON_B, CON_LEGADO, INEXISTENTE]) {
      const b = financeiro();
      assert.equal((await b.acoes[acao](alvo)).status, 404, `${acao} ${alvo}`);
      assert.equal(b.chamadas.length, 0);
      assert.equal(b.estado.log.includes('le-comprovante'), false);
    }
    const revogado = financeiro({ membership: false });
    assert.equal((await revogado.acoes[acao](CON_A)).status, 403, `${acao}: membership revogada`);
    assert.equal(revogado.chamadas.length, 0);
  }
});

test('C2 estrutural: serviços financeiros sensíveis rodam no executor recebido (sem transação paralela); parcela do estorno amarrada ao pagamento', () => {
  const ler = (f: string) => readFileSync(f, 'utf8');
  const pag = ler('lib/pagamentos/services/pagamento.service.ts');
  for (const fn of ['criarPagamentoDoFechamento(\n  input: PedidoPagamentoInicial', 'substituirPlanoPagamento(', 'registrarEstornoPagamento(', 'registrarComprovantePagamento(', 'confirmarRecebimentoPagamento(']) {
    const corpo = pag.replace(/\r\n/g, '\n').slice(pag.replace(/\r\n/g, '\n').indexOf(`export async function ${fn}`));
    const abertura = corpo.slice(0, corpo.indexOf('async (tx) =>'));
    assert.match(abertura, /return naTransacao\(context\.executor, $/, fn);
  }
  assert.match(pag, /if \(context\.executor\) return executar\(context\.executor\);/, 'recebimento já usava o executor');
  assert.match(pag, /planoDaParcela\?\.pagamento_id !== pagamento\.id\) throw new PagamentoServiceError\("PARCELA_NAO_ENCONTRADA"/);
  for (const f of ['devolucao', 'cronograma', 'alteracao-financeira']) {
    const fonte = ler(`lib/pagamentos/services/${f}.service.ts`);
    assert.doesNotMatch(fonte, /withTransaction\(/, `${f}: nenhuma transação própria nas ações por contrato`);
  }
  assert.match(ler('lib/pagamentos/services/transacao.ts'), /return executor \? trabalho\(executor\) : withTransaction\(trabalho\);/);
  // Rotas: nenhuma chamada de serviço fora do helper atômico.
  for (const f of ['route.ts', '[pagamentoId]/comprovantes/route.ts', '[pagamentoId]/estornos/route.ts', '[pagamentoId]/plano/route.ts', '[pagamentoId]/recebimentos/route.ts']) {
    const fonte = ler(`app/api/admin/pagamentos/${f}`);
    assert.doesNotMatch(fonte, /const data = await (obter|criar|registrar|substituir)\w+\(/, `${f}: serviço chamado fora da transação do tenant`);
  }
});

test('D2: o lock do recebimento no estorno exige o pagamento provado no próprio WHERE; recebimento de outro pagamento não é travado', async () => {
  const repo = carregar('lib/pagamentos/repositories/pagamento.repository.ts', { '../../db/postgres': { db: () => { throw new Error('db() global proibido'); } } });
  const bloquear = repo.bloquearRecebimentoDoPagamento as (recebimentoId: string, pagamentoId: string, tx: DbExecutor) => Promise<{ id: string; pagamentoId: string } | null>;
  const [REC_A, REC_B] = [id(40), id(42)];
  const linhas = [{ id: REC_A, pagamento_id: PAG_A, status: 'CONFIRMADO', valor_bruto: '40.00' }, { id: REC_B, pagamento_id: PAG_B, status: 'CONFIRMADO', valor_bruto: '40.00' }];
  const travadas: string[] = [];
  const consultas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push(sql);
      assert.match(sql, /FROM pagamento_recebimentos\s+WHERE id = \$1::uuid\s+AND pagamento_id = \$2::uuid\s+LIMIT 1\s+FOR UPDATE/);
      // Semântica do PostgreSQL: FOR UPDATE só trava as linhas que satisfazem o WHERE.
      const casadas = linhas.filter((l) => l.id === values[0] && l.pagamento_id === values[1]);
      travadas.push(...casadas.map((l) => l.id));
      return { rows: casadas as unknown as Row[], rowCount: casadas.length };
    },
  };
  assert.equal((await bloquear(REC_A, PAG_A, tx))?.pagamentoId, PAG_A, 'recebimento próprio é travado');
  assert.equal(await bloquear(REC_B, PAG_A, tx), null, 'recebimento de outro pagamento/empresa: não encontrado');
  assert.equal(await bloquear(id(99), PAG_A, tx), null, 'inexistente: a mesma resposta');
  assert.deepEqual(travadas, [REC_A], 'nenhuma linha estrangeira recebeu FOR UPDATE');
  assert.equal(consultas.length, 3);

  // Serviço: o estorno usa só o lock escopado, depois de travar o pagamento provado; nada de lock por id solto.
  const pag = readFileSync('lib/pagamentos/services/pagamento.service.ts', 'utf8').replace(/\r\n/g, '\n');
  const estorno = pag.slice(pag.indexOf('export async function registrarEstornoPagamento('), pag.indexOf('\n}\n', pag.indexOf('export async function registrarEstornoPagamento(')));
  assert.match(estorno, /const recebimento = await bloquearRecebimentoDoPagamento\(input\.recebimentoId, pagamento\.id, tx\);/);
  assert.ok(estorno.indexOf('bloquearPagamento(input.pagamentoId, tx)') < estorno.indexOf('bloquearRecebimentoDoPagamento('), 'ordem de travas: pagamento → recebimento');
  assert.doesNotMatch(estorno, /buscarRecebimentoPorId\([^)]*forUpdate/, 'nenhum FOR UPDATE por id sem o pagamento no WHERE');
  // Resposta não enumerável: não encontrado, de outro pagamento e não confirmado ⇒ o mesmo erro.
  assert.match(estorno, /if \(!recebimento \|\| recebimento\.pagamentoId !== pagamento\.id \|\| recebimento\.status !== "CONFIRMADO"\) \{\n\s+throw new PagamentoServiceError\("ESTORNO_INVALIDO", "O estorno exige recebimento confirmado deste Pagamento\.", 409\);/);
});

test('E3/F3: confirmarRecebimentoPagamento exige o pagamento provado e o executor do tenant (obrigatório) e só trava recebimento DESTE pagamento', () => {
  const pag = readFileSync('lib/pagamentos/services/pagamento.service.ts', 'utf8').replace(/\r\n/g, '\n');
  const ini = pag.indexOf('export async function confirmarRecebimentoPagamento(');
  const corpo = pag.slice(ini, pag.indexOf('\n}\n', ini));
  assert.match(pag, /export type ContextoPagamentoNoTenant = PagamentoServiceContext & \{ executor: DbExecutor; tenant: Pick<TenantComprovado, "empresaComprovada"> \};/);
  assert.match(corpo, /confirmarRecebimentoPagamento\(\n  pagamentoId: string,\n  recebimentoId: string,\n  context: ContextoPagamentoNoTenant,\n\)/);
  assert.match(corpo, /\{\n  const \{ tx, empresaId \} = exigirExecutorDoTenant\(context\);\n  if \(!await pagamentoPertenceAoTenant\(tx, empresaId, pagamentoId\)\) throw new PagamentoServiceError\("RECEBIMENTO_NAO_ENCONTRADO", "Recebimento não encontrado\.", 404\);\n  const travado = await bloquearPagamento\(pagamentoId, tx\);\n  const recebimento = travado \? await bloquearRecebimentoDoPagamento\(recebimentoId, travado\.id, tx\) : null;/);
  assert.doesNotMatch(corpo, /buscarRecebimentoPorId|withTransaction\(|naTransacao\(/, 'o UUID do recebimento não define o pagamento; sem transação própria');
});

test('F3: sem executor ou sem tenant comprovado a confirmação recusa antes de qualquer consulta e nunca abre transação própria', () => {
  const code = ts.transpileModule(readFileSync('lib/pagamentos/services/transacao.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod: Record<string, unknown> = {};
  let abertas = 0;
  new Function('require', 'exports', code)(() => ({ withTransaction: () => { abertas++; } }), mod);
  const exigir = mod.exigirExecutorDoTenant as (c: unknown) => { tx: unknown; empresaId: string };
  const tx = { query: async () => { throw new Error('nenhuma consulta'); } };
  for (const c of [undefined, null, {}, { executor: tx }, { tenant: { empresaComprovada: 'e' } }, { executor: tx, tenant: {} }, { executor: tx, tenant: { empresaComprovada: '' } }]) {
    assert.throws(() => exigir(c), /exige a transação e o tenant comprovado/);
  }
  assert.deepEqual(exigir({ executor: tx, tenant: { empresaComprovada: 'e' } }), { tx, empresaId: 'e' });
  assert.equal(abertas, 0, 'nunca abre transação própria');
});
