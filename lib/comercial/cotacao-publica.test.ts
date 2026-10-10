import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';
import type { DbExecutor } from '../db/contracts';
import { apiPublica, paginaPublica } from '../fechamentos/rota-publica.ts';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNIDADE_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const UNIDADE_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const KIDMAIS = '7e990a2b-e64b-4630-9aae-4646fe936ede';
const LIGADO = { COTACAO_PUBLICA_POR_EMPRESA: 'true' };

type Escopo = { empresaId: string; estabelecimentoId: string | null; porCodigo: boolean };
type Mod = {
    codigoEmpresaDoPedido(url: string): string | null;
    escopoCotacaoPublica(conexao: () => DbExecutor, codigo: string | null, opcoes?: { escrita?: boolean; exigirUnidade?: boolean }, env?: object, deps?: object): Promise<Escopo>;
};
const mod = carregarModulo('lib/comercial/cotacao-publica.ts', {}) as Mod;

type Cenario = { planos?: Record<string, boolean>; nivel?: Record<string, string>; instalada?: boolean; empresas?: Record<string, string> };
function ambiente(c: Cenario = {}) {
    const empresas = c.empresas ?? { 'buffet-a': A, 'buffet-b': B };
    const tx = executorFalso([
        [/to_regprocedure/, () => [{ instalada: c.instalada ?? true }]],
        [/FROM public\.empresas WHERE codigo/, (p) => empresas[p[0] as string] ? [{ id: empresas[p[0] as string] }] : []],
        [/kidmais062_unidade_agendavel/, (p) => p[0] === A ? [{ id: UNIDADE_A, codigo: 'a', nome: 'A' }] : p[0] === B ? [{ id: UNIDADE_B, codigo: 'b', nome: 'B' }] : []],
    ]);
    const chamadas: string[] = [];
    const deps = {
        recursoIncluido: async (_tx: DbExecutor, id: string, recurso: string) => { chamadas.push(`plano:${id}:${recurso}`); return c.planos?.[id] ?? true; },
        lerEstadoComercial: async (_tx: DbExecutor, id: string) => { chamadas.push(`estado:${id}`); return { acesso: { nivel: c.nivel?.[id] ?? 'COMPLETO' } }; },
        escopoCatalogoPublico: async () => { chamadas.push('servidor'); return { empresaId: KIDMAIS, estabelecimentoId: null }; },
    };
    const conexao = () => tx as unknown as DbExecutor;
    return { tx, chamadas, resolver: (codigo: string | null, opcoes = {}, env: object = LIGADO) => mod.escopoCotacaoPublica(conexao, codigo, opcoes, env, deps) };
}
const recusa = { code: 'COTACAO_PUBLICA_INDISPONIVEL', httpStatus: 404, message: 'Este endereço de orçamento não está disponível.' };

test('sem código: endereço atual da Kidmais continua só pela configuração do servidor, sem consultar código nem plano', async () => {
    const { resolver, chamadas, tx } = ambiente();
    assert.deepEqual(await resolver(null, {}, {}), { empresaId: KIDMAIS, estabelecimentoId: null, porCodigo: false });
    assert.deepEqual(chamadas, ['servidor']);
    assert.equal(tx.executados.length, 0);
});

test('código no pedido: ausente/vazio = endereço atual; formato inválido recusa sem tocar o banco', () => {
    assert.equal(mod.codigoEmpresaDoPedido('https://x/api/fechamentos/pacotes'), null);
    assert.equal(mod.codigoEmpresaDoPedido('https://x/api/fechamentos/pacotes?empresa='), null);
    assert.equal(mod.codigoEmpresaDoPedido('https://x/api/fechamentos/pacotes?empresa=buffet-a'), 'buffet-a');
    for (const ruim of ['A', 'x', 'buffet_a', "a'; drop", '-a', 'a-', '../a', 'a'.repeat(70)])
        assert.throws(() => mod.codigoEmpresaDoPedido(`https://x/api?empresa=${encodeURIComponent(ruim)}`), recusa, ruim);
});

test('chave desligada (padrão): todo endereço por código é 404, sem consultar o banco', async () => {
    for (const env of [{}, { COTACAO_PUBLICA_POR_EMPRESA: 'false' }, { COTACAO_PUBLICA_POR_EMPRESA: '1' }]) {
        const { resolver, tx, chamadas } = ambiente();
        await assert.rejects(resolver('buffet-a', {}, env), recusa);
        assert.equal(tx.executados.length + chamadas.length, 0);
    }
});

test('isolamento: cada código resolve só a própria empresa e unidade; código exato e empresa ATIVA', async () => {
    const { resolver, tx } = ambiente();
    assert.deepEqual(await resolver('buffet-a'), { empresaId: A, estabelecimentoId: UNIDADE_A, porCodigo: true });
    assert.deepEqual(await resolver('buffet-b'), { empresaId: B, estabelecimentoId: UNIDADE_B, porCodigo: true });
    const consulta = tx.executados.find((q) => /WHERE codigo/.test(q.sql))!;
    assert.match(consulta.sql, /codigo = \$1 AND status = 'ATIVA'/);
    assert.deepEqual(tx.executados.filter((q) => /WHERE codigo/.test(q.sql)).map((q) => q.params[0]), ['buffet-a', 'buffet-b']);
    assert.deepEqual(tx.executados.filter((q) => /unidade_agendavel/.test(q.sql)).map((q) => q.params[0]), [A, B]);
    await assert.rejects(resolver('buffet-c'), recusa, 'código inexistente ou empresa não ATIVA');
});

