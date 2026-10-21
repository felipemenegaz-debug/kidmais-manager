/* eslint-disable @typescript-eslint/no-require-imports */
// Janela S3+S4 em staging de 20/10/2026 (docs/HOMOLOGACAO_S3_S4_STAGING_20261020.md): conferências levadas ao Web Shell do
// srv-daif418ae00c73e8k2gg pelos blocos de scripts/bloco-shell-s3s4-staging-20261020.cjs. PREPARADO, NÃO EXECUTADO.
// Tudo é somente leitura (banco em transação READ ONLY; Asaas sandbox só GET), com UMA exceção: --arquivar-r3 renomeia
// (link + unlink, sem sobrescrever e sem apagar conteúdo) o estado e o log da tentativa de 20/10 que parou no PRECHECK sem
// criar nada, porque o executor da rodada 3 recusa estado presente (RODADA_EXISTENTE_S1). Nunca imprime segredo: das chaves
// só formato/presença; do Asaas só o status HTTP e contagens de webhooks; do banco só contagens e situações.
// Módulos do deploy (executor da rodada 3 e registro de 10/10) são lidos por caminho absoluto: o bloco confere o sha256
// de cada um ANTES de rodar este arquivo. Modos (um por execução):
//   --plano                                  sem ambiente: modos, arquivos e critérios (usado nos testes dos blocos)
//   --pre                                    antes de W1, em qualquer deploy: commit no ar, chaves, registro 10/10, estado da
//                                            rodada 3 (arquivável?), disco e Asaas sandbox (status da chave e webhooks)
//   --arquivar-r3                            só com o --pre ARQUIVAVEL; antes de W1
//   --janela --candidata=<sha>               depois de W1: pronto para iniciar a rodada 3 (inclui banco somente leitura)
//   --s4-acompanhar                          estado da rodada e última linha do log (durante e depois)
//   --s3-antes --candidata=<sha> <CNPJ>      S3-R (opcional): janela do cadastro, bloqueios globais e CNPJ livre
//   --s3-depois --candidata=<sha> <CNPJ>     S3-R (opcional): S3_PASS, mesmo critério de 13/10
//   --s4n-depois --candidata=<sha> <CNPJ>    S4-N (opcional): contratação feita pelo navegador confirmada
//   --pos --candidata=<sha>                  depois de W7: chaves ausentes, registro 10/10 restaurado, resumo da rodada
// Saída: uma linha JSON. Código 0 = resultado esperado do modo; 2 = divergente (parar e ler); 1 = recusado/erro.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const s3 = require('./s3-cadastro-staging.cjs');

const SERVICO = 'srv-daif418ae00c73e8k2gg';
const DEPLOY = '/opt/render/project/src';
const DISCO = DEPLOY + '/data';
const BASE = 'https://kidmais-manager-staging.onrender.com';
const ROTA_WEBHOOK = BASE + '/api/integracoes/asaas/webhook';
const ASAAS = 'https://api-sandbox.asaas.com/v3';
const PREFIXO_SANDBOX = '$aact_hmlg_';
const REMETENTE = 'Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>';
const KIDMAIS_CNPJ = '20119900000160';
/** Chaves da janela: o S4 precisa das duas de planos/cotação; o S3-R opcional, também das duas do cadastro. */
const CHAVES_S3 = Object.freeze(['CADASTRO_PUBLICO_ATIVO', 'USUARIOS_CRIACAO_DIRETA']);
const CHAVES_S4 = Object.freeze(['ASSINATURA_PLANOS_ATIVOS', 'COTACAO_PUBLICA_POR_EMPRESA']);
const CHAVES_JANELA = Object.freeze([...CHAVES_S3, ...CHAVES_S4]);
/** Empresa TESTE S3, criada pelo S3 de 20/10 (APROVADO); usada só no S4-N opcional. */
const CNPJ_TESTE_S3 = '82654321000174';
/** S3-R opcional: CNPJ sintético novo (dígitos válidos), conferido livre no repositório e no vault em 20/10. */
const CNPJ_S3R = '71394825000186';
/** Arquivos do deploy de que a rodada 3 e este script dependem: o bloco confere o sha256 de cada um antes do node. */
const DEPLOY_S4 = Object.freeze(['scripts/homologacao-pagamento-renovacao-staging.cjs', 'scripts/assinatura-staging-ensaio.cjs',
    'scripts/conexao-staging.cjs', 'scripts/homologacao-planos-cotacao-staging.cjs', 'scripts/assinatura-preservacao.cjs',
    'scripts/configuracao-homologacao-staging.cjs']);
