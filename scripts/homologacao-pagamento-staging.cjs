/* eslint-disable @typescript-eslint/no-require-imports */
// Rodada 3 de 10/10/2026 — pagamento sandbox (docs/HOMOLOGACAO_PAGAMENTO_STAGING_20261010.md). Executar SOMENTE no Web
// Shell do srv-daif418ae00c73e8k2gg, depois de aprovação explícita, com a flag única --pagamento-rodada-3-autorizada.
// Derivada do executor das rodadas 1/2 (homologacao-planos-cotacao-staging.cjs), com IDs novos, pagamento Fundador
// confirmado no sandbox (3 vagas ficam CONFIRMADAS para sempre: a 074 não libera vaga confirmada), benefício de 12 meses,
// regras de desconto diferentes por empresa e janela para testes de navegador. Escreve só nas fixtures; nunca apaga linha.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createHash, randomBytes, randomUUID} = require('node:crypto');
const {alvo: alvoEnsaio, documento, cookies, prepararWebhook} = require('./assinatura-staging-ensaio.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');

const BASE = 'https://kidmais-manager-staging.onrender.com';
const DIR = '/opt/render/project/src/data/homologacao-planos-cotacao-20261010';
const ARQUIVO = DIR + '/pagamento-rodada-3.json';
const SINAL_NAVEGADOR = DIR + '/pagamento-rodada-3-fim-navegador';
const MARCA = 'homologacao-pagamento-20261010-r3';
const FLAG = '--pagamento-rodada-3-autorizada';
const FLAG_ENCERRAR = '--encerrar-pagamento-rodada-3-autorizada';
const VAGAS_CAMPANHA = 20;
/** Mensal regular e com 40% Fundador, em centavos, fixados aqui (independentes do código). */
const PRECOS = Object.freeze({essencial:{regular:19700, fundador:11820}, profissional:{regular:39700, fundador:23820}, premium:{regular:69700, fundador:41820}});
/** Janela de navegador: espera o sinal ou este prazo (fixtures vivas durante os testes manuais). */
const JANELA_NAVEGADOR_MS = 25 * 60 * 1000;
const KIDMAIS_CNPJ = '20119900000160';
/** Faixa única do pacote das fixtures: 20–30 convidados, valor fixo (não por convidado). */
const FAIXA_POCKET = Object.freeze({min:20, max:30, valor:'1500.00'});
/**
 * Valor esperado em centavos, calculado aqui de forma independente do sistema: faixa fixa da fixture e desconto da
 * forma de pagamento com o mesmo arredondamento contratual (meio centavo para cima), em aritmética inteira.
 */
function precoEsperado(descontoPercentual) {
    assert.ok(Number.isInteger(descontoPercentual) && descontoPercentual >= 0 && descontoPercentual <= 100);
    const centavos = Number(FAIXA_POCKET.valor.replace('.', ''));
    return Math.floor((centavos * (100 - descontoPercentual) + 50) / 100);
}
const FIXTURES = Object.freeze([
    {chave:'F1', empresa:'a1dc1470-31ef-499d-8cbc-8f108b762104', usuario:'15ec892d-eadc-429a-9908-6b0066144a55', codigo:'hml-pag-essencial', tipo:'PLANO', plano:'essencial', catalogo:true},
    {chave:'F2', empresa:'1a39d21f-c57e-4b06-a92c-c7702243b10c', usuario:'b8d6bb8c-e973-4be5-8494-507ccf68dbee', codigo:'hml-pag-profissional', tipo:'PLANO', plano:'profissional', catalogo:true},
    {chave:'F3', empresa:'f2012e2b-bf41-4b6e-9dcc-9da915f0b57b', usuario:'462c175a-6176-442e-bf15-91495fc8e7b9', codigo:'hml-pag-isenta', tipo:'ISENTA', plano:null, catalogo:false},
    {chave:'F4', empresa:'5c081ffa-3298-4c9c-864d-90e91a147fd0', usuario:'5c226b88-e043-4179-98d3-45ac82a658a5', codigo:'hml-pag-teste', tipo:'TESTE', plano:null, catalogo:true},
    {chave:'F5', empresa:'1aae291c-3418-49c3-a68f-97f83a7d32a0', usuario:'804d590e-0869-4156-9568-c624d15cdfc0', codigo:'hml-pag-premium', tipo:'PLANO', plano:'premium', catalogo:true},
].map(f => Object.freeze({...f, email:`hml-pag-${f.usuario.slice(0,8)}@example.invalid`,
    nome:`TESTE Kidmais — pagamento staging 20261010 r3 ${f.chave}`})));
const PAGANTES = FIXTURES.filter(f => f.tipo === 'PLANO');
const IDS_EMPRESAS = FIXTURES.map(f => f.empresa);
/** Regras de desconto diferentes (077), só nas fixtures: F2 sem regra (0%), F4 PIX à vista 5%, F5 PIX à vista 8%; Kidmais 10% legado. */
const REGRAS = Object.freeze({
    F4: Object.freeze({pixAvista:5, pixParcelado:2, cartao:'Cartão homologação', diaUtil:false}),
    F5: Object.freeze({pixAvista:8, pixParcelado:4, cartao:'Cartão homologação', diaUtil:false}),
});
/** Limite de pessoas por plano contratado (planos-comerciais): Premium sem teto. */
const LIMITE_PESSOAS = Object.freeze({essencial:3, profissional:10, premium:null});

/** Tabelas comparadas antes/depois, sempre SEM as fixtures. Colunas voláteis do cron ficam fora (como no ensaio de 09/10). */
const PRESERVADAS = Object.freeze([
    ['empresas', 'id', []], ['memberships', 'empresa_id', []],
    ['empresa_assinaturas', 'empresa_id', ['sincronizado_em','atualizado_em','versao']],
    ['assinatura_contratacoes', 'empresa_id', []], ['assinatura_fundadores', 'empresa_id', []], ['assinatura_isencoes', 'empresa_id', []],
    ['clientes', 'empresa_id', []], ['fechamentos', 'empresa_id', []], ['pacotes', 'empresa_id', []],
    ['financeiro_categorias', 'empresa_id', []], ['financeiro_contas_pagar', 'empresa_id', []],
    ['empresa_regras_pagamento', 'empresa_id', []], // inclui a regra legada da Kidmais (077)
]);
function sqlPreservacao(tabela, coluna, volateis) {
    assert.ok(/^[a-z_]+$/.test(tabela) && /^[a-z_]+$/.test(coluna) && volateis.every(v => /^[a-z_]+$/.test(v)));
    const linha = volateis.length ? `to_jsonb(t) - ARRAY[${volateis.map(v => `'${v}'`).join(',')}]::text[]` : 'to_jsonb(t)';
    return `SELECT (${linha})::text AS linha FROM public.${tabela} t WHERE coalesce(t.${coluna}::text,'') <> ALL($1::text[]) ORDER BY 1`;
}

/** Guardas do ensaio de 09/10 + chave da cotação ligada (O2). Qualquer divergência encerra antes de escrever. */
function alvo(env) {
    const opcoes = alvoEnsaio(env);
    assert.equal(env.COTACAO_PUBLICA_POR_EMPRESA, 'true', 'CHAVE_COTACAO_AUSENTE');
    return opcoes;
}
function autorizado(argv) {
    return modo(argv) === 'RODADA';
}
/** Exatamente uma flag: a da rodada (O3) ou a do encerramento de execução interrompida. */
function modo(argv) {
    const flags = argv.filter(a => a.startsWith('--'));
    if (flags.length !== 1) return null;
    return flags[0] === FLAG ? 'RODADA' : flags[0] === FLAG_ENCERRAR ? 'ENCERRAR' : null;
}

