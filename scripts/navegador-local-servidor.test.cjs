/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do servidor do navegador local: nenhum banco, nenhum servidor, nenhuma rede. Os arquivos .env usados
// aqui são SINTÉTICOS, criados em pasta temporária (nunca os do repositório).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v = require('./navegador-local-servidor.cjs');

const BANCO = 'kidmais_navegador_20261010';
const PAI = Object.freeze({Path:'C:\\Windows', SystemRoot:'C:\\Windows', TEMP:'C:\\Temp', DATABASE_URL:'postgresql://u:segredo-real@dpg-exemplo.render.com/kidmais_staging_1z91',
    PGPASSWORD:'segredo-real', OPENAI_API_KEY:'sk-real', DEEPSEEK_API_KEY:'real', RESEND_API_KEY:'re_real', ASAAS_API_KEY:'$aact_hmlg_real',
    HTTP_PROXY:'http://proxy.exemplo.com:8080', NODE_OPTIONS:'--require ./x.js', RENDER:'true', KIDMAIS_DEPLOY_ENV:'staging', ADMIN_AUTH_SECRET:'real'});
const ambiente = (extra = {}) => ({...v.montarAmbiente(PAI, BANCO), ...extra});
const temporaria = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kidmais-nav-env-'));

test('modo: autoverificação offline por padrão; execução só com a flag única', () => {
    assert.equal(v.modo([]), 'PLANO');
    assert.equal(v.modo(['--plano']), 'PLANO');
    assert.equal(v.modo([v.FLAG]), 'EXECUTAR');
    for (const argv of [[v.FLAG, '--plano'], ['--iniciar'], [v.FLAG, v.FLAG]]) assert.equal(v.modo(argv), null);
});

test('ambiente do filho é montado do zero: nada herdado além do sistema', () => {
    const env = ambiente();
    assert.equal(env.Path, 'C:\\Windows');
    for (const nome of ['PGPASSWORD', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'RESEND_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS', 'RENDER'])
        assert.equal(env[nome], undefined, nome);
    assert.equal(env.DATABASE_URL, `postgresql://kidmais_navegador@127.0.0.1:55481/${BANCO}`);
    assert.equal(env.KIDMAIS_DEPLOY_ENV, 'local');
    assert.equal(env.ASAAS_API_KEY, v.ASAAS_CHAVE_DESLIGADA);
    assert.notEqual(env.ADMIN_AUTH_SECRET, 'real');
    assert.notEqual(v.montarAmbiente(PAI, BANCO).ADMIN_AUTH_SECRET, env.ADMIN_AUTH_SECRET, 'segredos novos a cada execução');
    assert.deepEqual(v.validarAmbiente(env), []);
});