test('plano: sem orçamento online (Essencial) é 404 igual ao de empresa inexistente; outros planos atendem', async () => {
    const { resolver, chamadas } = ambiente({ planos: { [A]: false } });
    await assert.rejects(resolver('buffet-a'), recusa);
    assert.ok(chamadas.includes(`plano:${A}:ORCAMENTO_ONLINE`));
    assert.equal((await resolver('buffet-b')).empresaId, B);
});

test('situação comercial: bloqueada nunca atende; somente leitura consulta, mas não recebe pedido', async () => {
    const { resolver } = ambiente({ nivel: { [A]: 'BLOQUEADO', [B]: 'SOMENTE_LEITURA' } });
    await assert.rejects(resolver('buffet-a'), recusa);
    assert.equal((await resolver('buffet-b')).empresaId, B);
    await assert.rejects(resolver('buffet-b', { escrita: true }), recusa);
});

test('agenda sem 062 (global) não abre endereço de outra empresa', async () => {
    const { resolver } = ambiente({ instalada: false });
    await assert.rejects(resolver('buffet-a'), recusa);
});

test('falha ao ler plano ou estado vira o mesmo 404, sem detalhe', async () => {
    const { tx } = ambiente();
    const deps = {
        recursoIncluido: async () => { throw Object.assign(new Error('plano ilegível'), { code: 'PLANOS_NAO_DISPONIVEIS' }); },
        lerEstadoComercial: async () => ({ acesso: { nivel: 'COMPLETO' } }),
        escopoCatalogoPublico: async () => ({ empresaId: KIDMAIS, estabelecimentoId: null }),
    };
    await assert.rejects(mod.escopoCotacaoPublica(() => tx as unknown as DbExecutor, 'buffet-a', {}, LIGADO, deps), recusa);
});

test('endereços do navegador: atuais sem empresa; por empresa em /b/<código> e ?empresa=', () => {
    assert.equal(apiPublica('/api/fechamentos/pacotes'), '/api/fechamentos/pacotes');
    assert.equal(apiPublica('/api/fechamentos/pacotes', 'buffet-a'), '/api/fechamentos/pacotes?empresa=buffet-a');
    assert.equal(apiPublica('/api/disponibilidade?data=2026-11-01', 'buffet-a'), '/api/disponibilidade?data=2026-11-01&empresa=buffet-a');
    assert.equal(paginaPublica('/disponibilidade'), '/disponibilidade');
    assert.equal(paginaPublica('/fechamento', 'buffet-a'), '/b/buffet-a/fechamento');
});

test('rotas públicas: toda leitura/gravação de cotação passa pelo resolvedor; dados da instalação não vazam para outra empresa', () => {
    const fonte = (arquivo: string) => readFileSync(arquivo, 'utf8');
    for (const rota of ['pacotes', 'catalogo', 'adicionais', 'cotacao']) {
        const codigo = fonte(`app/api/fechamentos/${rota}/route.ts`);
        assert.match(codigo, /escopoCotacaoPublica\(db, codigoEmpresaDoPedido\(request\.nextUrl\)\)/, rota);
        assert.doesNotMatch(codigo, /escopoCatalogoPublico\(/, rota);
    }
    const post = fonte('app/api/fechamentos/route.ts');
    assert.match(post, /escopoCotacaoPublica\(db, codigoEmpresaDoPedido\(request\.nextUrl\), \{ escrita: true \}\)/);
    assert.match(post, /escopo\.porCodigo && dados\.data\.identidadeTipo !== "NOVO_CLIENTE"/);
    const agenda = fonte('app/api/disponibilidade/route.ts');
    assert.match(agenda, /codigo === null\s*\?\s*await escopoPublico\(db\)\s*:\s*await escopoCotacaoPublica\(db, codigo\)/);
    assert.match(agenda, /codigo === null \? lerComercialPublico\(\) : Promise\.resolve\(\{ pacoteOverrides: \[\], descontos: \[\] \}\)/);
    const pdf = fonte('app/api/fechamentos/tabela-pacotes/route.ts');
    assert.equal((pdf.match(/if \(deOutraEmpresa\(request\.url\)\)/g) ?? []).length, 2, 'HEAD e GET');
    for (const pagina of ['fechamento', 'disponibilidade'])
        assert.match(fonte(`app/b/[empresa]/${pagina}/page.tsx`), /await exigirEmpresaPublica\(params\)/, pagina);
    assert.match(fonte('app/b/[empresa]/empresa-publica.ts'), /await escopoCotacaoPublica\(db, empresa\);\s*\} catch \{\s*notFound\(\);/);
});