// Matriz de aceite (O4). `null` = qualquer status diferente de 403 RECURSO_FORA_DO_PLANO e < 500.
const FINANCEIRO = Object.freeze({
    F1: {contasPagar:403, criarConta:403, fluxo:403, relatorios:403, completo:false, receber:200},
    F2: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
    F3: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
    F4: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
    F5: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
});
/** Ocupação da campanha Fundador (todas as empresas). */
async function campanha(db) {
    return (await db.query(`SELECT count(*) FILTER (WHERE estado='CONFIRMADA')::int AS confirmadas,
        count(*) FILTER (WHERE estado<>'LIBERADA')::int AS ocupadas FROM assinatura_fundadores`)).rows[0];
}
/** As três confirmações precisam caber sem mexer no teto. */
function cabeNaCampanha(c) {
    return Number.isInteger(c?.ocupadas) && c.ocupadas + PAGANTES.length <= VAGAS_CAMPANHA;
}
/** Conta de navegador opcional (HML_NAVEGADOR_EMAIL, aprovada por Felipe): só formato; existência conferida em S1. */
function emailDeNavegador(env) {
    const e = env.HML_NAVEGADOR_EMAIL;
    if (e === undefined || e === '') return null;
    assert.match(e, /^[^@\s]{1,64}@[^@\s]{1,190}$/, 'CONTA_NAVEGADOR_INVALIDA');
    assert.ok(!/@example\.invalid$/i.test(e), 'CONTA_NAVEGADOR_INVALIDA');
    return e;
}
/** Espera o arquivo de sinal (criado no Shell) ou o prazo. Devolve como a janela fechou. */
async function aguardarSinal(arquivo, prazoMs, existe = fs.existsSync, pausa = ms => new Promise(ok => setTimeout(ok, ms)), agora = Date.now) {
    const fim = agora() + prazoMs;
    while (agora() < fim) { if (existe(arquivo)) return 'SINAL'; await pausa(5000); }
    return 'PRAZO';
}
function conferir(nome, obtido, esperado) {
    if (obtido !== esperado) throw Object.assign(Error('MATRIZ_DIVERGENTE'), {parada:'S2', item:nome, obtido, esperado});
}
/** Endereço atual da Kidmais: compara só o que o cliente vê (datas, períodos, horários e status), sem carimbos de tempo. */
function projecaoAgenda(j) {
    const dias = Array.isArray(j?.data) ? j.data : [j?.data];
    return {comercial:j?.comercial ?? null, dias:dias.map(d => ({data:d?.data, periodos:(d?.periodos ?? []).map(p => ({codigo:p.codigo,
        horarios:(p.horarios ?? []).map(h => ({inicio:h.inicio, fim:h.fim, ajuste:h.ajusteMinutos, status:h.status}))}))}))};
}
function hashProjecao(valor) {
    return createHash('sha256').update(JSON.stringify(valor ?? null)).digest('hex');
}
function cpfSintetico() {
    for (;;) {
        const n = Array.from(randomBytes(9), b => b % 10);
        if (new Set(n).size === 1) continue;
        for (const len of [9, 10]) { const s = n.slice(0, len).reduce((t, d, i) => t + d * (len + 1 - i), 0); const r = (s * 10) % 11; n.push(r === 10 ? 0 : r); }
        return n.join('');
    }
}

const URL_WEBHOOK = BASE + '/api/integracoes/asaas/webhook';

/**
 * O que a rodada comprovadamente criou, só a partir do estado gravado ANTES de cada criação:
 *  - fixtures do banco: S1 provou que IDs, códigos e e-mails não existiam (`precheck.fixturesLivres`) E a rodada
 *    registrou a intenção de criá-las (`intencaoFixture`) — vale mesmo se a interrupção ocorreu antes de `fixture`;
 *  - assinatura sandbox de F1/F2: S1 provou que não havia cliente Asaas com a referência da fixture
 *    (`precheck.asaasLivre[F]`) E a rodada registrou `intencaoCheckout`; se o cliente já foi salvo, ele tem de conferir;
 *  - webhook: só se a rodada registrou a intenção de CRIÁ-LO (nome inédito conferido antes); reutilizado nunca.
 * Sem prova, nada é tocado (colisão, precheck incompleto, estado de outra rodada).
 */
function recursosComprovados(r) {
    const livre = r?.precheck?.fixturesLivres === true;
    return {
        fixtures: livre && r.intencaoFixture === true,
        assinaturas: Object.fromEntries(FIXTURES.filter(f => f.tipo === 'PLANO').map(f =>
            [f.chave, r?.precheck?.asaasLivre?.[f.chave] === true && r[f.chave]?.intencaoCheckout === true])),
        webhook: r?.intencaoWebhook === true && r?.webhookReutilizado !== true && typeof r?.webhookNome === 'string' && r.webhookNome.length > 0,
    };
}

/**
 * Encerramento idempotente, usado no `finally` da rodada e no modo de recuperação. Nunca lança: cada etapa registra a
 * própria falha em `r.falhasEncerramento` e devolve a primeira; o chamador preserva o erro original da rodada.
 * Só toca recursos de `recursosComprovados(r)`. Nunca apaga linha do banco.
 */
async function encerrar({db, conectado, r, p, api, salvar}) {
    let erro = null;
    const gravar = () => { try { salvar(); } catch { /* estado em disco indisponível não impede o encerramento */ } };
    const falhar = (etapa, e) => { erro ??= Object.assign(Error('LIMPEZA_' + etapa), {etapa});
        r.falhasEncerramento = [...(r.falhasEncerramento ?? []), {etapa, mensagem:String(e?.message ?? e).slice(0, 120)}]; gravar(); };
    try {
        if (conectado) await db.query('ROLLBACK').catch(() => {});
        const prova = recursosComprovados(r);
        r.encerramento = {inicio:new Date().toISOString(), prova}; gravar();
        for (const f of FIXTURES.filter(x => x.tipo === 'PLANO')) {
            if (!prova.assinaturas[f.chave]) { r.encerramento[f.chave] = {acao:'NADA_CRIADO_PELA_RODADA'}; gravar(); continue; }
            try {
                const subs = await p.listarAssinaturasPorReferencia(f.empresa); assert.ok(subs.length <= 1, 'SUB_DUPLICADA');
                const removidas = [];
                for (const sub of subs) {
                    assert.equal(sub.externalReference, f.empresa, 'SUB_DE_OUTRA_REFERENCIA');
                    if (r[f.chave]?.clienteId) assert.equal(sub.customer, r[f.chave].clienteId, 'SUB_DE_OUTRO_CLIENTE');
                    if (r[f.chave]?.assinaturaId) assert.equal(sub.id, r[f.chave].assinaturaId, 'SUB_DIFERENTE_DA_REGISTRADA');
                    if (!sub.deleted) { assert.equal((await p.removerAssinatura(sub.id)).removida, true, 'SUB_NAO_REMOVIDA'); removidas.push(sub.id); }
                }
                r.encerramento[f.chave] = {acao:'ASSINATURA_ENCERRADA', encontradas:subs.length, removidas:removidas.length}; gravar();
            } catch (e) { r.limpezaAssinaturaPendente = true; falhar('ASSINATURA_' + f.chave, e); }
        }
        try {
            if (prova.webhook) {
                if (!r.webhookId) {
                    const lista = await api('/webhooks?limit=100'); assert.ok(lista && !lista.hasMore, 'WEBHOOKS_PAGINADOS');
                    const candidatos = lista.data.filter(w => w.name === r.webhookNome && w.url === URL_WEBHOOK);
                    assert.ok(candidatos.length <= 1, 'WEBHOOK_AMBIGUO'); r.webhookId = candidatos[0]?.id; gravar();
                }
                if (r.webhookId) { const w = await api('/webhooks/' + encodeURIComponent(r.webhookId));
                    if (w) { assert.equal(w.name, r.webhookNome, 'WEBHOOK_DE_OUTRO_NOME'); assert.equal(w.url, URL_WEBHOOK, 'WEBHOOK_DE_OUTRA_URL');
                        await api('/webhooks/' + encodeURIComponent(r.webhookId), 'DELETE'); } }
                r.encerramento.webhook = 'ENCERRADO';
            } else r.encerramento.webhook = 'NADA_CRIADO_PELA_RODADA';
            r.webhookEncerrado = true; gravar();
        } catch (e) { r.limpezaWebhookPendente = true; falhar('WEBHOOK', e); }
        try {
            if (!prova.fixtures) r.encerramento.fixtures = 'NADA_CRIADO_PELA_RODADA';
            else if (!conectado) throw Error('BANCO_INDISPONIVEL');
            else {
                // Além do ID reservado, cada UPDATE confere o marcador da fixture (nome/e-mail/código).
                await db.query('BEGIN');
                await db.query('UPDATE usuarios_administrativos SET ativo=false WHERE id=ANY($1::uuid[]) AND email=ANY($2::text[])', [FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email)]);
                // Vínculos das fixtures, inclusive o da conta de navegador (só nas empresas das fixtures, nunca a conta em si).
                await db.query("UPDATE memberships SET status='REVOGADA' WHERE empresa_id=ANY($1::uuid[]) AND usuario_id=ANY($2::uuid[]) AND status<>'REVOGADA'",
                    [IDS_EMPRESAS, [...FIXTURES.map(f => f.usuario), ...(r.navegador?.intencao && r.navegador?.usuarioId ? [r.navegador.usuarioId] : [])]]);
                await db.query("UPDATE empresas SET status='DESATIVADA' WHERE id=ANY($1::uuid[]) AND codigo=ANY($2::text[]) AND nome=ANY($3::text[]) AND status<>'DESATIVADA'", [IDS_EMPRESAS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.nome)]);
                await db.query('COMMIT'); r.fixturesDesativadas = true; r.encerramento.fixtures = 'DESATIVADAS';
            }
            gravar();
        } catch (e) { if (conectado) await db.query('ROLLBACK').catch(() => {}); r.limpezaBancoPendente = true; falhar('BANCO', e); }
    } catch (e) { falhar('ENCERRAMENTO', e); }
    try { r.encerramento = {...(r.encerramento ?? {}), fim:new Date().toISOString()}; } catch { /* nada */ }
    gravar();
    return erro;
}