test('autoverificação pura recusa alvo, host, chave e segredo fora do local, citando só NOMES', () => {
    const casos = [
        [{OPENAI_API_KEY:'sk-real'}, ['VARIAVEL_INESPERADA:OPENAI_API_KEY', 'VARIAVEL_PROIBIDA:OPENAI_API_KEY']],
        [{PGHOST:'dpg-exemplo.render.com'}, ['VARIAVEL_INESPERADA:PGHOST', 'VARIAVEL_PROIBIDA:PGHOST']],
        [{DATABASE_URL:'postgresql://u:segredo-real@dpg-exemplo.render.com/kidmais_staging_1z91'}, ['HOST_NAO_LOCAL:DATABASE_URL', 'DATABASE_URL_FORA_DO_ALVO']],
        [{DATABASE_URL:'postgresql://kidmais_navegador@127.0.0.1:55481/kidmais_manager'}, ['DATABASE_URL_FORA_DO_ALVO']],
        [{DATABASE_URL:'postgresql://kidmais_navegador@127.0.0.1:5432/kidmais_navegador_x'}, ['DATABASE_URL_FORA_DO_ALVO']],
        [{DATABASE_URL:'postgresql://kidmais_navegador:senha@127.0.0.1:55481/kidmais_navegador_x'}, ['DATABASE_URL_FORA_DO_ALVO']],
        [{ADMIN_AUTH_ORIGIN:'https://kidmais-manager-staging.onrender.com'}, ['HOST_NAO_LOCAL:ADMIN_AUTH_ORIGIN', 'VALOR_INESPERADO:ADMIN_AUTH_ORIGIN']],
        [{CONVITES_PUBLIC_ORIGIN:'https://kidmais.com.br'}, ['HOST_NAO_LOCAL:CONVITES_PUBLIC_ORIGIN']],
        [{ASAAS_API_KEY:'$aact_hmlg_real'}, ['VALOR_INESPERADO:ASAAS_API_KEY']],
        [{KIDMAIS_DEPLOY_ENV:'staging'}, ['VALOR_INESPERADO:KIDMAIS_DEPLOY_ENV']],
        [{NODE_ENV:'production'}, ['VALOR_INESPERADO:NODE_ENV']],
        [{EMAIL_PROVIDER:'resend'}, ['VALOR_INESPERADO:EMAIL_PROVIDER']],
        [{EMAIL_ARQUIVO_DIR:path.join(os.tmpdir(), 'emails')}, ['EMAIL_FORA_DA_PASTA_LOCAL']],
        [{ADMIN_AUTH_SECRET:'curto'}, ['SEGREDO_SINTETICO_INVALIDO:ADMIN_AUTH_SECRET']],
        [{ADMIN_AUTH_SECRET:undefined}, ['VARIAVEL_AUSENTE:ADMIN_AUTH_SECRET', 'SEGREDO_SINTETICO_INVALIDO:ADMIN_AUTH_SECRET']],
        [{RENDER:'true'}, ['VARIAVEL_INESPERADA:RENDER', 'VARIAVEL_PROIBIDA:RENDER']],
        [{CONSULTA_CEP_EXTERNA:'ligada'}, ['VALOR_INESPERADO:CONSULTA_CEP_EXTERNA']],
        [{CONSULTA_CEP_EXTERNA:undefined}, ['VARIAVEL_AUSENTE:CONSULTA_CEP_EXTERNA', 'VALOR_INESPERADO:CONSULTA_CEP_EXTERNA']],
        [{AGENDA_PUBLICA_EMPRESA_ID:'kidmais'}, ['VALOR_INESPERADO:AGENDA_PUBLICA_EMPRESA_ID']],
        [{AGENDA_PUBLICA_EMPRESA_ID:undefined}, ['VARIAVEL_AUSENTE:AGENDA_PUBLICA_EMPRESA_ID', 'VALOR_INESPERADO:AGENDA_PUBLICA_EMPRESA_ID']],
        [{AGENDA_PUBLICA_UNIDADE_ID:'00000000-0000-4000-8000-000000000001'}, ['VARIAVEL_INESPERADA:AGENDA_PUBLICA_UNIDADE_ID']],
    ];
    for (const [extra, esperado] of casos) {
        const env = ambiente(extra);
        for (const [k, valor] of Object.entries(extra)) if (valor === undefined) delete env[k];
        const problemas = v.validarAmbiente(env);
        assert.deepEqual([...problemas].sort(), [...esperado].sort(), JSON.stringify(Object.keys(extra)));
        for (const p of problemas) assert.match(p, /^[A-Z_]+(:[A-Za-z0-9_()]+)?$/, 'só nomes, nunca valores');
    }
});

