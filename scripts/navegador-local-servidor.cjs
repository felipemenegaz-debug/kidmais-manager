/* eslint-disable @typescript-eslint/no-require-imports */
// Navegador local (docs/NAVEGADOR_LOCAL_20261010.md): sobe `next dev` em 127.0.0.1:3481 contra o PostgreSQL descartável
// (cluster kidmais_navegador, porta 55481) com ambiente EXPLÍCITO E FECHADO. Nada de .env* pode apontar para serviço real.
// Sem argumento (ou --plano): só a autoverificação offline (sem banco, sem servidor). Execução SOMENTE com a flag única
// --iniciar-autorizado e KIDMAIS_NAVEGADOR_AUTORIZACAO=127.0.0.1:55481/kidmais_navegador_<nome> (a mesma do seed).
//
// Precedência do Next (node_modules/next/dist/docs/01-app/02-guides/environment-variables.md e @next/env): process.env
// vence; os arquivos só preenchem nomes AUSENTES do ambiente inicial, na ordem .env.$(NODE_ENV).local, .env.local
// (exceto test), .env.$(NODE_ENV), .env. Logo um .env.local continuaria injetando qualquer nome que não definimos
// (chaves de provedores, DATABASE_URL de outro alvo se esquecida). Por isso:
//   1) o filho recebe um ambiente montado do zero: só variáveis de sistema da lista fechada + a lista explícita abaixo;
//   2) recusa iniciar se QUALQUER arquivo .env* que o Next leria existir na raiz (só confere existência; nunca lê);
//   3) autoverificação "depois do Next": roda o próprio loadEnvConfig do @next/env com o ambiente final e exige que
//      nenhum nome seja acrescentado ou alterado e nenhum arquivo carregado (só nomes saem do processo filho);
//   4) confere pelo código real: Asaas DESLIGADO, novos planos visíveis, e-mail em arquivo local, OTP no console;
//   5) toda URL no ambiente aponta para localhost/127.0.0.1; durante a execução, um .env* que apareça derruba o servidor.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const seed = require('./navegador-local-seed.cjs');

const raiz = path.resolve(__dirname, '..');
const FLAG = '--iniciar-autorizado';
const FLAG_PLANO = '--plano';
/** Todos os nomes que o @next/env pode carregar, em qualquer NODE_ENV. Só a existência é conferida. */
const ARQUIVOS_ENV_NEXT = Object.freeze(['.env', '.env.local', '.env.development', '.env.development.local',
    '.env.production', '.env.production.local', '.env.test', '.env.test.local']);
/** Variáveis do sistema que o filho herda (comparação sem caixa, como no Windows). Nada de proxy, NODE_OPTIONS ou PG*. */
const SISTEMA = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
    'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS',
    'LANG', 'LC_ALL', 'TERM', 'USERNAME', 'USER', 'LOGNAME', 'SHELL']);
/** Mesmo não estando no ambiente montado, estes nomes nunca podem chegar ao filho (defesa explícita). */
const PROIBIDAS = /^(PG.*|RENDER.*|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|ALL_PROXY|.*_API_KEY|.*_ACCESS_TOKEN|.*_APP_SECRET|OPENAI_.*|DEEPSEEK_.*|ANTHROPIC_.*|GEMINI_.*|RESEND_.*|GUPSHUP_.*|META_.*|WHATSAPP_.*)$/i;
const EXCECOES_PROIBIDAS = Object.freeze(['ASAAS_API_KEY']); // presente de propósito com valor que DESLIGA o Asaas
/** Valor que nunca liga a cobrança: configuracaoAsaas exige o prefixo de sandbox `$aact_hmlg_`. */
const ASAAS_CHAVE_DESLIGADA = 'local-desligado-sem-prefixo-sandbox';
const HOSTS_LOCAIS = Object.freeze(['localhost', '127.0.0.1', '::1', '[::1]']);
const PASTA_EMAILS = path.join(raiz, seed.PASTA_LOCAL, 'emails');

const recusa = (codigo, detalhe) => Object.assign(Error(detalhe ? `${codigo} ${detalhe}` : codigo), {codigo});

function modo(argv) {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === FLAG_PLANO)) return 'PLANO';
    if (argv.length === 1 && argv[0] === FLAG) return 'EXECUTAR';
    return null;
}