/** Erro final da execução: o original da rodada prevalece; falha de limpeza só vira erro se não houve outro. */
function erroFinal(original, doEncerramento) {
    return original ?? doEncerramento ?? null;
}

/** Processo da rodada original ainda vivo? Recuperação nunca roda em paralelo com ela. */
function processoVivo(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Guardas do modo de recuperação: mesmo alvo, sem exigir as chaves de O1 (O5 pode já tê-las desligado). */
function alvoEncerramento(env) {
    return alvoEnsaio({...env, ASSINATURA_PLANOS_ATIVOS:'true'});
}

/**
 * Recuperação de execução interrompida (queda do Shell, deploy/restart, kill): exige o arquivo de estado da rodada,
 * recusa se o processo original ainda estiver vivo e repete só o encerramento. Pode ser executada mais de uma vez.
 */
async function recuperar() {
    const opts = alvoEncerramento(process.env);
    exigirDisco();
    const arquivo = ARQUIVO;
    assert.ok(fs.existsSync(arquivo), 'SEM_RODADA_PARA_ENCERRAR');
    const r = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    assert.equal(r.marca, MARCA, 'ESTADO_DE_OUTRA_RODADA');
    assert.ok(!(r.concluido === undefined && processoVivo(r.pid)), 'RODADA_EM_EXECUCAO');
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600});
    r.recuperacoes = [...(r.recuperacoes ?? []), new Date().toISOString()]; salvar();
    const {Client} = require('pg');
    const {configuracaoAsaas, criarClienteAsaas} = await import('../lib/assinatura/asaas.ts');
    const cfg = configuracaoAsaas(); assert.ok(cfg.ligado, 'ASAAS_DESLIGADO'); const p = criarClienteAsaas(cfg.config);
    const api = async (caminho, method = 'GET') => {
        assert.ok(/^\/webhooks(\/|\?|$)/.test(caminho));
        const res = await fetch('https://api-sandbox.asaas.com/v3' + caminho, {method, redirect:'error', signal:AbortSignal.timeout(15000),
            headers:{access_token:cfg.config.apiKey, 'User-Agent':'kidmais-staging-homologacao', 'Content-Type':'application/json'}});
        if (res.status === 404 && method === 'GET') return null;
        if (!res.ok) throw Object.assign(Error('ASAAS_HTTP'), {status:res.status}); return res.json();
    };
    const db = new Client(opts); let conectado = false, erro = null;
    try {
        await db.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        const id = (await db.query(SQL_IDENTIDADE)).rows[0];
        conferirIdentidade(id, process.env, '_S1');
    } catch (e) { conectado = false; erro = e; }
    // Mesmo sem banco, o encerramento do Asaas roda; o erro de conexão é o original e prevalece.
    erro = erroFinal(erro, await encerrar({db, conectado, r, p, api, salvar}));
    await db.end().catch(() => {});
    r.recuperado = !erro; salvar();
    console.log(JSON.stringify({resultado:erro ? 'ENCERRAMENTO_INCOMPLETO' : 'ENCERRADO', erro:erro ? String(erro.message).slice(0, 80) : null,
        prova:r.encerramento?.prova ?? null, fixtures:r.encerramento?.fixtures ?? null, webhook:r.encerramento?.webhook ?? null,
        assinaturasSandbox:FIXTURES.filter(f => f.tipo === 'PLANO').map(f => ({[f.chave]:r.encerramento?.[f.chave] ?? null})),
        falhasEncerramento:r.falhasEncerramento ?? []}));
    if (erro) process.exitCode = 2;
}

