import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import * as calculos from './calculos.ts';

/**
 * P2 fase B — rotas do escritor com sessão, tenant e serviço simulados. Prova papéis (D-FIN-7), que empresa, ator e
 * "hoje" vêm do servidor e nunca do corpo, e que o 409 do serviço chega ao cliente como 409.
 */
const EMPRESA = '11111111-1111-4111-8111-111111111111';
const OUTRA = '99999999-9999-4999-8999-999999999999';
const ID = '33333333-3333-4333-8333-333333333333';
const ID2 = '55555555-5555-4555-8555-555555555555';
const HASH = 'a'.repeat(64);
const GESTAO = { empresaComprovada: EMPRESA, usuarioId: 'u-gestao', membershipId: 'm1', papelAtual: 'REPRESENTANTE_AUTORIZADO' };
const EQUIPE = { ...GESTAO, usuarioId: 'u-equipe', papelAtual: 'OPERADOR' };

function transpilar(arquivo: string, deps: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync(arquivo, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', js)((id: string) => { assert(id in deps, `Dependência não simulada: ${id}`); return deps[id]; }, exports);
  return exports;
}

type Cenario = {
  tenant?: typeof GESTAO;
  /** Simula `exigirApiAdminCrmDisponivel` recusando (somente leitura comercial, sessão ausente, CSRF). */
  sessaoRecusa?: PacoteAdminError;
  servicoErro?: PacoteAdminError;
};

function carregar(arquivo: string, cenario: Cenario = {}) {
  const chamadas: Array<{ funcao: string; args: unknown[] }> = [];
  const passos: string[] = [];
  const servico = (funcao: string) => async (...args: unknown[]) => {
    passos.push(funcao);
    chamadas.push({ funcao, args });
    if (cenario.servicoErro) throw cenario.servicoErro;
    return { reutilizado: false, id: 'novo' };
  };
  const rota = transpilar(arquivo, {
    zod: { z },
    '@/lib/financeiro/calculos': calculos,
    '@/lib/financeiro/http': { hojeIso: () => '2026-11-10', consultarFinanceiro: async () => new Response('{}') },
    '@/lib/financeiro/escritor-p2': {
      liquidarEntradaManual: servico('liquidarEntradaManual'),
      reverterPagamentoConta: servico('reverterPagamentoConta'),
      confirmarAbertura: servico('confirmarAbertura'),
      conferirPendencias: servico('conferirPendencias'),
      leituraAbertura: servico('leituraAbertura'),
      pagamentosDaConta: servico('pagamentosDaConta'),
    },
    '@/lib/http/api-response': {
      jsonNoStore: (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200 }),
      apiErrorResponse: (erro: unknown) => {
        if (erro instanceof PacoteAdminError) return new Response(JSON.stringify({ ok: false, codigo: erro.code, detalhes: erro.details }), { status: erro.httpStatus });
        if (erro instanceof z.ZodError) return new Response(JSON.stringify({ ok: false }), { status: 400 });
        throw erro;
      },
    },
    '@/lib/http/admin-crm-api': {
      exigirApiAdminCrmDisponivel: async () => { passos.push('sessao'); if (cenario.sessaoRecusa) throw cenario.sessaoRecusa; return { usuario_id: 'sessao' }; },
    },
    '@/lib/saas/provar-tenant': {
      withTenantTransaction: async (_s: unknown, empresaPedida: unknown, work: (tx: unknown, t: unknown) => Promise<unknown>) => {
        assert.equal(empresaPedida, null, 'a escrita nunca escolhe empresa pela requisição');
        passos.push('tenant');
        return work({ tx: true }, cenario.tenant ?? GESTAO);
      },
      // Mesma regra de lib/saas/provar-tenant.ts:145 (conferida no teste estático abaixo).
      exigirGestaoNoTenant: (tenant: typeof GESTAO, mensagem: string) => {
        passos.push('gestao');
        if (tenant.papelAtual !== 'REPRESENTANTE_AUTORIZADO') throw new PacoteAdminError('PAPEL_NAO_AUTORIZADO', mensagem, 403);
      },
    },
    '@/lib/assinatura/recursos-plano': { exigirRecursoPlano: async (_tx: unknown, empresa: string, recurso: string) => { passos.push(`plano:${recurso}:${empresa}`); } },
  });
  return { rota: rota as Record<string, (pedido: unknown, contexto?: unknown) => Promise<Response>>, chamadas, passos };
}

const pedido = (corpo: unknown) => ({ json: async () => corpo });
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