const segredo = () => randomBytes(32).toString('hex'); // por execução; morre com o processo

/** Lista explícita (nomes e valores) para o servidor local. Segredos sintéticos novos a cada execução. */
function variaveisExplicitas(banco, gerar = segredo) {
    const origem = seed.ORIGEM_APP;
    return {
        NODE_ENV:'development', NEXT_TELEMETRY_DISABLED:'1', KIDMAIS_DEPLOY_ENV:'local',
        DATABASE_URL:`postgresql://${seed.PAPEL}@127.0.0.1:${seed.PORTA}/${banco}`, DATABASE_SSL:'false', DATABASE_SSL_REJECT_UNAUTHORIZED:'true',
        DATABASE_POOL_MAX:'5', DATABASE_IDLE_TIMEOUT_MS:'30000', DATABASE_CONNECTION_TIMEOUT_MS:'5000',
        ADMIN_AUTH_ORIGIN:origem, ADMIN_AUTH_SECRET:gerar(), SITE_URL:origem, CONVITES_PUBLIC_ORIGIN:origem,
        IDENTIDADE_OTP_PROVIDER:'console', IDENTIDADE_OTP_PEPPER:gerar(),
        ASAAS_AMBIENTE:'sandbox', ASAAS_API_KEY:ASAAS_CHAVE_DESLIGADA, ASAAS_WEBHOOK_TOKEN:gerar(),
        ASSINATURA_PLANOS_ATIVOS:'true', COTACAO_PUBLICA_POR_EMPRESA:'true',
        EMAIL_PROVIDER:'arquivo', EMAIL_ARQUIVO_DIR:PASTA_EMAILS, EMAIL_REMETENTE:'nao-responda@example.invalid',
        RECUPERACAO_SENHA_ATIVA:'false', CADASTRO_PUBLICO_ATIVO:'false',
        FESTA_ENABLED:'true', CONVITES_ENABLED:'false', CONVITES_IA_ENABLED:'false', CONTRACT_IMPORT_INTEGRATION_ENABLED:'false', CONTRATO_ACEITE_DEV_ENABLED:'false',
        INTELIGENCIA_ENABLED:'false', AI_READ_ENABLED:'false', AI_ADMIN_ACTIONS_ENABLED:'false', AI_CONTRACT_IMPORT_ENABLED:'false',
        AI_JEV_ENABLED:'false', AI_JEV_MODEL_ENABLED:'false', AI_COPILOTO_MODEL_ENABLED:'false', AI_DEMERZEL_ENABLED:'false',
        AI_OPERACIONAL_ENABLED:'false', AI_SKILLS_EMPRESA_ENABLED:'false', AI_FALLBACK_ENABLED:'false', AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED:'false',
    };
}
const NOMES_EXPLICITOS = Object.freeze(Object.keys(variaveisExplicitas(seed.BANCO_SUGERIDO, () => 'x')));

/** Ambiente do filho: sistema (lista fechada) + explícitas. Nada mais é herdado. */
function montarAmbiente(pai, banco, gerar = segredo) {
    const env = {};
    for (const [nome, valor] of Object.entries(pai))
        if (SISTEMA.includes(nome.toUpperCase()) && typeof valor === 'string') env[nome] = valor;
    return Object.assign(env, variaveisExplicitas(banco, gerar));
}

const ehLocal = host => HOSTS_LOCAIS.includes(String(host).toLowerCase());

