import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cobrancaDestravada, decidirTravaCobranca, exigirCobrancaDestravada } from './trava-cobranca.ts';

/** B-25: a decisão da L2 e a amarração das entradas. A recusa em cada entrada, com linha presente, está na suíte PostgreSQL. */
const PROD = 'srv-dak77m2d0e5s73b8rkkg';
const STG = 'srv-daif418ae00c73e8k2gg';
const NOME = 'kidmais_staging';
const executor = (banco: string | null) => ({ query: async () => ({ rows: banco === null ? [] : [{ banco }], rowCount: 1 }) }) as never;

test('fecha em todo sinal de production, mesmo com os outros sinais dizendo staging', () => {
    const casos: Array<[Record<string, string>, string, string]> = [
        [{}, 'kidmais_production', 'BANCO_PRODUCTION'],
        [{ KIDMAIS_DEPLOY_ENV: 'staging', RENDER: 'true', RENDER_SERVICE_ID: STG }, 'kidmais_production', 'BANCO_PRODUCTION'],
        [{}, ' KIDMAIS_PRODUCTION ', 'BANCO_PRODUCTION'],
        [{ RENDER_SERVICE_ID: PROD }, NOME, 'SERVICO_PRODUCTION'],
        [{ RENDER_SERVICE_ID: ` ${PROD} ` }, NOME, 'SERVICO_PRODUCTION'],
        [{ KIDMAIS_DEPLOY_ENV: 'staging', RENDER: 'true', RENDER_SERVICE_ID: PROD }, NOME, 'SERVICO_PRODUCTION'],
        [{ KIDMAIS_DEPLOY_ENV: 'production' }, NOME, 'DEPLOY_PRODUCTION'],
        [{ KIDMAIS_DEPLOY_ENV: ' production ', RENDER: 'true', RENDER_SERVICE_ID: STG }, NOME, 'DEPLOY_PRODUCTION'],
    ];
    for (const [env, banco, motivo] of casos)
        assert.deepEqual(decidirTravaCobranca(env, banco), { aberta: false, motivo }, JSON.stringify([env, banco]));
});

test('ambiente não reconhecido e sinais contraditórios fecham', () => {
    const casos: Array<Record<string, string>> = [
        { RENDER: 'true' },
        { RENDER: 'true', RENDER_SERVICE_ID: STG },
        { RENDER_SERVICE_ID: STG },
        { KIDMAIS_DEPLOY_ENV: 'qa' },
        { KIDMAIS_DEPLOY_ENV: 'Staging' },
        { KIDMAIS_DEPLOY_ENV: 'PRODUCTION' },
        { KIDMAIS_DEPLOY_ENV: 'staging', RENDER: 'true' },
    ];
    for (const env of casos)
        assert.deepEqual(decidirTravaCobranca(env, NOME), { aberta: false, motivo: 'AMBIENTE_NAO_RECONHECIDO' }, JSON.stringify(env));
    for (const banco of [null, undefined, '', '   '])
        assert.deepEqual(decidirTravaCobranca({}, banco), { aberta: false, motivo: 'BANCO_DESCONHECIDO' });
});

test('abre só em staging declarado, fora de production, e em execução local', () => {
    assert.deepEqual(decidirTravaCobranca({ KIDMAIS_DEPLOY_ENV: 'staging', RENDER: 'true', RENDER_SERVICE_ID: STG }, NOME), { aberta: true, via: 'STAGING' });
    assert.deepEqual(decidirTravaCobranca({ KIDMAIS_DEPLOY_ENV: ' staging ' }, NOME), { aberta: true, via: 'STAGING' });
    assert.deepEqual(decidirTravaCobranca({}, 'kidmais_local'), { aberta: true, via: 'LOCAL' });
    assert.deepEqual(decidirTravaCobranca({ KIDMAIS_DEPLOY_ENV: '', RENDER: ' ', RENDER_SERVICE_ID: '' }, 'kidmais_local'), { aberta: true, via: 'LOCAL' });
});