/** S4-N: Essencial mensal com Fundador (40%), centavos fixados aqui, independentes do código (teste amarra ao catálogo). */
const S4N = Object.freeze({plano:'ESSENCIAL', ciclo:'MENSAL', regular:19700, final:11820, desconto:40});
const LOG = 'pagamento-renovacao-saida.log';
const MODOS = Object.freeze(['plano', 'pre', 'arquivar-r3', 'janela', 's4-acompanhar', 's3-antes', 's3-depois', 's4n-depois', 'pos']);
const COM_CANDIDATA = new Set(['janela', 's3-antes', 's3-depois', 's4n-depois', 'pos']);
const COM_CNPJ = new Set(['s3-antes', 's3-depois', 's4n-depois']);

const sha = b => createHash('sha256').update(b).digest('hex');
const texto = (v, max = 40) => (typeof v === 'string' ? v.slice(0, max).replace(/[^\x20-\x7e]/g, '?') : null);

function analisar(argv) {
    const modos = argv.filter(a => a.startsWith('--') && !a.startsWith('--candidata='));
    assert.equal(modos.length, 1, 'USO_RECUSADO');
    const modo = modos[0].slice(2);
    assert.ok(MODOS.includes(modo), 'USO_RECUSADO');
    const candidatas = argv.filter(a => a.startsWith('--candidata='));
    assert.equal(candidatas.length, COM_CANDIDATA.has(modo) ? 1 : 0, COM_CANDIDATA.has(modo) ? 'CANDIDATA_AUSENTE' : 'USO_RECUSADO');
    const candidata = candidatas.length ? candidatas[0].slice('--candidata='.length) : null;
    if (candidata !== null) assert.match(candidata, /^[0-9a-f]{40}$/, 'CANDIDATA_INVALIDA');
    const resto = argv.filter(a => !a.startsWith('--'));
    assert.equal(resto.length, COM_CNPJ.has(modo) ? 1 : 0, 'USO_RECUSADO');
    return {modo, candidata, cnpj:COM_CNPJ.has(modo) ? cnpjValido(resto[0]) : null};
}

/** CNPJ numérico com dígitos verificadores válidos; nunca o da Kidmais. */
function cnpjValido(v) {
    const d = String(v ?? '').replace(/[.\-/]/g, '');
    assert.match(d, /^\d{14}$/, 'CNPJ_INVALIDO'); assert.ok(!/^(\d)\1{13}$/.test(d), 'CNPJ_INVALIDO');
    let b = d.slice(0, 12);
    for (const p of [[5,4,3,2,9,8,7,6,5,4,3,2], [6,5,4,3,2,9,8,7,6,5,4,3,2]]) {
        const r = [...b].reduce((s, n, i) => s + Number(n) * p[i], 0) % 11;
        b += r < 2 ? '0' : String(11 - r);
    }
    assert.equal(b, d, 'CNPJ_DV_INVALIDO'); assert.notEqual(d, KIDMAIS_CNPJ, 'CNPJ_DA_KIDMAIS');
    return d;
}

function servico(env) {
    assert.equal(env.RENDER, 'true', 'FORA_DO_RENDER');
    assert.equal(env.RENDER_SERVICE_ID, SERVICO, 'SERVICO_RECUSADO');
    assert.equal(env.KIDMAIS_DEPLOY_ENV, 'staging', 'AMBIENTE_RECUSADO');
    return /^[0-9a-f]{40}$/.test(env.RENDER_GIT_COMMIT ?? '') ? env.RENDER_GIT_COMMIT : null;
}

/** Estado de cada chave sem expor valor: null (ausente/vazia), true/false/desativada, ou OUTRO. */
function chaves(env, nomes = CHAVES_JANELA) {
    return Object.fromEntries(nomes.map(k => [k, env[k] === undefined || env[k] === '' ? null
        : ['true', 'false', 'desativada'].includes(env[k]) ? env[k] : 'OUTRO']));
}

