import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** G2: entrada restrita da renovação (scripts/assinatura-renovar-restrito.cjs), offline: nenhuma conexão nem rede. */
const req = createRequire(import.meta.url);
const cli = req('../../scripts/assinatura-renovar-restrito.cjs');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const LOCAL = { ASAAS_AMBIENTE: 'sandbox', KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://sintetico:teste@127.0.0.1:55475/kidmais_renovacao_sintetica',
    KIDMAIS_RECONCILIAR_ALVO: 'kidmais_renovacao_sintetica@127.0.0.1:55475' };
const STAGING = { ASAAS_AMBIENTE: 'sandbox', RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging',
    KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://sintetico@dpg-daidko3m8hqs73ce4jt0-a/kidmais_staging_1z91',
    KIDMAIS_RECONCILIAR_ALVO: 'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432' };
const semArquivo = () => { throw new Error('não deve ler arquivo'); };

test('lista explícita obrigatória: vazia, ausente, inválida, repetida, acima do teto ou dupla é recusada', () => {
    const recusas: string[][] = [[], ['--aplicar'], ['--empresas='], ['--empresas=,'], ['--empresas=nao-uuid'], [`--empresas=${A},${A}`],
        [`--empresas=${A}`, '--empresas-arquivo=x.json'], [`--empresas=${A}`, `--empresas=${B}`], [`--empresas=${A}`, '--todas'],
        [`--empresas=${Array.from({ length: cli.MAX_EMPRESAS + 1 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`).join(',')}`]];
    for (const argv of recusas)
        assert.throws(() => cli.configuracaoRestrita(LOCAL, argv, semArquivo), Error, argv.join(' ').slice(0, 60));
    const c = cli.configuracaoRestrita(LOCAL, [`--empresas=${A}, ${B.toUpperCase()}`], semArquivo);
    assert.deepEqual(c.empresas, [A, B]); assert.equal(c.aplicar, false, 'simulação por padrão'); assert.equal(c.agora, null);
});

test('lista em arquivo JSON (lista ou { empresas }); arquivo vazio ou fora do formato é recusado', () => {
    const ler = (conteudo: string) => () => conteudo;
    assert.deepEqual(cli.configuracaoRestrita(LOCAL, ['--empresas-arquivo=l.json'], ler(JSON.stringify([A]))).empresas, [A]);
    assert.deepEqual(cli.configuracaoRestrita(LOCAL, ['--empresas-arquivo=l.json'], ler(JSON.stringify({ empresas: [B, A] }))).empresas, [B, A]);
    for (const ruim of ['[]', '{}', 'nao-json', JSON.stringify({ empresas: [] }), JSON.stringify([1])])
        assert.throws(() => cli.configuracaoRestrita(LOCAL, ['--empresas-arquivo=l.json'], ler(ruim)), Error, ruim);
});

test('produção, outros serviços Render (inclusive cron), Asaas fora do sandbox e bancos proibidos são recusados antes de conectar', () => {
    const argv = [`--empresas=${A}`];
    for (const troca of [{ KIDMAIS_DEPLOY_ENV: 'production' }, { RENDER_SERVICE_ID: cli.SERVICO_PRODUCAO }, { ASAAS_AMBIENTE: 'production' },
        { RENDER: 'true' }, { RENDER: 'true', RENDER_SERVICE_ID: 'crn-db493i142hec73ahmoe0', KIDMAIS_DEPLOY_ENV: 'staging' },
        { KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://x@127.0.0.1:5432/kidmais_manager', KIDMAIS_RECONCILIAR_ALVO: 'kidmais_manager@127.0.0.1:5432' },
        { KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://x@db.example/kidmais_staging_1z91', KIDMAIS_RECONCILIAR_ALVO: 'kidmais_staging_1z91@db.example:5432' }])
        assert.throws(() => cli.configuracaoRestrita({ ...LOCAL, ...troca }, argv, semArquivo), Error, JSON.stringify(troca));
    for (const troca of [{ KIDMAIS_DEPLOY_ENV: 'production' }, { RENDER_SERVICE_ID: cli.SERVICO_PRODUCAO }, { RENDER_SERVICE_ID: 'srv-outro' }, { KIDMAIS_DEPLOY_ENV: undefined },
        { KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://x@dpg-daidko3m8hqs73ce4jt0-a/outro_banco', KIDMAIS_RECONCILIAR_ALVO: 'outro_banco@dpg-daidko3m8hqs73ce4jt0-a:5432' }])
        assert.throws(() => cli.configuracaoRestrita({ ...STAGING, ...troca }, argv, semArquivo), Error, JSON.stringify(troca));
    assert.equal(cli.configuracaoRestrita(STAGING, argv, semArquivo).alvo.database, 'kidmais_staging_1z91');
    assert.throws(() => cli.configuracaoRestrita({ ...LOCAL, KIDMAIS_RECONCILIAR_ALVO: undefined }, argv, semArquivo), /KIDMAIS_RECONCILIAR_ALVO/);
});

test('aplicação: local só com e-mail em arquivo, staging só com Resend; --agora só ISO com fuso e junto da lista', () => {
    assert.throws(() => cli.configuracaoRestrita(LOCAL, [`--empresas=${A}`, '--aplicar'], semArquivo));
    assert.equal(cli.configuracaoRestrita({ ...LOCAL, EMAIL_PROVIDER: 'arquivo' }, [`--empresas=${A}`, '--aplicar'], semArquivo).aplicar, true);
    assert.throws(() => cli.configuracaoRestrita({ ...STAGING, EMAIL_PROVIDER: 'arquivo' }, [`--empresas=${A}`, '--aplicar'], semArquivo));
    assert.equal(cli.configuracaoRestrita({ ...STAGING, EMAIL_PROVIDER: 'resend' }, [`--empresas=${A}`, '--aplicar'], semArquivo).aplicar, true);
    const c = cli.configuracaoRestrita(LOCAL, [`--empresas=${A}`, '--agora=2027-09-09T12:00:00-03:00'], semArquivo);
    assert.equal(c.agora.toISOString(), '2027-09-09T15:00:00.000Z');
    for (const ruim of ['--agora=2027-09-09', '--agora=amanha', '--agora=2027-02-30T12:00:00Z', '--agora='])
        assert.throws(() => cli.configuracaoRestrita(LOCAL, [`--empresas=${A}`, ruim], semArquivo), Error, ruim);
    assert.throws(() => cli.configuracaoRestrita(LOCAL, ['--agora=2027-09-09T12:00:00Z'], semArquivo), /lista de empresas/);
});

test('execução: só a lista, em ordem; resumo sanitizado por empresa; revisão, erro ou empresa sem Fundador acionam alerta', async () => {
    const processadas: string[] = [];
    const estados: Record<string, unknown> = {
        [A]: { email: 'gestor@example.invalid', registro: { estado: 'AVISADA', ultimoErro: null, mensagem: { para: 'gestor@example.invalid' } } },
        [B]: { email: 'outro@example.invalid', registro: { estado: 'REVISAO', ultimoErro: 'JANELA_AVISO_PERDIDA' } },
    };
    const ok = await cli.executarRestrito({ empresas: [A], processar: async (e: string) => { processadas.push(e); return 'AGUARDANDO_ULTIMA_PARCELA'; }, ler: async (e: string) => estados[e] });
    assert.equal(ok.alerta, false);
    assert.deepEqual(ok.itens, [{ empresaId: A, resultado: 'AGUARDANDO_ULTIMA_PARCELA', estadoAntes: 'AVISADA', estadoDepois: 'AVISADA', motivo: null, erro: null }]);
    assert.doesNotMatch(JSON.stringify(ok), /@/, 'sem e-mail ou destinatário');

    const falha = new Error('mensagem com gestor@example.invalid'); falha.name = 'AsaasFalhou';
    const r = await cli.executarRestrito({ empresas: [B, A], ler: async (e: string) => estados[e],
        processar: async (e: string) => { processadas.push(e); if (e === A) throw falha; return 'JANELA_AVISO_PERDIDA'; } });
    assert.deepEqual(processadas, [A, B, A]);
    assert.equal(r.alerta, true);
    assert.deepEqual(r.resultados, { JANELA_AVISO_PERDIDA: 1, ERRO_REPROCESSAVEL: 1 });
    assert.equal(r.itens[1].erro, 'AsaasFalhou'); assert.doesNotMatch(JSON.stringify(r), /@/, 'mensagem de erro não vaza');

    const sem = await cli.executarRestrito({ empresas: [A], processar: async () => 'SEM_FUNDADOR', ler: async () => null });
    assert.equal(sem.alerta, true); assert.equal(sem.itens[0].estadoDepois, 'SEM_FUNDADOR');
    const cancelada = await cli.executarRestrito({ empresas: [A], processar: async () => 'CANCELADA', ler: async () => ({ registro: { estado: 'CANCELADA', ultimoErro: null } }) });
    assert.equal(cancelada.alerta, false);
});

test('processo real sem lista sai com 1 antes de conectar; nenhum cron, render.yaml ou package.json chama a entrada restrita', () => {
    const r = spawnSync(process.execPath, ['scripts/assinatura-renovar-restrito.cjs'], { encoding: 'utf8', env: {} as NodeJS.ProcessEnv });
    assert.equal(r.status, 1); assert.match(r.stderr, /Execução global é recusada/);
    for (const f of ['render.yaml', 'package.json', 'scripts/assinatura-cron.cjs'])
        if (existsSync(f)) assert.doesNotMatch(readFileSync(f, 'utf8'), /assinatura-renovar-restrito/, f);
    const fonte = readFileSync('scripts/assinatura-renovar-restrito.cjs', 'utf8');
    assert.doesNotMatch(fonte, /process\.env\.DATABASE_URL|readFileSync\([^)]*\.env/);
    assert.match(fonte, /relogioReal: \(\) => new Date\(\)/, 'G1: janela de 23 h no relógio real com --agora');
});