const LIQ = 'app/api/admin/financeiro/contas-receber/[parcelaId]/liquidacoes/route.ts';
const REV = 'app/api/admin/financeiro/contas-pagar/[contaId]/saidas/[saidaId]/reversoes/route.ts';
const AB = 'app/api/admin/financeiro/abertura/route.ts';
const CONF = 'app/api/admin/financeiro/abertura/conferencias/route.ts';
const corpoLiq = { valor: 100, data: '2026-11-09', forma: 'PIX', chave: 'chave-liq-0001' };
const corpoRev = { valor: 40, data: '2026-11-09', motivo: 'duplicidade', chave: 'chave-rev-0001' };
const corpoAb = { dataBase: '2026-11-01', saldo: -10.5, justificativa: 'extrato', versaoEsperada: 0, conjuntoHash: HASH, chave: 'chave-ab-0001' };
const corpoConf = { versaoAbertura: 1, itens: [{ tipo: 'SAIDA', origemId: ID, atributosHash: HASH }], chave: 'chave-conf-001' };

test('liquidação: Equipe liquida; empresa, ator e hoje vêm do servidor; o id do caminho é a entrada', async () => {
  const { rota, chamadas } = carregar(LIQ, { tenant: EQUIPE });
  const r = await rota.POST(pedido(corpoLiq), params({ parcelaId: ID }));
  assert.equal(r.status, 200);
  assert.deepEqual(chamadas[0].args.slice(1), [EMPRESA, 'u-equipe', '2026-11-10', { ...corpoLiq, entradaId: ID }]);
});

test('reversão: Equipe reverte com o plano completo; conta e pagamento vêm do caminho', async () => {
  const { rota, chamadas, passos } = carregar(REV, { tenant: EQUIPE });
  const r = await rota.POST(pedido(corpoRev), params({ contaId: ID, saidaId: ID2 }));
  assert.equal(r.status, 200);
  assert.deepEqual(chamadas[0].args.slice(1), [EMPRESA, 'u-equipe', '2026-11-10', { ...corpoRev, contaId: ID, saidaId: ID2 }]);
  assert.deepEqual(passos, ['sessao', 'tenant', `plano:FINANCEIRO_COMPLETO:${EMPRESA}`, 'reverterPagamentoConta']);
});

for (const [nome, arquivo, corpo] of [['abertura', AB, corpoAb], ['conferência', CONF, corpoConf]] as const) {
  test(`${nome}: Equipe recebe 403 e o serviço não é chamado; Gestão passa depois do plano`, async () => {
    const equipe = carregar(arquivo, { tenant: EQUIPE });
    const negado = await equipe.rota.POST(pedido(corpo));
    assert.equal(negado.status, 403);
    assert.equal((await negado.json()).codigo, 'PAPEL_NAO_AUTORIZADO');
    assert.equal(equipe.chamadas.length, 0);

    const gestao = carregar(arquivo, { tenant: GESTAO });
    assert.equal((await gestao.rota.POST(pedido(corpo))).status, 200);
    assert.deepEqual(gestao.passos.slice(0, 4), ['sessao', 'tenant', 'gestao', `plano:FINANCEIRO_COMPLETO:${EMPRESA}`]);
    assert.deepEqual(gestao.chamadas[0].args.slice(1, 3), [EMPRESA, 'u-gestao']);
  });
}

const TODAS: Array<[string, string, unknown, unknown]> = [
  ['liquidação', LIQ, corpoLiq, params({ parcelaId: ID })],
  ['reversão', REV, corpoRev, params({ contaId: ID, saidaId: ID2 })],
  ['abertura', AB, corpoAb, undefined],
  ['conferência', CONF, corpoConf, undefined],
];

for (const [nome, arquivo, corpo, contexto] of TODAS) {
  test(`${nome}: somente leitura (recusa da sessão) não abre transação nem chama o serviço`, async () => {
    const { rota, chamadas, passos } = carregar(arquivo, { sessaoRecusa: new PacoteAdminError('ASSINATURA_SOMENTE_LEITURA', 'Somente leitura.', 403) });
    const r = await rota.POST(pedido(corpo), contexto);
    assert.equal(r.status, 403);
    assert.deepEqual(passos, ['sessao']);
    assert.equal(chamadas.length, 0);
  });

  test(`${nome}: o corpo não consegue informar empresa, hoje ou ator (schema estrito)`, async () => {
    for (const extra of [{ empresaId: OUTRA }, { hoje: '2027-01-01' }, { atorId: 'x' }]) {
      const { rota, chamadas } = carregar(arquivo);
      const r = await rota.POST(pedido({ ...(corpo as object), ...extra }), contexto);
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(chamadas.length, 0);
    }
  });

  test(`${nome}: 409 do serviço (idempotência, versão, desligada) chega como 409 com os detalhes`, async () => {
    for (const codigo of ['IDEMPOTENCIA_CONFLITANTE', 'VERSAO_DIVERGENTE', 'OPERACAO_DESLIGADA']) {
      const { rota } = carregar(arquivo, { servicoErro: new PacoteAdminError(codigo, 'x', 409, { vigente: { versao: 2 } }) });
      const r = await rota.POST(pedido(corpo), contexto);
      assert.equal(r.status, 409);
      const json = await r.json();
      assert.equal(json.codigo, codigo);
      assert.deepEqual(json.detalhes, { vigente: { versao: 2 } });
    }
  });
}