/** Janela do cadastro (mesma regra do S3 de 13/10, sem a candidata fixa do arquivo de 13/10). */
function janelaS3(env) {
    assert.equal(env.CADASTRO_PUBLICO_ATIVO, 'true', 'CADASTRO_FECHADO');
    assert.equal(env.USUARIOS_CRIACAO_DIRETA, 'desativada', 'CRIACAO_DIRETA_LIGADA');
    assert.equal(env.EMAIL_PROVIDER, 'resend', 'EMAIL_PROVEDOR'); assert.equal(env.EMAIL_REMETENTE, REMETENTE, 'EMAIL_REMETENTE');
    assert.ok(/^re_\S+$/.test(env.RESEND_API_KEY || ''), 'EMAIL_CHAVE');
    assert.ok(!env.ASSINATURA_TESTE_DIAS || env.ASSINATURA_TESTE_DIAS === '15', 'TESTE_DIFERENTE_DE_15');
}

// ---- Asaas sandbox: formato local + só GET. Nada é criado, alterado ou impresso além de status e contagens.
function formatoAsaas(env) {
    const chave = env.ASAAS_API_KEY?.trim() ?? '', token = env.ASAAS_WEBHOOK_TOKEN ?? '';
    return {ambienteSandbox:env.ASAAS_AMBIENTE === 'sandbox', chaveSandbox:chave.startsWith(PREFIXO_SANDBOX) && chave.length <= 300 && !/\s/.test(chave),
        tokenFormato:/^[\x21-\x7e]{32,255}$/.test(token), tokenDiferenteDaChave:token !== chave};
}
async function asaas(env, fetchImpl) {
    const formato = formatoAsaas(env);
    if (!Object.values(formato).every(Boolean)) return {resultado:'ASAAS_FORMATO_INVALIDO', formato, http:null, webhooks:null};
    const pedir = async caminho => {
        const res = await fetchImpl(ASAAS + caminho, {method:'GET', redirect:'error', signal:AbortSignal.timeout(15000),
            headers:{access_token:env.ASAAS_API_KEY.trim(), 'User-Agent':'kidmais-staging-homologacao', Accept:'application/json'}});
        return {status:res.status, j:res.ok ? await res.json().catch(() => null) : null};
    };
    let c;
    try { c = await pedir('/customers?limit=1'); } catch { return {resultado:'ASAAS_SEM_RESPOSTA', formato, http:null, webhooks:null}; }
    if (c.status !== 200) return {resultado:'ASAAS_CHAVE_RECUSADA', formato, http:c.status, webhooks:null};
    let lista;
    try { lista = await pedir('/webhooks?limit=100'); } catch { lista = {status:null, j:null}; }
    if (lista.status !== 200 || !Array.isArray(lista.j?.data)) return {resultado:'ASAAS_WEBHOOKS_ILEGIVEIS', formato, http:200, webhooks:null};
    // Mesmo critério de prepararWebhook (assinatura-staging-ensaio.cjs): detalhe por id dos webhooks da URL do staging.
    const nossos = [];
    for (const w of lista.j.data.filter(x => x?.url === ROTA_WEBHOOK)) {
        if (typeof w.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(w.id)) { nossos.push(null); continue; }
        try { const d = await pedir('/webhooks/' + encodeURIComponent(w.id)); nossos.push(d.status === 200 ? d.j : null); } catch { nossos.push(null); }
    }
    const usavel = w => !!w && w.url === ROTA_WEBHOOK && w.enabled === true && w.interrupted === false && Array.isArray(w.events)
        && w.events.includes('PAYMENT_RECEIVED') && w.events.includes('PAYMENT_CONFIRMED');
    const webhooks = {total:Number.isInteger(lista.j.totalCount) ? lista.j.totalCount : lista.j.data.length, paginado:lista.j.hasMore === true,
        staging:nossos.length, usaveis:nossos.filter(usavel).length, interrompidos:nossos.filter(w => w?.interrupted === true).length,
        desabilitados:nossos.filter(w => w && w.enabled !== true).length};
    const motivo = webhooks.paginado ? 'WEBHOOKS_PAGINADOS' : webhooks.staging > 1 ? 'WEBHOOK_AMBIGUO'
        : webhooks.staging === 1 && webhooks.usaveis !== 1 ? (webhooks.interrompidos ? 'WEBHOOK_INTERROMPIDO' : 'WEBHOOK_INUTILIZAVEL')
            : webhooks.staging === 0 && webhooks.total >= 10 ? 'LIMITE_WEBHOOKS' : null;
    return {resultado:motivo ? 'ASAAS_BLOQUEIA_S4' : 'ASAAS_PRONTO', motivo, formato, http:200, webhooks,
        webhookDaRodada:webhooks.staging === 1 ? 'REUTILIZA_O_EXISTENTE' : 'CRIA_UM_PROPRIO'};
}