test('nenhuma flag abre: toda variável comercial ou de abertura é ignorada em production', () => {
    const tudoLigado = { CADASTRO_PUBLICO_ATIVO: 'true', ASSINATURA_PLANOS_ATIVOS: 'true', CREDITOS_COMPRA_ATIVA: 'true', COBRANCA_LIVE: 'true',
        COBRANCA_TRAVA_ABERTA: 'true', TRAVA_COBRANCA: 'aberta', KIDMAIS_COBRANCA_LIVE: 'true', ASAAS_AMBIENTE: 'producao' };
    assert.equal(decidirTravaCobranca({ ...tudoLigado, KIDMAIS_DEPLOY_ENV: 'production' }, NOME).aberta, false);
    assert.equal(decidirTravaCobranca({ ...tudoLigado }, 'kidmais_production').aberta, false);
    const fonte = readFileSync('lib/assinatura/trava-cobranca.ts', 'utf8');
    const lidas = [...fonte.matchAll(/\benv\.([A-Z_]+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(lidas, ['KIDMAIS_DEPLOY_ENV', 'RENDER', 'RENDER_SERVICE_ID'], 'a decisão não lê outra variável');
    assert.doesNotMatch(fonte.replace(/\/\*\*[\s\S]*?\*\//g, ''), /manifesto|aprovad/i, 'nenhum manifesto ou aprovação abre');
});

test('leitura do banco: sem linha fecha; erro sobe, nunca vira aberta; recusa é 503 sem dado do pedido', async () => {
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => { avisos.push(m); };
    try {
        assert.equal(await cobrancaDestravada(executor(null), 'p', {}), false);
        assert.equal(await cobrancaDestravada(executor('kidmais_local'), 'p', {}), true);
        await assert.rejects(cobrancaDestravada({ query: async () => { throw new Error('sem banco'); } } as never, 'p', {}), /sem banco/);
        await assert.rejects(exigirCobrancaDestravada(executor('kidmais_production'), 'ponto X', {}),
            (e: { code?: string; httpStatus?: number }) => e.code === 'COBRANCA_TRAVADA' && e.httpStatus === 503);
    }
    finally { console.warn = original; }
    assert.deepEqual(avisos, ['[trava cobrança] recusa em p: BANCO_DESCONHECIDO.', '[trava cobrança] recusa em ponto X: BANCO_PRODUCTION.']);
});

test('amarração: a guarda é o primeiro passo de cada ponto, e o pedido de cadastro recusa antes do after()', () => {
    const primeiroPasso: Array<[string, RegExp]> = [
        ['lib/desenvolvedor/comercial.ts', /comPosCommit\(deps\.withTransaction, async \(tx, depois\) => \{\s*await exigirCobrancaDestravada\(tx, 'operarComercial'\);/],
        ['lib/desenvolvedor/creditos.ts', /return await deps\.withTransaction\(async \(tx\) => \{\s*if \(op\.acao !== 'simular_corte'\) await exigirCobrancaDestravada\(tx, 'operarCreditos'\);/],
        ['lib/desenvolvedor/cobranca.ts', /return deps\.withTransaction\(async \(tx\) => \{\s*await exigirCobrancaDestravada\(tx, 'sincronizarCobrancaEmpresa'\);/],
        ['lib/desenvolvedor/cobranca.ts', /withTransaction\(async \(tx\) => \{\s*await exigirCobrancaDestravada\(tx, 'liberarIntencaoCobranca'\);/],
        ['lib/assinatura/arrependimento.ts', /async \(tx, tenant\) => \{\s*await exigirCobrancaDestravada\(tx, 'registrarArrependimento', env\);/],
        ['lib/assinatura/cobranca.ts', /async \(tx, tenant\) => \{\s*await exigirCobrancaDestravada\(tx, 'cancelarAssinatura', deps\.env \?\? process\.env\);/],
        ['lib/assinatura/devolucao.ts', /async \(tx, tenant\) => \{\s*await exigirCobrancaDestravada\(tx, 'solicitarEncerramento', env\);/],
        ['lib/creditos/compra.ts', /async \(tx, tenant\) => \{\s*await exigirCobrancaDestravada\(tx, 'criarPedido', env\);/],
        ['lib/creditos/devolucao.ts', /async \(tx, tenant\) => \{\s*await exigirCobrancaDestravada\(tx, 'solicitarDevolucao', deps\.env \?\? process\.env\);/],
        ['lib/cadastro/publico.ts', /const r = await deps\.withTransaction\(async \(tx\) => \{\s*await exigirCobrancaDestravada\(tx, 'processarPedidoCadastro'\);/],
        ['lib/cadastro/publico.ts', /return await deps\.withTransaction\(async \(tx\) => \{\s*await exigirCobrancaDestravada\(tx, 'cadastrarEmpresa', env\);/],
        ['lib/assinatura/webhook-asaas.ts', /const triagem = await deps\.withTransaction\(async \(tx\) => \{\s*if \(!await cobrancaDestravada\(tx, 'webhook Asaas', deps\.env\)\)\s*return 503;/],
        ['lib/assinatura/renovacao-entrega.ts', /withTransaction\(async \(tx\) => \{\s*if \(!await cobrancaDestravada\(tx, 'webhook Resend', deps\.env\)\)\s*return 'TRAVADA' as const;/],
    ];
    for (const [arquivo, padrao] of primeiroPasso)
        assert.match(readFileSync(arquivo, 'utf8'), padrao, arquivo);
    const checkout = readFileSync('lib/assinatura/cobranca.ts', 'utf8');
    assert.equal(checkout.split("exigirCobrancaDestravada(tx, 'iniciarAssinatura', env)").length - 1, 2, 'os dois caminhos do checkout');

    const rota = readFileSync('app/api/cadastro/route.ts', 'utf8');
    const post = rota.slice(rota.indexOf('export async function POST'));
    assert.ok(post.indexOf('await exigirPedidoCadastroDestravado()') > post.indexOf('exigirCadastroAtivo()'), 'L1 e depois L2');
    assert.ok(post.indexOf('await exigirPedidoCadastroDestravado()') < post.indexOf('after('), 'antes do after()');

    // Leituras seguem sem guarda: a rota de pendências, a simulação e o GET dos pontos administrativos.
    assert.doesNotMatch(readFileSync('lib/assinatura/liberacao-intencao.ts', 'utf8'), /Destravada/);
    const painel = readFileSync('lib/desenvolvedor/cobranca.ts', 'utf8');
    assert.doesNotMatch(painel.slice(painel.indexOf('export async function pendenciasCobrancaEmpresa'), painel.indexOf('export async function liberarIntencaoCobranca')), /Destravada/);
    const resend = readFileSync('lib/assinatura/renovacao-entrega.ts', 'utf8');
    assert.ok(resend.indexOf("cobrancaDestravada(tx, 'webhook Resend'") > resend.indexOf('EVENTOS_FALHA_ENTREGA.get(evento.type)'),
        'autenticação, corpo inválido e evento que não é de falha seguem com as respostas atuais');
    assert.match(resend, /resultado === 'OCUPADO' \|\| resultado === 'TRAVADA'\)\s*return resposta\(503\);/);
});