/** Autoverificação pura do ambiente final. Devolve códigos com NOMES apenas (nunca valores). */
function validarAmbiente(env) {
    const problemas = [];
    const exigir = (nome, valor) => { if (env[nome] !== valor) problemas.push('VALOR_INESPERADO:' + nome); };
    for (const nome of Object.keys(env)) {
        if (!SISTEMA.includes(nome.toUpperCase()) && !NOMES_EXPLICITOS.includes(nome)) problemas.push('VARIAVEL_INESPERADA:' + nome);
        if (PROIBIDAS.test(nome) && !EXCECOES_PROIBIDAS.includes(nome)) problemas.push('VARIAVEL_PROIBIDA:' + nome);
        const valor = String(env[nome] ?? '');
        for (const m of valor.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,;]+/gi)) {
            let host = null;
            try { host = new URL(m[0]).hostname; } catch { /* malformada: recusada abaixo */ }
            if (!host || !ehLocal(host)) problemas.push('HOST_NAO_LOCAL:' + nome);
        }
    }
    for (const nome of NOMES_EXPLICITOS) if (env[nome] === undefined) problemas.push('VARIAVEL_AUSENTE:' + nome);
    exigir('NODE_ENV', 'development'); exigir('KIDMAIS_DEPLOY_ENV', 'local'); exigir('NEXT_TELEMETRY_DISABLED', '1');
    exigir('DATABASE_SSL', 'false'); exigir('ADMIN_AUTH_ORIGIN', seed.ORIGEM_APP); exigir('SITE_URL', seed.ORIGEM_APP);
    exigir('ASAAS_AMBIENTE', 'sandbox'); exigir('ASAAS_API_KEY', ASAAS_CHAVE_DESLIGADA);
    exigir('EMAIL_PROVIDER', 'arquivo'); exigir('IDENTIDADE_OTP_PROVIDER', 'console');
    exigir('ASSINATURA_PLANOS_ATIVOS', 'true'); exigir('COTACAO_PUBLICA_POR_EMPRESA', 'true');
    try {
        const u = new URL(env.DATABASE_URL);
        assert.ok(u.protocol === 'postgresql:' && u.hostname === '127.0.0.1' && Number(u.port) === seed.PORTA && u.username === seed.PAPEL && u.password === '');
        seed.validarBanco(decodeURIComponent(u.pathname.replace(/^\//, '')));
    } catch { problemas.push('DATABASE_URL_FORA_DO_ALVO'); }
    for (const nome of ['ADMIN_AUTH_SECRET', 'IDENTIDADE_OTP_PEPPER', 'ASAAS_WEBHOOK_TOKEN'])
        if (!/^[\x21-\x7e]{32,255}$/.test(env[nome] ?? '')) problemas.push('SEGREDO_SINTETICO_INVALIDO:' + nome);
    const pastaLocal = path.join(raiz, seed.PASTA_LOCAL) + path.sep;
    if (!path.isAbsolute(env.EMAIL_ARQUIVO_DIR ?? '') || !(path.resolve(env.EMAIL_ARQUIVO_DIR) + path.sep).startsWith(pastaLocal))
        problemas.push('EMAIL_FORA_DA_PASTA_LOCAL');
    return [...new Set(problemas)];
}

/** Quais arquivos .env* o Next encontraria na pasta (somente existência; o conteúdo nunca é lido). */
function arquivosEnvPresentes(dir, fsImpl = fs) {
    return ARQUIVOS_ENV_NEXT.filter(nome => { try { fsImpl.statSync(path.join(dir, nome)); return true; } catch { return false; } });
}

/** Roda o loadEnvConfig do próprio Next (modo dev) num processo separado com o ambiente final; só nomes voltam. */
const CODIGO_RESOLVIDO = `
const [dir, modulos] = process.argv.slice(1);
const {loadEnvConfig} = require(require.resolve('@next/env', {paths:[require('node:path').join(modulos, 'node_modules', 'next')]}));
const antes = {...process.env};
const r = loadEnvConfig(dir, true, {info() {}, warn() {}, error() {}}, true);
const depois = {...process.env};
const ignorar = n => n.startsWith('__NEXT_');
process.stdout.write(JSON.stringify({arquivos:r.loadedEnvFiles.map(f => f.path),
  adicionadas:Object.keys(depois).filter(n => !ignorar(n) && !(n in antes)).sort(),
  alteradas:Object.keys(depois).filter(n => !ignorar(n) && n in antes && antes[n] !== depois[n]).sort()}));`;
function verificarResolvido(dirProjeto, env, dirModulos = raiz) {
    const r = spawnSync(process.execPath, ['-e', CODIGO_RESOLVIDO, dirProjeto, dirModulos], {cwd:dirModulos, env, encoding:'utf8', timeout:60000, windowsHide:true});
    if (r.status !== 0) throw recusa('AUTOVERIFICACAO_NEXT_ENV_FALHOU');
    const saida = JSON.parse(r.stdout);
    const problemas = [...saida.arquivos.map(a => 'ARQUIVO_ENV_CARREGADO:' + a), ...saida.adicionadas.map(n => 'ACRESCENTADA_PELO_NEXT:' + n),
        ...saida.alteradas.map(n => 'ALTERADA_PELO_NEXT:' + n)];
    return {saida, problemas};
}

/** Pelo código real da aplicação (sem banco): Asaas desligado, planos novos visíveis, e-mail em arquivo, OTP no console. */
async function verificarCodigo(env) {
    const {carregarModulo} = await import(pathToFileURL(path.join(raiz, 'lib/acessos/teste-carregador.ts')).href);
    const cache = new Map(), semBanco = () => { throw recusa('BANCO_NAO_USADO_NA_AUTOVERIFICACAO'); };
    const carregar = f => carregarModulo(path.join(raiz, f), {'db/postgres':{db:semBanco, withTransaction:semBanco}}, cache);
    const asaas = carregar('lib/assinatura/asaas.ts'), ofertas = carregar('lib/assinatura/ofertas.ts'), email = carregar('lib/acessos/email.ts');
    const otp = carregar('lib/identidade/configuracao-otp.ts'), cotacao = carregar('lib/comercial/cotacao-publica.ts');
    const estado = {asaas:asaas.configuracaoAsaas(env), planos:ofertas.novosPlanosLigados(env), email:email.situacaoEmail(env),
        otp:otp.modoOtpAmbiente(env), cotacao:cotacao.cotacaoPorEmpresaHabilitada(env)};
    const problemas = [];
    if (estado.asaas.ligado !== false) problemas.push('ASAAS_LIGADO');
    if (estado.planos !== true) problemas.push('PLANOS_NOVOS_DESLIGADOS');
    if (!(estado.email.configurado && estado.email.provedor === 'arquivo')) problemas.push('EMAIL_NAO_LOCAL');
    if (estado.otp !== 'console') problemas.push('OTP_NAO_CONSOLE');
    if (estado.cotacao !== true) problemas.push('COTACAO_POR_EMPRESA_DESLIGADA');
    return {resumo:{asaas:estado.asaas.ligado ? 'LIGADO' : `DESLIGADO(${estado.asaas.motivo})`, planosNovos:estado.planos,
        email:estado.email.provedor, otp:estado.otp, cotacaoPorEmpresa:estado.cotacao}, problemas};
}

/** Autoverificação completa (offline). Lança com a lista de nomes se algo falhar. */
async function autoverificar(env) {
    const problemas = [...validarAmbiente(env), ...arquivosEnvPresentes(raiz).map(a => 'ARQUIVO_ENV_PRESENTE:' + a)];
    const codigo = await verificarCodigo(env);
    problemas.push(...codigo.problemas);
    const resolvido = verificarResolvido(raiz, env);
    problemas.push(...resolvido.problemas);
    return {problemas:[...new Set(problemas)], codigo:codigo.resumo, arquivosCarregadosPeloNext:resolvido.saida.arquivos};
}

function portaLivre(porta, host = '127.0.0.1') {
    return new Promise(ok => {
        const s = net.createServer();
        s.once('error', () => ok(false));
        s.listen(porta, host, () => s.close(() => ok(true)));
    });
}

/** Banco descartável certo e já populado pelo seed (somente leitura). */
async function conferirBancoPopulado(a) {
    const {Client} = require('pg');
    const c = new Client({host:a.host, port:a.porta, user:seed.PAPEL, database:a.banco, ssl:false, connectionTimeoutMillis:5000,
        password:async () => { throw recusa('SERVIDOR_PEDIU_SENHA'); }, application_name:'kidmais-navegador-servidor'});
    await c.connect();
    try {
        await c.query('BEGIN READ ONLY');
        seed.conferirIdentidade((await c.query(seed.SQL_IDENTIDADE)).rows[0], a, a.banco, [a.banco]);
        const n = (await c.query('SELECT count(*)::int AS n FROM empresas WHERE codigo = ANY($1::text[])', [seed.EMPRESAS.map(e => e.codigo)])).rows[0].n;
        if (n !== seed.EMPRESAS.length) throw recusa('BANCO_NAO_POPULADO');
    } finally { await c.query('ROLLBACK').catch(() => {}); await c.end().catch(() => {}); }
}

function encerrarArvore(filho) {
    if (!filho || filho.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(filho.pid), '/T', '/F'], {stdio:'ignore', windowsHide:true});
    else filho.kill('SIGTERM');
}

async function executar(pai) {
    const a = seed.alvo(pai);
    seed.semConexaoHerdada(pai, a);
    if (path.resolve(process.cwd()).toLowerCase() !== raiz.toLowerCase()) throw recusa('EXECUTAR_NA_RAIZ_DO_REPOSITORIO');
    if (!fs.existsSync(seed.ARQUIVO_CREDENCIAIS)) throw recusa('SEED_NAO_EXECUTADO');
    const env = montarAmbiente(pai, a.banco);
    const v = await autoverificar(env);
    if (v.problemas.length) { console.error(JSON.stringify({problemas:v.problemas})); throw recusa('AUTOVERIFICACAO_RECUSOU'); }
    if (!await portaLivre(seed.PORTA_APP)) throw recusa('PORTA_APP_OCUPADA', String(seed.PORTA_APP));
    await conferirBancoPopulado(a);
    fs.mkdirSync(PASTA_EMAILS, {recursive:true, mode:0o700});
    console.log(JSON.stringify({resultado:'INICIANDO', origem:seed.ORIGEM_APP, escuta:`127.0.0.1:${seed.PORTA_APP}`, banco:`${a.host}:${a.porta}/${a.banco}`,
        variaveis:Object.keys(env).sort(), autoverificacao:v.codigo}, null, 2));
    const next = path.join(raiz, 'node_modules', 'next', 'dist', 'bin', 'next');
    const filho = spawn(process.execPath, [next, 'dev', '--hostname', '127.0.0.1', '--port', String(seed.PORTA_APP)], {cwd:raiz, env, stdio:'inherit', windowsHide:true});
    // Um .env* que apareça durante a execução seria recarregado pelo next dev: derruba o servidor.
    const vigia = setInterval(() => {
        const presentes = arquivosEnvPresentes(raiz);
        if (presentes.length) { console.error('PARADA ARQUIVO_ENV_APARECEU ' + presentes.join(',')); process.exitCode = 3; encerrarArvore(filho); }
    }, 2000);
    const parar = () => { clearInterval(vigia); encerrarArvore(filho); };
    process.once('SIGINT', parar); process.once('SIGTERM', parar);
    filho.once('exit', codigo => { clearInterval(vigia); if (codigo && !process.exitCode) process.exitCode = codigo; });
}

async function principal(argv, pai) {
    const m = modo(argv);
    if (m === null) { console.error('USO: sem argumento/--plano (autoverificação offline) ou ' + FLAG + ' com ' + seed.VAR_AUTORIZACAO + ' (exige aprovação)'); process.exitCode = 1; return; }
    if (m === 'PLANO') {
        const env = montarAmbiente(pai, seed.BANCO_SUGERIDO);
        const v = await autoverificar(env);
        console.log(JSON.stringify({modo:'AUTOVERIFICACAO_OFFLINE', conexao:false, servidor:false, resultado:v.problemas.length ? 'RECUSARIA' : 'OK',
            problemas:v.problemas, codigo:v.codigo, arquivosCarregadosPeloNext:v.arquivosCarregadosPeloNext,
            variaveisExplicitas:[...NOMES_EXPLICITOS].sort(), sistemaHerdado:Object.keys(env).filter(n => !NOMES_EXPLICITOS.includes(n)).sort()}, null, 2));
        if (v.problemas.length) process.exitCode = 2;
        return;
    }
    await executar(pai);
}

if (require.main === module)
    principal(process.argv.slice(2), process.env).catch(e => {
        console.error('SERVIDOR_NAVEGADOR_RECUSADO ' + seed.sanitizar(e?.message ?? e?.codigo)); process.exitCode = 1;
    });
module.exports = {FLAG, FLAG_PLANO, ARQUIVOS_ENV_NEXT, SISTEMA, PROIBIDAS, ASAAS_CHAVE_DESLIGADA, NOMES_EXPLICITOS, PASTA_EMAILS, CODIGO_RESOLVIDO,
    modo, variaveisExplicitas, montarAmbiente, validarAmbiente, arquivosEnvPresentes, verificarResolvido, verificarCodigo, autoverificar};