// ---- Estado da rodada 3 no disco: resumo sem segredos e prova de "nada criado" para arquivar.
function lerEstado(arquivo) { return fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf8')) : null; }
function resumoEstado(r, executor) {
    if (!r) return {estado:'AUSENTE'};
    const f = r.falha ?? null, comprovados = executor.recursosComprovados(r);
    return {estado:'PRESENTE', marcaConfere:r.marca === executor.MARCA, inicio:texto(r.inicio), concluido:typeof r.concluido === 'boolean' ? r.concluido : null,
        aprovado:r.aprovado === true, etapas:Array.isArray(r.etapas) ? r.etapas.length : null, ultimaEtapa:Array.isArray(r.etapas) ? texto(r.etapas.at(-1)) : null,
        falha:f && {etapa:texto(f.etapa), parada:texto(f.parada), http:Number.isInteger(f.http) ? f.http : null, mensagem:texto(f.mensagem, 80), item:texto(f.item, 60)},
        intencaoFixture:r.intencaoFixture === true, fixture:r.fixture === true, intencaoWebhook:r.intencaoWebhook === true, webhookCriado:typeof r.webhookId === 'string',
        checkouts:executor.PAGANTES.filter(x => r[x.chave]?.intencaoCheckout === true).map(x => x.chave),
        recursosComprovados:{fixtures:comprovados.fixtures, webhook:comprovados.webhook, assinaturas:Object.values(comprovados.assinaturas).some(Boolean)},
        vagaReservadaPendente:r.vagaReservadaPendente === true, falhasEncerramento:Array.isArray(r.falhasEncerramento) ? r.falhasEncerramento.length : 0,
        recuperacoes:Array.isArray(r.recuperacoes) ? r.recuperacoes.length : 0, campanhaAntes:campanhaSegura(r.campanhaAntes),
        campanhaDepois:campanhaSegura(r.campanhaDepois)};
}
const campanhaSegura = c => (c && Number.isInteger(c.confirmadas) && Number.isInteger(c.ocupadas) ? {confirmadas:c.confirmadas, ocupadas:c.ocupadas} : null);
/** Arquivável = a rodada terminou (concluido false) no PRECHECK, antes de qualquer etapa e sem nenhuma intenção de criação. */
function arquivavel(x) {
    return x.estado === 'PRESENTE' && x.marcaConfere === true && x.concluido === false && !x.aprovado && x.etapas === 0
        && x.falha?.etapa === 'PRECHECK' && !x.intencaoFixture && !x.fixture && !x.intencaoWebhook && !x.webhookCriado
        && x.checkouts.length === 0 && !x.vagaReservadaPendente && x.falhasEncerramento === 0
        && !x.recursosComprovados.fixtures && !x.recursosComprovados.webhook && !x.recursosComprovados.assinaturas;
}
function carimbo(inicio) {
    const d = new Date(inicio ?? '');
    assert.ok(!Number.isNaN(d.getTime()), 'INICIO_INVALIDO');
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
/** Renomeia log e estado para nomes com o carimbo da tentativa; link (falha se o destino existir) + conferência + unlink. */
function arquivar(dir, nomeEstado, resumo) {
    assert.ok(arquivavel(resumo), 'ESTADO_NAO_ARQUIVAVEL');
    const sufixo = 'precheck-' + carimbo(resumo.inicio);
    const pares = [[LOG, LOG.replace(/\.log$/, '.' + sufixo + '.log')], [nomeEstado, nomeEstado.replace(/\.json$/, '.' + sufixo + '.json')]];
    for (const [, d] of pares) assert.ok(!fs.existsSync(path.join(dir, d)), 'DESTINO_EXISTE');
    const feitos = [];
    for (const [o, d] of pares) {
        const origem = path.join(dir, o), destino = path.join(dir, d);
        if (!fs.existsSync(origem)) { feitos.push({arquivo:o, acao:'AUSENTE'}); continue; }
        const h = sha(fs.readFileSync(origem));
        fs.linkSync(origem, destino);
        assert.equal(sha(fs.readFileSync(destino)), h, 'COPIA_DIVERGENTE');
        fs.unlinkSync(origem);
        feitos.push({arquivo:o, acao:'ARQUIVADO', para:d, sha256:h});
    }
    return feitos;
}
function discoPersistente(disco) {
    try { const d = fs.statSync(disco), p = fs.statSync(path.dirname(disco)); return d.isDirectory() && d.dev !== p.dev; } catch { return false; }
}
function registro(configuracao, dir, env) {
    const arquivo = path.join(dir, configuracao.ARQUIVO);
    if (!fs.existsSync(arquivo)) return {resultado:'SEM_REGISTRO', divergencias:null};
    const divergencias = configuracao.conferir(JSON.parse(fs.readFileSync(arquivo, 'utf8')), env);
    return {resultado:divergencias.length ? 'DIVERGENTE' : 'RESTAURADA', divergencias};
}
function processoVivo(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** Última linha não vazia do log (até 64 KB do fim); JSON do executor reduzido aos campos de leitura. */
function ultimaLinha(arquivo) {
    if (!fs.existsSync(arquivo)) return {log:'AUSENTE'};
    const fd = fs.openSync(arquivo, 'r');
    try {
        const tamanho = fs.fstatSync(fd).size, n = Math.min(tamanho, 65536), b = Buffer.alloc(n);
        fs.readSync(fd, b, 0, n, tamanho - n);
        const linha = b.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
        try {
            const j = JSON.parse(linha);
            return {log:'PRESENTE', bytes:tamanho, final:{resultado:texto(j.resultado), erro:texto(j.erro, 80), falha:j.falha ? {etapa:texto(j.falha.etapa),
                parada:texto(j.falha.parada), item:texto(j.falha.item, 60), http:Number.isInteger(j.falha.http) ? j.falha.http : null} : null,
                campanhaAntes:campanhaSegura(j.campanhaAntes), campanhaDepois:campanhaSegura(j.campanhaDepois), vagas:j.vagas ?? null,
                falhasEncerramento:Array.isArray(j.falhasEncerramento) ? j.falhasEncerramento.length : null}};
        } catch { return {log:'PRESENTE', bytes:tamanho, ultima:texto(linha, 200)}; }
    } finally { fs.closeSync(fd); }
}

// ---- Banco: só leitura, com identidade conferida (mesmo alvo do S3).
async function conectar(env, Client) {
    const c = new Client({...s3.conexao(env), application_name:'kidmais-s3s4-somente-leitura'}); c.on?.('error', () => undefined);
    await c.connect(); return c;
}
async function leitura(c, fn) {
    await c.query('BEGIN TRANSACTION READ ONLY');
    try {
        await c.query("SET LOCAL statement_timeout='10s'");
        const id = (await c.query("SELECT current_database() AS db, coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]),false) AS privado")).rows[0];
        assert.equal(id.db, s3.ALVO.database, 'BANCO_CONECTADO_DIVERGENTE'); assert.equal(id.privado, true, 'REDE_NAO_PRIVADA');
        return await fn();
    } finally { await c.query('ROLLBACK').catch(() => {}); }
}
const SQL_KIDMAIS = `SELECT count(*)::int AS empresas,
  (SELECT count(*) FROM empresa_assinaturas a JOIN empresas k ON k.id=a.empresa_id WHERE k.codigo='kidmais')::int AS assinaturas
  FROM empresas WHERE codigo='kidmais' AND status='ATIVA'`;
const SQL_CAMPANHA = `SELECT count(*) FILTER (WHERE estado='CONFIRMADA')::int AS confirmadas,
  count(*) FILTER (WHERE estado<>'LIBERADA')::int AS ocupadas FROM assinatura_fundadores`;
const SQL_FIXTURES = `SELECT EXISTS(SELECT 1 FROM empresas WHERE id=ANY($1::uuid[]) OR codigo=ANY($2::text[]))
  OR EXISTS(SELECT 1 FROM usuarios_administrativos WHERE id=ANY($3::uuid[]) OR lower(btrim(email))=ANY($4::text[])) AS ocupado`;
const SQL_CNPJ = `SELECT (SELECT count(*) FROM cadastros_empresas WHERE documento=$1)::int AS cadastros,
  (SELECT count(*) FROM empresa_assinaturas WHERE documento_teste=$1)::int AS testes,
  (SELECT count(*) FROM assinatura_fundadores WHERE documento_beneficiario=$1)::int AS fundadores`;
const SQL_S4N = `SELECT e.status, a.situacao, a.ciclo, a.provedor_assinatura_id IS NOT NULL AS com_provedor,
  (SELECT count(*) FROM assinatura_contratacoes x WHERE x.empresa_id=e.id AND x.estado='CONFIRMADA')::int AS confirmadas,
  (SELECT json_build_object('plano',x.plano,'ciclo',x.ciclo,'regular',x.valor_regular_centavos,'final',x.valor_final_centavos,'desconto',x.desconto_percentual,'fundador',x.fundador_id IS NOT NULL)
     FROM assinatura_contratacoes x WHERE x.empresa_id=e.id AND x.estado='CONFIRMADA' ORDER BY x.confirmada_em DESC LIMIT 1) AS contratacao,
  (SELECT json_build_object('estado',f.estado,'beneficioLongo',f.beneficio_fim > clock_timestamp() + interval '364 days')
     FROM assinatura_fundadores f WHERE f.empresa_id=e.id AND f.estado<>'LIBERADA' LIMIT 1) AS fundador,
  (SELECT count(*) FROM cobranca_eventos ev WHERE ev.empresa_id=e.id AND ev.situacao='PROCESSADO')::int AS eventos_processados
  FROM cadastros_empresas ce JOIN empresas e ON e.id=ce.empresa_id LEFT JOIN empresa_assinaturas a ON a.empresa_id=e.id WHERE ce.documento=$1`;

function s4nOk(linhas, kidmais) {
    const e = linhas[0], k = e?.contratacao, f = e?.fundador;
    return linhas.length === 1 && e.status === 'ATIVA' && ['ATIVA', 'CANCELADA_FIM_PERIODO'].includes(e.situacao) && e.ciclo === S4N.ciclo
        && e.com_provedor === true && e.confirmadas === 1 && k?.plano === S4N.plano && k.ciclo === S4N.ciclo && k.regular === S4N.regular
        && k.final === S4N.final && k.desconto === S4N.desconto && k.fundador === true && f?.estado === 'CONFIRMADA' && f.beneficioLongo === true
        && e.eventos_processados >= 1 && kidmais.empresas === 1 && kidmais.assinaturas === 0;
}

function plano() {
    return {resultado:'PLANO', servico:SERVICO, deploy:DEPLOY, disco:DISCO, modos:MODOS, arquivosDoDeploy:DEPLOY_S4, chavesS3:CHAVES_S3, chavesS4:CHAVES_S4,
        cnpjS3R:CNPJ_S3R, cnpjTesteS3:CNPJ_TESTE_S3, s4n:S4N, asaas:ASAAS, webhook:ROTA_WEBHOOK};
}

/**
 * `o` existe para os testes locais: env, Client (pg), fetch, deploy (raiz com os módulos), dir (pasta da rodada 3), disco
 * (booleano no lugar da conferência do ponto de montagem), agora. A CLI usa sempre process.env, pg, fetch global e os caminhos do staging.
 */
async function principal(argv, o = {}) {
    const {modo, candidata, cnpj} = analisar(argv);
    if (modo === 'plano') return {codigo:0, saida:plano()};
    const env = o.env ?? process.env;
    const commit = servico(env);
    if (candidata !== null) assert.equal(commit, candidata, 'CANDIDATA_DIVERGENTE');
    const deploy = o.deploy ?? DEPLOY;
    const executor = require(path.join(deploy, 'scripts/homologacao-pagamento-renovacao-staging.cjs'));
    const configuracao = require(path.join(deploy, 'scripts/configuracao-homologacao-staging.cjs'));
    const dir = o.dir ?? path.dirname(executor.ARQUIVO), nomeEstado = path.basename(executor.ARQUIVO);
    const disco = typeof o.disco === 'boolean' ? o.disco : discoPersistente(DISCO), fetchImpl = o.fetch ?? fetch;
    const estado = () => resumoEstado(lerEstado(path.join(dir, nomeEstado)), executor);
    const Client = () => o.Client ?? require('pg').Client;

    if (modo === 'pre') {
        const r = estado(), reg = registro(configuracao, dir, env), presentes = Object.entries(chaves(env)).filter(([, v]) => v !== null).map(([k]) => k);
        const log = fs.existsSync(path.join(dir, LOG));
        const motivos = [...(presentes.length ? ['CHAVES_DA_JANELA_PRESENTES'] : []), ...(reg.resultado !== 'RESTAURADA' ? ['REGISTRO_' + reg.resultado] : []),
            ...(!disco ? ['DISCO_PERSISTENTE_AUSENTE'] : []), ...(r.estado === 'PRESENTE' && !arquivavel(r) ? ['ESTADO_NAO_ARQUIVAVEL'] : []),
            ...(r.estado === 'AUSENTE' && log ? ['LOG_SEM_ESTADO'] : [])];
        const resultado = motivos.length ? 'PRE_PARAR' : r.estado === 'PRESENTE' ? 'PRE_OK_ARQUIVAR' : 'PRE_OK';
        return {codigo:motivos.length ? 2 : 0, saida:{resultado, motivos, commitNoAr:commit, chavesPresentes:presentes, registro:reg, disco,
            estadoR3:r, arquivavel:r.estado === 'PRESENTE' && arquivavel(r), logR3:log ? 'PRESENTE' : 'AUSENTE', asaas:await asaas(env, fetchImpl)}};
    }
    if (modo === 'arquivar-r3') {
        assert.ok(disco, 'DISCO_PERSISTENTE_AUSENTE');
        const r = estado();
        assert.equal(r.estado, 'PRESENTE', 'SEM_ESTADO_PARA_ARQUIVAR');
        const feitos = arquivar(dir, nomeEstado, r);
        return {codigo:0, saida:{resultado:'ARQUIVADO', arquivos:feitos, estadoAgora:estado().estado, logAgora:fs.existsSync(path.join(dir, LOG)) ? 'PRESENTE' : 'AUSENTE'}};
    }
    if (modo === 's4-acompanhar') {
        const bruto = lerEstado(path.join(dir, nomeEstado)), r = resumoEstado(bruto, executor), vivo = processoVivo(bruto?.pid);
        const resultado = r.estado === 'AUSENTE' ? 'SEM_RODADA' : r.concluido === true ? 'PASS' : r.concluido === false ? 'INCOMPLETO'
            : vivo ? 'EM_EXECUCAO' : 'INTERROMPIDA_SEM_CONCLUSAO';
        return {codigo:['PASS', 'EM_EXECUCAO'].includes(resultado) ? 0 : 2, saida:{resultado, commitNoAr:commit, processoVivo:vivo, estadoR3:r, log:ultimaLinha(path.join(dir, LOG))}};
    }
    if (modo === 'pos') {
        const presentes = Object.entries(chaves(env)).filter(([, v]) => v !== null).map(([k]) => k), reg = registro(configuracao, dir, env);
        const ok = presentes.length === 0 && reg.resultado === 'RESTAURADA';
        const arquivados = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.includes('.precheck-')).sort() : [];
        return {codigo:ok ? 0 : 2, saida:{resultado:ok ? 'RESTAURADO' : 'NAO_RESTAURADO', commitNoAr:commit, chavesPresentes:presentes, registro:reg,
            estadoR3:estado(), arquivados}};
    }
    if (modo === 'janela') {
        const presentes = chaves(env), r = estado(), log = fs.existsSync(path.join(dir, LOG));
        const hora = executor.horaBrasil(o.agora ?? new Date());
        const a = await asaas(env, fetchImpl);
        const c = await conectar(env, Client());
        let banco;
        try {
            banco = await leitura(c, async () => {
                const campanha = (await c.query(SQL_CAMPANHA)).rows[0];
                const ocupado = (await c.query(SQL_FIXTURES, [executor.FIXTURES.map(f => f.empresa), executor.FIXTURES.map(f => f.codigo),
                    executor.FIXTURES.map(f => f.usuario), executor.FIXTURES.map(f => f.email)])).rows[0].ocupado;
                return {campanha:campanhaSegura(campanha), cabe:executor.cabeNaCampanha(campanha), fixturesLivres:ocupado === false, kidmais:(await c.query(SQL_KIDMAIS)).rows[0]};
            });
        } finally { await c.end().catch(() => {}); }
        const motivos = [...CHAVES_S4.filter(k => presentes[k] !== 'true').map(k => 'CHAVE_' + k), ...(!disco ? ['DISCO_PERSISTENTE_AUSENTE'] : []),
            ...(r.estado !== 'AUSENTE' ? ['ESTADO_R3_PRESENTE'] : []), ...(log ? ['LOG_R3_PRESENTE'] : []),
            ...(hora >= executor.HORA_LIMITE_BRT ? ['HORARIO_LIMITE'] : []), ...(a.resultado !== 'ASAAS_PRONTO' ? [a.resultado] : []),
            ...(!banco.cabe ? ['FUNDADOR_SEM_VAGAS'] : []), ...(!banco.fixturesLivres ? ['FIXTURE_PREEXISTENTE'] : [])];
        return {codigo:motivos.length ? 2 : 0, saida:{resultado:motivos.length ? 'JANELA_PARAR' : 'PRONTO_PARA_S4', motivos, candidata, chaves:presentes,
            horaBrasil:hora, asaas:a, banco, disco}};
    }
    // S3-R e S4-N (opcionais): banco somente leitura sobre o CNPJ informado.
    if (modo === 's3-antes') { assert.notEqual(cnpj, CNPJ_TESTE_S3, 'CNPJ_JA_USADO_NO_S3_DE_20_10'); janelaS3(env); }
    const c = await conectar(env, Client());
    try {
        if (modo === 's3-antes') {
            const antes = await s3.antes(c);
            const doc = await leitura(c, async () => (await c.query(SQL_CNPJ, [cnpj])).rows[0]);
            const livre = doc.cadastros === 0 && doc.testes === 0 && doc.fundadores === 0;
            const ok = antes.resultado === 'PRONTO_PARA_CADASTRO' && livre;
            return {codigo:ok ? 0 : 2, saida:{resultado:!livre ? 'CNPJ_JA_USADO' : antes.resultado, candidata, cnpj, usoDoCnpj:doc,
                bloqueiosGlobaisFuturos:antes.bloqueiosGlobaisFuturos, kidmais:antes.kidmais}};
        }
        if (modo === 's3-depois') {
            const r = await s3.depois(c, cnpj);
            return {codigo:r.resultado === 'S3_PASS' ? 0 : 2, saida:{...r, candidata, cnpj}};
        }
        const r = await leitura(c, async () => ({linhas:(await c.query(SQL_S4N, [cnpj])).rows, kidmais:(await c.query(SQL_KIDMAIS)).rows[0]}));
        const ok = s4nOk(r.linhas, r.kidmais);
        return {codigo:ok ? 0 : 2, saida:{resultado:ok ? 'S4N_PASS' : 'S4N_DIVERGENTE', candidata, cnpj, empresas:r.linhas.length, empresa:r.linhas[0] ?? null, kidmais:r.kidmais}};
    } finally { await c.end().catch(() => {}); }
}

/** Mensagem de erro segura: só códigos (MAIÚSCULAS); qualquer outro texto vira ERRO_INESPERADO (pode conter host etc.). */
function motivoSeguro(e) {
    const m = String(e?.message ?? '').split(/\r?\n/)[0].trim(); // o assert do Node 24 anexa o diff à mensagem
    if (/^[A-Z][A-Z0-9_]{2,60}$/.test(m)) return m;
    return /^[A-Z0-9_]{2,40}$/.test(String(e?.code ?? '')) ? 'ERRO_INESPERADO_' + e.code : 'ERRO_INESPERADO';
}

if (require.main === module) {
    principal(process.argv.slice(2)).then(({codigo, saida}) => { console.log(JSON.stringify(saida)); process.exitCode = codigo; },
        e => { console.log(JSON.stringify({resultado:'RECUSADO', motivo:motivoSeguro(e)})); process.exitCode = 1; });
}
module.exports = {SERVICO, DEPLOY, DISCO, ROTA_WEBHOOK, ASAAS, CHAVES_S3, CHAVES_S4, CHAVES_JANELA, CNPJ_TESTE_S3, CNPJ_S3R, DEPLOY_S4, S4N, LOG, MODOS,
    analisar, cnpjValido, servico, chaves, janelaS3, formatoAsaas, asaas, resumoEstado, arquivavel, carimbo, arquivar, registro, ultimaLinha,
    s4nOk, motivoSeguro, principal, SQL_S4N, SQL_CNPJ, SQL_CAMPANHA, SQL_FIXTURES};