async function main() {
    const opts = alvo(process.env);
    const {Client} = require('pg');
    const {configuracaoAsaas, criarClienteAsaas} = await import('../lib/assinatura/asaas.ts');
    const {criarHashSenha} = await import('../lib/autenticacao/senha.ts');
    const precos = await import('../lib/comercial/pacote-precos.ts');
    const pacotesAdmin = await import('../lib/comercial/pacotes-admin.ts');
    const cfg = configuracaoAsaas(); assert.ok(cfg.ligado, 'ASAAS_DESLIGADO'); const p = criarClienteAsaas(cfg.config);
    exigirDisco();
    fs.mkdirSync(DIR, {recursive:true, mode:0o700});
    const arquivo = ARQUIVO;
    assert.ok(!fs.existsSync(arquivo), 'RODADA_EXISTENTE_S1');
    const r = {marca:MARCA, inicio:new Date().toISOString(), pid:process.pid, etapas:[], resultados:{}};
    fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'}); // uma rodada só
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600});
    const emailNavegador = emailDeNavegador(process.env);
    const db = new Client(opts); let conectado = false, erro, etapa = 'PRECHECK';
    const tx = {query: async (t, v) => { const x = await db.query(t, v); return {rows:x.rows, rowCount:x.rowCount}; }};
    const marcar = e => { etapa = e; r.etapas.push(e); salvar(); };
    const senhas = new Map(FIXTURES.map(f => [f.chave, 'Sintetica-' + randomBytes(24).toString('hex')])); // só em memória
    const api = async (caminho, method = 'GET', body) => {
        assert.ok(/^\/(webhooks|sandbox\/payment)(\/|\?|$)/.test(caminho));
        const res = await fetch('https://api-sandbox.asaas.com/v3' + caminho, {method, redirect:'error', signal:AbortSignal.timeout(15000),
            headers:{access_token:cfg.config.apiKey, 'User-Agent':'kidmais-staging-homologacao', 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
        if (res.status === 404 && method === 'GET') return null;
        if (!res.ok) throw Object.assign(Error('ASAAS_HTTP'), {status:res.status}); return res.json();
    };
    // Sessão administrativa de uma fixture; cookies e CSRF só em memória.
    const sessao = f => {
        const jar = new Map();
        const pedir = async (caminho, method = 'GET', body, extras = {}) => {
            assert.ok(caminho.startsWith('/api/admin/'));
            const res = await fetch(BASE + caminho, {method, redirect:'error', signal:AbortSignal.timeout(60000),
                headers:{Cookie:[...jar].map(([k, v]) => k + '=' + v).join(';'), 'Content-Type':'application/json', ...extras}, ...(body ? {body:JSON.stringify(body)} : {})});
            cookies(res.headers, jar); const j = await res.json().catch(() => ({})); return {status:res.status, j};
        };
        const post = async (caminho, body) => { const s = (await pedir('/api/admin/autenticacao')).j.data ?? {};
            return pedir(caminho, 'POST', body, {Origin:BASE, 'x-csrf-token':s.csrf ?? '', ...(s.sessaoId ? {'x-kidmais-sessao':s.sessaoId} : {})}); };
        return {pedir, post, entrar: async () => {
            assert.equal((await post('/api/admin/autenticacao', {acao:'login', email:f.email, senha:senhas.get(f.chave)})).status, 200, 'LOGIN_' + f.chave);
            assert.equal((await post('/api/admin/autenticacao', {acao:'selecionar-empresa', empresaId:f.empresa})).status, 200, 'EMPRESA_' + f.chave);
        }};
    };
    const publico = async (caminho, method = 'GET', body) => {
        assert.ok(caminho.startsWith('/api/fechamentos') || caminho.startsWith('/api/disponibilidade') || caminho.startsWith('/b/')
            || caminho.startsWith('/api/identidade/consultar-cpf'));
        const res = await fetch(BASE + caminho, {method, redirect:'manual', signal:AbortSignal.timeout(60000),
            headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
        const texto = await res.text(); let j = null; try { j = JSON.parse(texto); } catch { /* página HTML */ }
        return {status:res.status, j, hash:createHash('sha256').update(texto).digest('hex')};
    };
    const preservacao = async () => {
        const hashes = {};
        for (const [tabela, coluna, volateis] of PRESERVADAS) {
            const linhas = (await db.query(sqlPreservacao(tabela, coluna, volateis), [IDS_EMPRESAS])).rows.map(x => x.linha);
            hashes[tabela] = createHash('sha256').update(JSON.stringify(linhas)).digest('hex'); // hash só em memória/arquivo, nunca linhas
        }
        return hashes;
    };
    const proximoMes = () => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1, 1); const i = d.toISOString().slice(0, 10);
        d.setUTCMonth(d.getUTCMonth() + 1, 0); return `inicio=${i}&fim=${d.toISOString().slice(0, 10)}`; };
    const kidmaisPublico = async () => {
        const pacotes = await publico('/api/fechamentos/pacotes'), agenda = await publico('/api/disponibilidade?' + proximoMes());
        assert.equal(pacotes.status, 200, 'KIDMAIS_PACOTES'); assert.equal(agenda.status, 200, 'KIDMAIS_AGENDA');
        return {pacotes:hashProjecao(pacotes.j), agenda:hashProjecao(projecaoAgenda(agenda.j))};
    };
    try {
        // ---- S1: alvo, identidade do banco, TLS conforme a configuração, schema e fixtures livres.
        await db.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        const id = (await db.query(SQL_IDENTIDADE)).rows[0];
        r.conexao = conferirIdentidade(id, process.env, '_S1'); salvar();
        const schema = (await db.query(`SELECT to_regclass('public.assinatura_isencoes') IS NOT NULL AND to_regclass('public.financeiro_categorias') IS NOT NULL
            AND to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL
            AND to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NOT NULL AND to_regclass('public.clientes_cpf_canonico_uk') IS NULL
            AND to_regclass('public.empresa_regras_pagamento') IS NOT NULL AS ok`)).rows[0];
        assert.equal(schema.ok, true, 'SCHEMA_S1'); // 076 e 077 aplicadas em O3
        const ocupado = (await db.query(`SELECT EXISTS(SELECT 1 FROM empresas WHERE id=ANY($1::uuid[]) OR codigo=ANY($2::text[]))
            OR EXISTS(SELECT 1 FROM usuarios_administrativos WHERE id=ANY($3::uuid[]) OR email=ANY($4::text[])) AS ocupado`,
            [IDS_EMPRESAS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email)])).rows[0];
        assert.equal(ocupado.ocupado, false, 'FIXTURE_PREEXISTENTE_S1');
        // Campanha Fundador: as três confirmações precisam caber sem tocar no teto nem em vagas de terceiros.
        r.campanhaAntes = await campanha(db); salvar();
        if (!cabeNaCampanha(r.campanhaAntes)) throw Object.assign(Error('FUNDADOR_SEM_VAGAS_S4'), {parada:'S4'});
        // Conta de navegador (opcional, aprovada por Felipe): só o id é guardado; precisa existir, estar ativa e não ser fixture.
        if (emailNavegador) {
            const u = (await db.query('SELECT id::text AS id FROM usuarios_administrativos WHERE lower(email)=lower($1) AND ativo', [emailNavegador])).rows;
            assert.equal(u.length, 1, 'CONTA_NAVEGADOR_S1'); assert.ok(!FIXTURES.some(f => f.usuario === u[0].id), 'CONTA_NAVEGADOR_S1');
            r.navegador = {usuarioId:u[0].id}; salvar();
        }
        // Prova de autoria para o encerramento: só depois de S1 aprovar, gravada ANTES de qualquer criação.
        r.precheck = {fixturesLivres:true, asaasLivre:{}}; salvar();
        for (const f of FIXTURES.filter(x => x.tipo === 'PLANO')) {
            assert.equal(await p.buscarClientePorReferencia(f.empresa), null, 'CLIENTE_ASAAS_PREEXISTENTE_S1');
            assert.equal((await p.listarAssinaturasPorReferencia(f.empresa)).length, 0, 'ASSINATURA_ASAAS_PREEXISTENTE_S1');
            r.precheck.asaasLivre[f.chave] = true; salvar();
        }
        r.antes = await preservacao(); r.kidmaisAntes = await kidmaisPublico(); salvar();

        // ---- Fixtures (uma transação). Nenhuma linha de outra empresa é tocada.
        marcar('FIXTURES'); r.intencaoFixture = true; salvar(); await db.query('BEGIN');
        for (const f of FIXTURES) {
            let doc; do { doc = documento(); } while (doc === KIDMAIS_CNPJ
                || (await db.query('SELECT 1 FROM assinatura_fundadores WHERE documento_beneficiario=$1', [doc])).rowCount);
            await db.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,$3,'PROVISIONAMENTO')", [f.empresa, f.codigo, f.nome]);
            await db.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [f.empresa]);
            await db.query("INSERT INTO usuarios_administrativos(id,email,nome,senha_hash,papel,ativo) VALUES($1,$2,'Gestão Sintética Homologação',$3,'REPRESENTANTE_AUTORIZADO',true)",
                [f.usuario, f.email, await criarHashSenha(senhas.get(f.chave))]);
            await db.query("UPDATE usuarios_administrativos SET senha_alterada_em=clock_timestamp()-interval '1 hour' WHERE id=$1", [f.usuario]);
            await db.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())", [f.empresa, f.usuario]);
            await db.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [f.empresa, f.usuario]);
            await db.query("INSERT INTO financeiro_categorias(empresa_id,tipo,nome) VALUES($1,'DESPESA','Homologação')", [f.empresa]);
            if (f.tipo === 'PLANO')
                await db.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp()-interval '16 days',clock_timestamp()-interval '1 hour',$2)", [f.empresa, doc]);
            if (f.tipo === 'TESTE')
                await db.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp(),clock_timestamp()+interval '15 days',$2)", [f.empresa, doc]);
            if (f.tipo === 'ISENTA')
                await db.query("INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,'Homologação sintética staging 20261010',$3)", [f.empresa, doc, f.usuario]);
            const regra = REGRAS[f.chave];
            if (regra)
                await db.query(`INSERT INTO empresa_regras_pagamento(empresa_id,pix_avista_percentual,pix_parcelado_percentual,cartao_rotulo,desconto_dia_util,motivo)
                    VALUES($1,$2,$3,$4,$5,'Homologação sintética staging 20261010 r3')`, [f.empresa, regra.pixAvista, regra.pixParcelado, regra.cartao, regra.diaUtil]);
        }
        await db.query('COMMIT'); r.fixture = true; salvar();

        // ---- Catálogo mínimo pelos serviços de domínio (padrão de scripts/adicionais-ui.cjs).
        marcar('CATALOGO');
        const horarios = (await db.query('SELECT id::text AS id FROM configuracao_agenda WHERE ativo')).rows.map(x => x.id);
        assert.ok(horarios.length > 0, 'AGENDA_SEM_HORARIOS');
        for (const f of FIXTURES.filter(x => x.catalogo)) {
            const ctx = () => ({empresaId:f.empresa, usuarioId:f.usuario, requestId:randomUUID(), motivo:'PACOTE_EDITADO'});
            const pacote = (await db.query(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
                VALUES ($1, 'POCKET', 'Pocket homologação', 1, true, true, 20, 30) RETURNING id`, [f.empresa])).rows[0].id;
            await db.query('BEGIN'); await precos.gravarFaixasPacote(tx, f.empresa, pacote, [{convidadosMin:FAIXA_POCKET.min, convidadosMax:FAIXA_POCKET.max, valor:FAIXA_POCKET.valor}], {minimo:FAIXA_POCKET.min, maximo:FAIXA_POCKET.max}, ctx()); await db.query('COMMIT');
            await db.query('BEGIN'); await pacotesAdmin.definirDisponibilidadePacoteAdmin(tx, pacote, {disponibilidade:[1,2,3,4,5,6,7].flatMap(dia => horarios.map(horarioId => ({dia, horarioId})))}, ctx()); await db.query('COMMIT');
        }
        r.catalogo = true; salvar();

        // ---- Sessões e pagamento Fundador no sandbox (F1 Essencial, F2 Profissional, F5 Premium). A vaga confirmada é permanente.
        const s = Object.fromEntries(FIXTURES.map(f => [f.chave, sessao(f)]));
        for (const f of FIXTURES) await s[f.chave].entrar();
        marcar('WEBHOOK'); await prepararWebhook(api, cfg.config, r, salvar);
        for (const f of PAGANTES) {
            marcar('CHECKOUT_' + f.chave);
            const antes = (await s[f.chave].pedir('/api/admin/assinatura')).j.data;
            conferir(f.chave + '.habilitado', antes?.ofertas?.habilitado, true); conferir(f.chave + '.fundador', antes.ofertas.fundador, true);
            conferir(f.chave + '.aguardandoVaga', antes.ofertas.aguardandoVaga, false);
            const oferta = antes.ofertas.planos.find(x => x.id === f.plano);
            conferir(f.chave + '.precoRegular', oferta?.mensalRegular, PRECOS[f.plano].regular);
            conferir(f.chave + '.precoFundador', oferta?.mensal, PRECOS[f.plano].fundador);
            r[f.chave] = {intencaoCheckout:true, valor:PRECOS[f.plano].fundador}; salvar(); // prova de autoria ANTES do checkout
            const ck = await s[f.chave].post('/api/admin/assinatura/checkout', {plano:f.plano, ciclo:'MENSAL', valorEsperadoCentavos:PRECOS[f.plano].fundador, versao:antes.ofertas.versao});
            conferir('CHECKOUT_' + f.chave, ck.status, 200);
            const linha = (await db.query('SELECT provedor_cliente_id,provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id=$1', [f.empresa])).rows[0];
            Object.assign(r[f.chave], {clienteId:linha.provedor_cliente_id, assinaturaId:linha.provedor_assinatura_id}); salvar();
            conferir(f.chave + '.vagaReservada', (await db.query("SELECT estado FROM assinatura_fundadores WHERE empresa_id=$1", [f.empresa])).rows.map(x => x.estado).join(), 'RESERVADA');
            const pagamento = (await p.listarCobrancasDaAssinatura(r[f.chave].assinaturaId)).filter(x => !x.deleted).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
            conferir(f.chave + '.cobranca.valor', pagamento?.valorCentavos, PRECOS[f.plano].fundador);
            conferir(f.chave + '.cobranca.assinatura', pagamento?.assinaturaId, r[f.chave].assinaturaId);
            r[f.chave].pagamentoId = pagamento.id; r[f.chave].intencaoPagamento = true; salvar(); // a partir daqui a vaga fica confirmada
            await api('/sandbox/payment/' + encodeURIComponent(pagamento.id) + '/confirm', 'POST');
            // Callback: evento do webhook processado para a empresa da fixture (até 3 min).
            for (let i = 0; ; i++) {
                const ev = (await db.query("SELECT 1 FROM cobranca_eventos WHERE empresa_id=$1 AND tipo IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED') AND situacao='PROCESSADO'", [f.empresa])).rowCount;
                if (ev) break; if (i >= 180) throw Object.assign(Error('CALLBACK_S4'), {parada:'S4'}); await new Promise(ok => setTimeout(ok, 1000));
            }
            // Benefício: vaga e contratação confirmadas com o pagamento; fim = confirmação + 12 meses (UTC), conferido no banco.
            const b = (await db.query(`SELECT v.estado AS vaga, v.vaga AS numero, v.pagamento_confirmacao_id = $2 AS vaga_pagamento,
                    v.beneficio_fim = ((v.confirmada_em AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC' AS doze_meses,
                    v.beneficio_fim > clock_timestamp() + interval '364 days' AS vigente_um_ano,
                    c.estado AS contratacao, c.desconto_percentual, c.valor_final_centavos, c.pagamento_confirmacao_id = $2 AS contrato_pagamento,
                    a.contratacao_atual_id = c.id AS atual
                FROM assinatura_fundadores v JOIN assinatura_contratacoes c ON c.empresa_id=v.empresa_id AND c.fundador_id=v.id
                JOIN empresa_assinaturas a ON a.empresa_id=v.empresa_id WHERE v.empresa_id=$1`, [f.empresa, pagamento.id])).rows;
            conferir(f.chave + '.beneficio.linhas', b.length, 1);
            conferir(f.chave + '.vagaConfirmada', b[0].vaga, 'CONFIRMADA'); conferir(f.chave + '.vagaPagamento', b[0].vaga_pagamento, true);
            conferir(f.chave + '.beneficio12Meses', b[0].doze_meses, true); conferir(f.chave + '.beneficioVigente', b[0].vigente_um_ano, true);
            conferir(f.chave + '.contratacaoConfirmada', b[0].contratacao, 'CONFIRMADA'); conferir(f.chave + '.contratacaoAtual', b[0].atual, true);
            conferir(f.chave + '.desconto', b[0].desconto_percentual, 40); conferir(f.chave + '.valorFinal', b[0].valor_final_centavos, PRECOS[f.plano].fundador);
            conferir(f.chave + '.contratoPagamento', b[0].contrato_pagamento, true);
            r[f.chave].vagaNumero = b[0].numero; salvar();
            const depois = (await s[f.chave].pedir('/api/admin/assinatura')).j.data;
            conferir(f.chave + '.acesso', depois.acesso.nivel, 'COMPLETO'); conferir(f.chave + '.plano', depois.vagas?.plano, f.plano);
            conferir(f.chave + '.limitePessoas', depois.vagas?.limite, LIMITE_PESSOAS[f.plano]);
        }
        // Campanha: exatamente três confirmações a mais, todas das fixtures (vagas de terceiros comparadas por hash em S3).
        r.campanhaConfirmada = await campanha(db); salvar();
        conferir('campanha.ocupadas', r.campanhaConfirmada.ocupadas, r.campanhaAntes.ocupadas + PAGANTES.length);
        conferir('campanha.confirmadas', r.campanhaConfirmada.confirmadas, r.campanhaAntes.confirmadas + PAGANTES.length);

        // ---- Matriz do financeiro (O4).
        marcar('MATRIZ_FINANCEIRO');
        for (const f of FIXTURES) {
            const e = FINANCEIRO[f.chave], x = s[f.chave], res = r.resultados[f.chave] = {};
            const categoria = (await db.query("SELECT id::text FROM financeiro_categorias WHERE empresa_id=$1 AND nome='Homologação'", [f.empresa])).rows[0].id;
            res.contasPagar = (await x.pedir('/api/admin/financeiro/contas-pagar')).status; conferir(f.chave + '.contasPagar', res.contasPagar, e.contasPagar);
            const criar = await x.post('/api/admin/financeiro/contas-pagar', {acao:'criar', descricao:'Conta sintética homologação', categoriaId:categoria, valor:10,
                vencimento:new Date(Date.now() + 864e5 * 10).toISOString().slice(0, 10), chave:'hml-' + randomUUID()});
            res.criarConta = criar.status; conferir(f.chave + '.criarConta', res.criarConta, e.criarConta);
            if (e.criarConta === 403) conferir(f.chave + '.codigo', criar.j.codigo, 'RECURSO_FORA_DO_PLANO');
            const contas = (await db.query('SELECT count(*)::int n FROM financeiro_contas_pagar WHERE empresa_id=$1', [f.empresa])).rows[0].n;
            conferir(f.chave + '.contasGravadas', contas, e.criarConta === 200 ? 1 : 0);
            res.fluxo = (await x.pedir('/api/admin/financeiro/fluxo-caixa?' + proximoMes())).status; conferir(f.chave + '.fluxo', res.fluxo, e.fluxo);
            res.relatorios = (await x.pedir('/api/admin/financeiro/relatorios?' + proximoMes())).status; conferir(f.chave + '.relatorios', res.relatorios, e.relatorios);
            const visao = await x.pedir('/api/admin/financeiro'); conferir(f.chave + '.visao', visao.j.data?.financeiroCompleto, e.completo);
            const painel = await x.pedir('/api/admin/dashboard'); conferir(f.chave + '.dashboard', painel.j.data?.financeiroCompleto, e.completo);
            res.receber = (await x.pedir('/api/admin/financeiro/contas-receber')).status; conferir(f.chave + '.receber', res.receber, e.receber);
            const auth = await x.pedir('/api/admin/autenticacao'); conferir(f.chave + '.menu', auth.j.data?.recursos?.financeiroCompleto, e.completo);
            salvar();
        }
        const cruzado = await s.F1.pedir('/api/admin/financeiro/contas-pagar?empresaId=' + FIXTURES[1].empresa);
        r.resultados.cruzado = cruzado.status; if (cruzado.status === 200 || JSON.stringify(cruzado.j).includes('Conta sintética')) throw Object.assign(Error('CRUZADO_S2'), {parada:'S2'});

        // ---- Matriz da cotação (O4). Sem sessão; tudo pelo endereço público.
        marcar('MATRIZ_COTACAO');
        const q = c => '?empresa=' + c, F2 = FIXTURES[1], F4 = FIXTURES[3], F5 = FIXTURES[4], c = r.resultados.cotacao = {};
        for (const [nome, caminho, esperado] of [
            ['paginaF2', '/b/' + F2.codigo + '/fechamento', 200], ['agendaPaginaF2', '/b/' + F2.codigo + '/disponibilidade', 200],
            ['paginaPremium', '/b/' + F5.codigo + '/fechamento', 200], ['pacotesPremium', '/api/fechamentos/pacotes' + q(F5.codigo), 200],
            ['pacotesF2', '/api/fechamentos/pacotes' + q(F2.codigo), 200], ['pacotesF4', '/api/fechamentos/pacotes' + q(F4.codigo), 200],
            ['essencial', '/api/fechamentos/pacotes' + q(FIXTURES[0].codigo), 404], ['inexistente', '/api/fechamentos/pacotes' + q('hml-inexistente'), 404],
            ['formatoRuim', '/api/fechamentos/pacotes?empresa=HML_RUIM', 404], ['pdf', '/api/fechamentos/tabela-pacotes' + q(F2.codigo), 404],
            ['paginaEssencial', '/b/' + FIXTURES[0].codigo + '/fechamento', 404]]) {
            const resp = await publico(caminho); c[nome] = resp.status; conferir('cotacao.' + nome, resp.status, esperado);
            if (esperado === 404 && resp.j) conferir('cotacao.' + nome + '.codigo', resp.j.codigo ?? 'PDF', nome === 'pdf' ? 'PDF' : 'COTACAO_PUBLICA_INDISPONIVEL');
        }
        const pacotesF2 = (await publico('/api/fechamentos/pacotes' + q(F2.codigo))).j.pacotes;
        conferir('cotacao.pacotesF2.lista', JSON.stringify(pacotesF2.map(x => x.codigo)), '["POCKET"]');
        const agenda = (await publico('/api/disponibilidade?' + proximoMes() + '&empresa=' + F2.codigo)).j;
        conferir('cotacao.agenda.comercial', JSON.stringify(agenda.comercial), '{"pacoteOverrides":[],"descontos":[]}');
        let horario = null;
        for (const dia of agenda.data) for (const per of dia.periodos ?? []) for (const h of per.horarios ?? [])
            if (!horario && h.status === 'DISPONIVEL' && h.ajusteMinutos === 0) horario = {data:dia.data, base:per.codigo === 'TURNO_1' ? 'almoco' : 'noite', inicio:h.inicio, fim:h.fim};
        assert.ok(horario, 'SEM_HORARIO_DISPONIVEL');
        const cotacao = await publico('/api/fechamentos/cotacao' + q(F2.codigo), 'POST', {pacote:'pocket', dataFesta:horario.data, horarioBase:horario.base, ajusteHorario:'0',
            horarioInicio:horario.inicio, horarioFim:horario.fim, convidados:20});
        conferir('cotacao.valor', cotacao.status, 200);
        // Preço conferido de forma independente (faixa da fixture em centavos), sem usar o cálculo do sistema.
        conferir('preco.cotacao.tabela', Math.round(Number(cotacao.j.data.valorTabela) * 100), precoEsperado(0));
        conferir('preco.cotacao.aplicado', Math.round(Number(cotacao.j.data.valor) * 100), precoEsperado(0));
        const cpf = cpfSintetico();
        const pedido = (codigo, extra = {}) => publico('/api/fechamentos' + q(codigo), 'POST', {identidadeTipo:'NOVO_CLIENTE', dataFesta:horario.data, horarioBase:horario.base,
            ajusteHorario:'0', horarioInicio:horario.inicio, horarioFim:horario.fim, statusDisponibilidade:'disponivel', pacote:'pocket', convidadosPagantes:20,
            buffetDefinicao:'depois', adicionaisSelecionados:[], valorCombinado:String(cotacao.j.data.valor), formaPagamento:'pix_avista',
            nomeCliente:'Cliente Sintético Homologação', cpf, email:'cliente-hml-' + randomBytes(4).toString('hex') + '@example.invalid', whatsapp:'11900000000',
            cep:'01001000', logradouro:'Rua Sintética', numero:'1', bairro:'Centro', cidade:'São Paulo', uf:'SP',
            nomeAniversariante:'Aniversariante Sintético', idadeAniversariante:5, observacoesCliente:'Pedido sintético de homologação 20261010', ...extra});
        const p1 = await pedido(F2.codigo); c.pedidoF2 = p1.status; conferir('cotacao.pedidoF2', p1.status, 201);
        conferir('cotacao.pedidoF2.semCrm', p1.j.crm, undefined);
        const f1 = (await db.query("SELECT empresa_id::text e, condicao_pagamento->>'descontoPercentual' AS desconto FROM fechamentos WHERE id=$1", [p1.j.fechamentoId])).rows[0];
        conferir('cotacao.pedidoF2.empresa', f1?.e, F2.empresa);
        conferir('cotacao.pedidoF2.regraPagamentoNeutra', f1?.desconto, '0'); // 077: F2 sem linha de regras = sem desconto automático
        const valoresF2 = (await db.query('SELECT valor_tabela::text AS tabela FROM fechamentos WHERE id=$1', [p1.j.fechamentoId])).rows[0];
        conferir('preco.fechamentoF2.tabela', Math.round(Number(valoresF2?.tabela) * 100), precoEsperado(0));
        // Contrato EFETIVAMENTE gerado pelo sistema (sessão administrativa de F2, API real): o valor final gravado na
        // versão é comparado ao esperado independente. F2 não tem regra (077) → 0% → 150000; o legado daria 135000.
        const contratoF2 = await s.F2.post('/api/admin/contratos', {fechamentoId:p1.j.fechamentoId});
        c.contratoF2 = contratoF2.status; conferir('contrato.F2.gerado', contratoF2.status, 201);
        const versaoF2 = (await db.query(`SELECT v.snapshot->'comercial'->>'valorFinalContrato' AS final,
                v.snapshot->'comercial'->>'descontoFormaPagamentoPercentual' AS desconto_forma,
                v.snapshot->'comercial'->'condicaoPagamento'->>'descontoPercentual' AS desconto_gravado
              FROM contrato_versoes v JOIN contratos k ON k.id = v.contrato_id
             WHERE k.fechamento_id = $1 ORDER BY v.numero_versao DESC LIMIT 1`, [p1.j.fechamentoId])).rows[0];
        conferir('preco.contratoF2.valorFinal', Math.round(Number(versaoF2?.final) * 100), precoEsperado(0));
        conferir('preco.contratoF2.descontoForma', Number(versaoF2?.desconto_forma), 0);
        conferir('preco.contratoF2.descontoGravado', versaoF2?.desconto_gravado, '0');
        r.resultados.contrato = {status:contratoF2.status, valorFinalCentavos:Math.round(Number(versaoF2?.final) * 100), esperadoCentavos:precoEsperado(0)}; salvar();
        // Identidade por empresa: o CPF do cliente de F2 é visto só em F2; nem F4 nem o endereço atual (Kidmais) o enxergam.
        const consultaCpf = async codigo => (await publico('/api/identidade/consultar-cpf' + (codigo ? q(codigo) : ''), 'POST', {cpf})).j?.situacao;
        c.identidadeF2 = await consultaCpf(F2.codigo); conferir('identidade.F2', c.identidadeF2, 'CLIENTE_EXISTENTE');
        c.identidadeF4 = await consultaCpf(F4.codigo); conferir('identidade.F4', c.identidadeF4, 'NOVO_CLIENTE');
        c.identidadeKidmais = await consultaCpf(null); conferir('identidade.enderecoAtual', c.identidadeKidmais, 'NOVO_CLIENTE');
        // Mesmo CPF em outra empresa (F4): mesma resposta pública; com a 076, cadastro de F4 com o próprio CPF.
        const p2 = await pedido(F4.codigo); c.pedidoF4MesmoCpf = p2.status; conferir('cotacao.pedidoF4', p2.status, 201);
        conferir('cotacao.pedidoF4.chaves', JSON.stringify(Object.keys(p2.j).sort()), JSON.stringify(Object.keys(p1.j).sort()));
        const cli = (await db.query('SELECT c.empresa_id::text e, c.cpf FROM fechamentos f JOIN clientes c ON c.id=f.cliente_id WHERE f.id=$1', [p2.j.fechamentoId])).rows[0];
        conferir('cotacao.pedidoF4.empresa', cli.e, F4.empresa); conferir('cotacao.pedidoF4.cpfPorEmpresa', cli.cpf, cpf);
        // Regras de desconto diferentes por empresa: gravadas na condição e aplicadas no contrato EFETIVAMENTE gerado.
        //   F2 sem regra → 0% (150000, conferido acima); F4 → 5% (142500); F5 → 8% (138000). Legado da Kidmais = 10% (135000).
        const contratoComRegra = async (chave, fechamentoId) => {
            const regra = REGRAS[chave].pixAvista;
            const cond = (await db.query("SELECT condicao_pagamento->>'descontoPercentual' AS desconto FROM fechamentos WHERE id=$1", [fechamentoId])).rows[0];
            conferir(`cotacao.pedido${chave}.regraPagamento`, cond?.desconto, String(regra));
            const k = await s[chave].post('/api/admin/contratos', {fechamentoId});
            c['contrato' + chave] = k.status; conferir(`contrato.${chave}.gerado`, k.status, 201);
            const v = (await db.query(`SELECT v.snapshot->'comercial'->>'valorFinalContrato' AS final,
                    v.snapshot->'comercial'->>'descontoFormaPagamentoPercentual' AS desconto_forma
                  FROM contrato_versoes v JOIN contratos k ON k.id = v.contrato_id
                 WHERE k.fechamento_id = $1 ORDER BY v.numero_versao DESC LIMIT 1`, [fechamentoId])).rows[0];
            conferir(`preco.contrato${chave}.valorFinal`, Math.round(Number(v?.final) * 100), precoEsperado(regra));
            conferir(`preco.contrato${chave}.descontoForma`, Number(v?.desconto_forma), regra);
            r.resultados['contrato' + chave] = {status:k.status, valorFinalCentavos:Math.round(Number(v?.final) * 100), esperadoCentavos:precoEsperado(regra)}; salvar();
        };
        await contratoComRegra('F4', p2.j.fechamentoId);
        // F5 (Premium pago, regra 8%): pedido próprio pelo endereço da empresa, com CPF novo.
        const p5 = await pedido(F5.codigo, {cpf:cpfSintetico()}); c.pedidoF5 = p5.status; conferir('cotacao.pedidoF5', p5.status, 201);
        conferir('cotacao.pedidoF5.empresa', (await db.query('SELECT empresa_id::text e FROM fechamentos WHERE id=$1', [p5.j.fechamentoId])).rows[0]?.e, F5.empresa);
        await contratoComRegra('F5', p5.j.fechamentoId);
        // Regra legada da Kidmais intacta (a preservação de empresa_regras_pagamento fora das fixtures cobre a linha toda).
        const kidmaisRegra = (await db.query(`SELECT r.pix_avista_percentual = 10 AND r.pix_parcelado_percentual = 3 AND r.cartao_rotulo = 'Cielo' AND r.desconto_dia_util AS ok
            FROM empresa_regras_pagamento r JOIN empresas e ON e.id = r.empresa_id WHERE e.codigo = 'kidmais'`)).rows;
        conferir('regra.kidmaisLegada', kidmaisRegra.length <= 1 && kidmaisRegra.every(x => x.ok === true), true);
        // Cliente existente com prova inválida: recusado antes de gravar (4xx, ou 503 se o OTP estiver desligado em staging).
        const antesF2 = (await db.query('SELECT count(*)::int n FROM fechamentos WHERE empresa_id=$1', [F2.empresa])).rows[0].n;
        const p3 = await pedido(F2.codigo, {identidadeTipo:'CLIENTE_EXISTENTE', provaIdentidade:'p'.repeat(40)});
        c.clienteExistenteProvaInvalida = p3.status; conferir('cotacao.clienteExistente.recusado', p3.status >= 400 && p3.status !== 201, true);
        conferir('cotacao.clienteExistente.semGravacao', (await db.query('SELECT count(*)::int n FROM fechamentos WHERE empresa_id=$1', [F2.empresa])).rows[0].n, antesF2);
        // Cabeçalho da página por empresa: nome próprio, ícone neutro, sem logo da Kidmais no HTML renderizado.
        const html = await fetch(BASE + '/b/' + F2.codigo + '/fechamento', {redirect:'manual', signal:AbortSignal.timeout(60000)}).then(x => x.text());
        conferir('marca.semLogoKidmais', /kidmais-logo-horizontal/.test(html), false);
        conferir('marca.iconeNeutro', html.includes('/icone-orcamento.svg'), true);
        conferir('marca.titulo', /<title>Orçamento da festa<\/title>/.test(html), true);

        // ---- Endereço atual da Kidmais e demais empresas inalterados (S3).
        // ---- Janela de navegador (desktop e celular): fixtures vivas até o sinal ou o prazo. Com a conta aprovada por Felipe,
        // vínculo às empresas pagas (Essencial: bloqueios; Profissional e Premium: liberados), só nas fixtures, revogado no encerramento.
        marcar('NAVEGADOR');
        if (r.navegador) {
            r.navegador.intencao = true; salvar(); // prova antes de criar os vínculos
            for (const f of PAGANTES) {
                await db.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())", [f.empresa, r.navegador.usuarioId]);
                await db.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [f.empresa, r.navegador.usuarioId]);
            }
            r.navegador.vinculos = PAGANTES.map(f => f.chave); salvar();
        }
        r.janela = {abertaEm:new Date().toISOString(), paginas:FIXTURES.filter(f => f.catalogo).map(f => '/b/' + f.codigo + '/fechamento')}; salvar();
        console.log(JSON.stringify({janela:'ABERTA', paginas:r.janela.paginas, contaNavegador:!!r.navegador, sinal:SINAL_NAVEGADOR}));
        r.janela.fechada = await aguardarSinal(SINAL_NAVEGADOR, JANELA_NAVEGADOR_MS); salvar();

        marcar('PRESERVACAO');
        r.kidmaisDepois = await kidmaisPublico();
        conferir('kidmais.pacotes', r.kidmaisDepois.pacotes, r.kidmaisAntes.pacotes); conferir('kidmais.agenda', r.kidmaisDepois.agenda, r.kidmaisAntes.agenda);
        r.depois = await preservacao();
        for (const [tabela] of PRESERVADAS) if (r.depois[tabela] !== r.antes[tabela]) throw Object.assign(Error('PRESERVACAO_S3'), {parada:'S3', tabela});
        r.aprovado = true; salvar();
    } catch (e) {
        // Erro original da rodada: registrado antes do encerramento e preservado como resultado final.
        erro = e ?? Error('FALHA_DESCONHECIDA');
        r.falha = {etapa, parada:e?.parada ?? null, item:e?.item ?? e?.tabela ?? null, http:e?.status ?? null, mensagem:String(e?.message ?? e).slice(0, 120)};
        try { salvar(); } catch { /* o encerramento roda mesmo sem gravar o estado */ }
        console.error(JSON.stringify(r.falha));
    } finally {
        // ---- Encerramento: SEMPRE roda (sucesso, falha ou parada), só sobre recursos comprovados; nunca lança.
        erro = erroFinal(erro, await encerrar({db, conectado, r, p, api, salvar}));
        if (conectado) {
            // Vagas confirmadas são permanentes (074): depois do encerramento a campanha continua com +3; terceiros idênticos.
            r.campanhaDepois = await campanha(db).catch(() => null);
            r.depoisEncerramento = await preservacao().catch(() => null);
            if (r.depoisEncerramento && r.antes && PRESERVADAS.some(([t]) => r.depoisEncerramento[t] !== r.antes[t]))
                erro = erroFinal(erro, Object.assign(Error('PRESERVACAO_APOS_ENCERRAMENTO'), {parada:'S3'}));
        }
        await db.end().catch(() => {});
    }
    r.concluido = !erro; try { salvar(); } catch { /* idem */ }
    console.log(JSON.stringify({resultado:erro ? 'INCOMPLETO' : 'PASS', falha:r.falha ?? null, resultados:r.resultados,
        campanhaAntes:r.campanhaAntes ?? null, campanhaConfirmada:r.campanhaConfirmada ?? null, campanhaDepois:r.campanhaDepois ?? null,
        vagas:Object.fromEntries(PAGANTES.map(f => [f.chave, r[f.chave]?.vagaNumero ?? null])), janela:r.janela ?? null, navegador:r.navegador ? {vinculos:r.navegador.vinculos ?? null} : null,
        prova:r.encerramento?.prova ?? null, fixtures:r.encerramento?.fixtures ?? null, webhook:r.encerramento?.webhook ?? null,
        assinaturasSandbox:FIXTURES.filter(f => f.tipo === 'PLANO').map(f => ({[f.chave]:r.encerramento?.[f.chave] ?? null})),
        falhasEncerramento:r.falhasEncerramento ?? []}));
    if (erro) process.exitCode = 2;
}

// RASCUNHO SUBSTITUÍDO por scripts/homologacao-pagamento-renovacao-staging.cjs (docs/HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md).
// Mantido só como histórico e referência dos testes: nenhuma flag executa.
if (require.main === module && process.argv.slice(2).some(a => a.startsWith('--'))) {
    console.error('RASCUNHO_SUBSTITUIDO'); process.exitCode = 1;
} else if (require.main === module) {
    const m = modo(process.argv.slice(2));
    if (m === 'RODADA') main().catch(() => { console.error('HOMOLOGACAO_RECUSADA_ANTES_DAS_MUTACOES'); process.exitCode = 1; });
    else if (m === 'ENCERRAR') recuperar().catch(e => { console.error(String(e?.message ?? 'RECUPERACAO_RECUSADA').slice(0, 80)); process.exitCode = 1; });
    else { console.error('AGUARDANDO_AUTORIZACAO_PAGAMENTO'); process.exitCode = 1; }
}
module.exports = {FIXTURES, PAGANTES, PRECOS, REGRAS, PRESERVADAS, FINANCEIRO, LIMITE_PESSOAS, MARCA, ARQUIVO, SINAL_NAVEGADOR, VAGAS_CAMPANHA,
    JANELA_NAVEGADOR_MS, cabeNaCampanha, emailDeNavegador, aguardarSinal, sqlPreservacao, alvo, alvoEncerramento, autorizado, modo, processoVivo, encerrar,
    recursosComprovados, erroFinal, conferir, cpfSintetico, projecaoAgenda, precoEsperado, BASE, DIR, FLAG, FLAG_ENCERRAR};