test('arquivos .env*: só existência, em qualquer NODE_ENV', () => {
    const dir = temporaria();
    try {
        assert.deepEqual(v.arquivosEnvPresentes(dir), []);
        for (const nome of ['.env.local', '.env.production']) fs.writeFileSync(path.join(dir, nome), 'SINTETICA=1\n');
        fs.writeFileSync(path.join(dir, '.env.example'), 'SINTETICA=1\n');
        assert.deepEqual(v.arquivosEnvPresentes(dir), ['.env.local', '.env.production']);
        assert.equal(v.ARQUIVOS_ENV_NEXT.length, 8);
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('precedência real do @next/env: process.env vence, mas o arquivo acrescenta nomes ausentes (por isso a recusa)', () => {
    const dir = temporaria();
    try {
        const env = ambiente();
        const limpo = v.verificarResolvido(dir, env);
        assert.deepEqual(limpo.problemas, []);
        fs.writeFileSync(path.join(dir, '.env.local'),
            'DATABASE_URL=postgresql://u:segredo-sintetico@exemplo.invalid/real\nOPENAI_API_KEY=sk-sintetica-do-teste\nASAAS_API_KEY=$aact_hmlg_sintetica\n');
        const sujo = v.verificarResolvido(dir, env);
        assert.deepEqual(sujo.saida.arquivos, ['.env.local']);
        assert.deepEqual(sujo.saida.adicionadas, ['OPENAI_API_KEY'], 'nome ausente do ambiente seria injetado pelo arquivo');
        assert.deepEqual(sujo.saida.alteradas, [], 'DATABASE_URL e ASAAS_API_KEY explícitas vencem o arquivo');
        assert.deepEqual(sujo.problemas, ['ARQUIVO_ENV_CARREGADO:.env.local', 'ACRESCENTADA_PELO_NEXT:OPENAI_API_KEY']);
        assert.ok(!JSON.stringify(sujo).includes('sintetic'), 'nenhum valor sai do processo de verificação');
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('código real da aplicação: Asaas desligado, planos novos visíveis, e-mail em arquivo, OTP no console', async () => {
    const ok = await v.verificarCodigo(ambiente());
    assert.deepEqual(ok.problemas, []);
    assert.equal(ok.resumo.asaas, 'DESLIGADO(CHAVE_FORA_DO_SANDBOX)');
    const ligado = await v.verificarCodigo(ambiente({ASAAS_API_KEY:'$aact_hmlg_' + 'x'.repeat(30)}));
    assert.ok(ligado.problemas.includes('ASAAS_LIGADO'), 'a autoverificação percebe uma chave de sandbox');
    const semPlanos = await v.verificarCodigo(ambiente({ASAAS_AMBIENTE:'producao'}));
    assert.ok(semPlanos.problemas.includes('PLANOS_NOVOS_DESLIGADOS'));
});

test('fontes sem rede: next/font/google simulado por arquivo local; CSS sem fonte remota; ambiente exige o mock', () => {
    const env = v.montarAmbiente({}, 'kidmais_navegador_20261010', () => 'x'.repeat(64));
    assert.equal(env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES, v.MOCK_FONTES);
    assert.ok(require('node:path').isAbsolute(v.MOCK_FONTES));
    const mock = require(v.MOCK_FONTES);
    const css = mock['https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap'];
    assert.equal(typeof css, 'string'); assert.doesNotMatch(css, /url\(|https?:\/\//, 'nenhum arquivo de fonte a buscar');
    assert.match(css, /@font-face\s*\{[^}]*src:\s*local\(/, 'webpack exige um @font-face; só local()');
    assert.equal(mock['https://exemplo.invalid/qualquer'], undefined);
    assert.ok(!v.validarAmbiente(env).some(p => p.includes('NEXT_FONT_GOOGLE_MOCKED_RESPONSES')));
    assert.ok(v.validarAmbiente({...env, NEXT_FONT_GOOGLE_MOCKED_RESPONSES:undefined}).some(p => p.includes('NEXT_FONT_GOOGLE_MOCKED_RESPONSES')));
    assert.ok(v.validarAmbiente({...env, NEXT_FONT_GOOGLE_MOCKED_RESPONSES:'/tmp/outro.cjs'}).some(p => p.includes('NEXT_FONT_GOOGLE_MOCKED_RESPONSES')));
});

test('mock de fontes: chaves = URLs que o Next gera para cada fonte declarada no app (fonte nova sem mock falha aqui)', () => {
    const fs = require('node:fs'); const path = require('node:path');
    const {getFontAxes} = require('next/dist/compiled/@next/font/dist/google/get-font-axes');
    const {getGoogleFontsUrl} = require('next/dist/compiled/@next/font/dist/google/get-google-fonts-url');
    const raiz = path.resolve(__dirname, '..');
    const declaradas = ['app/layout.tsx', 'components/site/fonte.ts', 'components/admin/fonte.ts']
        .flatMap(f => [...fs.readFileSync(path.join(raiz, f), 'utf8').matchAll(/import \{([^}]+)\} from ['"]next\/font\/google['"]/g)].flatMap(m => m[1].split(',').map(x => x.trim())));
    assert.deepEqual(declaradas.sort(), ['Bricolage_Grotesque', 'Figtree', 'Geist', 'Geist_Mono', 'Inter']);
    const esperadas = [['Geist', ['variable']], ['Geist Mono', ['variable']], ['Inter', ['variable']], ['Bricolage Grotesque', ['variable'], ['opsz']], ['Figtree', ['400', '500', '600']]]
        .map(([familia, pesos, eixos]) => getGoogleFontsUrl(familia, getFontAxes(familia, pesos, ['normal'], eixos), 'swap'));
    assert.deepEqual(Object.keys(require(v.MOCK_FONTES)).sort(), esperadas.sort());
    assert.doesNotMatch(fs.readFileSync(v.MOCK_FONTES, 'utf8'), /require\(/, 'o Turbopack avalia o mock isolado');
});

test('endereço legado e CEP: id da empresa kidmais vem da execução (UUID), consulta externa de CEP desligada pelo código real', async () => {
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const env = v.montarAmbiente({}, 'kidmais_navegador_20261010', () => 'x'.repeat(64), id);
    assert.equal(env.AGENDA_PUBLICA_EMPRESA_ID, id);
    assert.equal(v.montarAmbiente({}, 'kidmais_navegador_20261010', () => 'x'.repeat(64)).AGENDA_PUBLICA_EMPRESA_ID, v.AGENDA_PUBLICA_PLANO);
    assert.equal(env.CONSULTA_CEP_EXTERNA, 'desligada');
    assert.deepEqual(v.validarAmbiente(env), []);
    const codigo = await v.verificarCodigo(env);
    assert.equal(codigo.resumo.consultaCepExterna, false);
    assert.ok((await v.verificarCodigo({...env, CONSULTA_CEP_EXTERNA:'ligada'})).problemas.includes('CONSULTA_CEP_EXTERNA_LIGADA'));
    const fonte = require('node:fs').readFileSync(require('node:path').join(__dirname, 'navegador-local-servidor.cjs'), 'utf8');
    assert.match(fonte, /const agendaPublica = await conferirBancoPopulado\(a\); \/\/ somente leitura/);
    assert.match(fonte, /BEGIN READ ONLY/);
});