test('caminho com id que não é uuid é 400 antes do serviço', async () => {
  const liq = carregar(LIQ);
  assert.equal((await liq.rota.POST(pedido(corpoLiq), params({ parcelaId: 'nao-uuid' }))).status, 400);
  const rev = carregar(REV);
  assert.equal((await rev.rota.POST(pedido(corpoRev), params({ contaId: ID, saidaId: 'x' }))).status, 400);
  assert.equal(liq.chamadas.length + rev.chamadas.length, 0);
});

test('validação do corpo: data mal formada, chave curta, motivo curto, hash inválido, lote vazio ou acima de 200', async () => {
  const casos: Array<[string, unknown, unknown]> = [
    [LIQ, { ...corpoLiq, data: '10/11/2026' }, params({ parcelaId: ID })],
    [LIQ, { ...corpoLiq, chave: 'curta' }, params({ parcelaId: ID })],
    [LIQ, { ...corpoLiq, valor: 0 }, params({ parcelaId: ID })],
    [REV, { ...corpoRev, motivo: ' a ' }, params({ contaId: ID, saidaId: ID2 })],
    [AB, { ...corpoAb, conjuntoHash: 'A'.repeat(64) }, undefined],
    [AB, { ...corpoAb, versaoEsperada: -1 }, undefined],
    [CONF, { ...corpoConf, itens: [] }, undefined],
    [CONF, { ...corpoConf, itens: Array.from({ length: 201 }, () => corpoConf.itens[0]) }, undefined],
    [CONF, { ...corpoConf, itens: [{ ...corpoConf.itens[0], tipo: 'OUTRO' }] }, undefined],
  ];
  for (const [arquivo, corpo, contexto] of casos) {
    const { rota, chamadas } = carregar(arquivo);
    assert.equal((await rota.POST(pedido(corpo), contexto)).status, 400, `${arquivo} ${JSON.stringify(corpo).slice(0, 80)}`);
    assert.equal(chamadas.length, 0);
  }
});

test('estático: a regra de Gestão simulada é a mesma do código e as rotas de abertura a chamam antes do serviço', () => {
  const tenant = readFileSync('lib/saas/provar-tenant.ts', 'utf8');
  assert.match(tenant, /export function exigirGestaoNoTenant\(tenant: TenantComprovado, mensagem: string\): void \{\s+if \(tenant\.papelAtual !== "REPRESENTANTE_AUTORIZADO"\) throw new PacoteAdminError\("PAPEL_NAO_AUTORIZADO", mensagem, 403\);/);
  for (const arquivo of [AB, CONF]) {
    const fonte = readFileSync(arquivo, 'utf8');
    const post = fonte.slice(fonte.indexOf('export async function POST'));
    assert.ok(post.indexOf('exigirGestaoNoTenant') > 0 && post.indexOf('exigirGestaoNoTenant') < post.search(/confirmarAbertura\(|conferirPendencias\(/), arquivo);
  }
  for (const arquivo of [LIQ, REV]) assert.doesNotMatch(readFileSync(arquivo, 'utf8'), /exigirGestaoNoTenant/, `${arquivo}: Equipe também opera`);
});

test('estático: a guarda da operação fica no serviço, antes de qualquer leitura de negócio', () => {
  const fonte = readFileSync('lib/financeiro/escritor-p2.ts', 'utf8');
  for (const [funcao, op] of [['liquidarEntradaManual', 'LIQUIDACAO'], ['reverterPagamentoConta', 'REVERSAO'], ['confirmarAbertura', 'ABERTURA'], ['conferirPendencias', 'ABERTURA']]) {
    const corpo = fonte.slice(fonte.indexOf(`export async function ${funcao}`));
    const primeira = corpo.slice(corpo.indexOf('{') + 1).trim().split(/\r?\n/)[0];
    assert.equal(primeira, `await exigirEscritaP2(tx, "${op}");`, funcao);
  }
});
