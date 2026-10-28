/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { argumentos, validarAlvo, sanitizar, arquivosEm, Recusa, STAGING, TRAVA, NOME_APLICACAO, PRAZO_TOTAL_MS, main } = require('./recuperacao-pagamentos-producao.cjs');
const { PRODUCAO } = require('./assinatura-reconciliar.cjs');

/** B-14 (plano rev. 8.1, §3.2, §3.8–§3.10): entrada da recuperação, sem banco nem rede. */
const SHA = 'a'.repeat(64), CAND = 'b'.repeat(40), ISO = '2026-10-28T10:00:00Z', UUID = '11111111-1111-4111-8111-111111111111';
const comuns = [`--migracoes=089,092,093,099,090,094,095,096,097,100`, `--candidata=${CAND}`];
const recusa = (fn, codigo) => assert.throws(fn, (e) => e instanceof Recusa && e.codigo === codigo, codigo);

test('modos e opções (§3.2): lista fechada por modo', () => {
    assert.equal(argumentos(['--fila', '--url-webhook=https://x.example/w']).modo, 'fila');
    assert.equal(argumentos(['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`, ...comuns]).modo, 'janela-conferir');
    assert.equal(argumentos(['--janela', '--recuperar', `--desde=${ISO}`, `--ate=${ISO}`, '--backup=export.json', ...comuns]).modo, 'janela-recuperar');
    assert.equal(argumentos(['--restore', '--drenagem', `--reinicio=${ISO}`, '--contencao-desde=2026-10-28T09:00:00Z', ...comuns]).modo, 'restore-drenagem');
    assert.equal(argumentos(['--restore', '--inventario', `--desde=${ISO}`, `--reinicio=${ISO}`, '--drenagem=drenagem-1.json', ...comuns]).modo, 'restore-inventario');
    assert.equal(argumentos(['--restore', `--aplicar-caso=${SHA}`, `--proposta=${SHA}`, '--casos=casos-1.json', '--backup=export.json', `--restaurado-em=${ISO}`, ...comuns]).modo, 'restore-aplicar');
    assert.equal(argumentos(['--restore', `--conferir-caso=${SHA}`, `--proposta=${SHA}`, '--casos=casos-1.json', `--execucao=${UUID}`, ...comuns]).modo, 'restore-conferir');
    assert.equal(argumentos(['--restore', '--liberacao', `--desde=${ISO}`, `--reinicio=${ISO}`, '--drenagem=d.json', '--decisoes=dec.json', '--url-webhook=https://x.example/w', ...comuns]).modo, 'restore-liberacao');
    const a = argumentos(['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`, ...comuns]);
    assert.deepEqual(a.migracoes, ['089', '090', '092', '093', '094', '095', '096', '097', '099', '100']);
    assert.deepEqual(argumentos(['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`, '--migracoes=nenhuma', `--candidata=${CAND}`]).migracoes, []);
});

test('recusas de argumento (código 1): desconhecido, repetido, sem obrigatória, não admitida, inválida, combinação', () => {
    recusa(() => argumentos([]), 'MODO_INVALIDO');
    recusa(() => argumentos(['--janela']), 'MODO_INVALIDO');
    recusa(() => argumentos(['--janela', '--conferir', '--recuperar']), 'MODO_INVALIDO');
    recusa(() => argumentos(['--fila', '--fila']), 'ARGUMENTO_INVALIDO');
    recusa(() => argumentos(['--aplicar']), 'ARGUMENTO_INVALIDO');
    recusa(() => argumentos(['fila']), 'ARGUMENTO_INVALIDO');
    recusa(() => argumentos(['--fila']), 'OPCAO_OBRIGATORIA:URL_WEBHOOK');
    recusa(() => argumentos(['--fila', '--url-webhook=http://x.example/w']), 'OPCAO_INVALIDA:URL_WEBHOOK');
    recusa(() => argumentos(['--fila', '--url-webhook=https://x.example/w', `--desde=${ISO}`]), 'OPCAO_NAO_ADMITIDA:DESDE');
    // Incremento 4, rodada 1: a drenagem registra o início da contenção (P2-8); o conferir-caso exige a execução da aplicação (P2-3).
    recusa(() => argumentos(['--restore', '--drenagem', `--reinicio=${ISO}`, ...comuns]), 'OPCAO_OBRIGATORIA:CONTENCAO_DESDE');
    recusa(() => argumentos(['--restore', `--conferir-caso=${SHA}`, `--proposta=${SHA}`, '--casos=c.json', ...comuns]), 'OPCAO_OBRIGATORIA:EXECUCAO');
    recusa(() => argumentos(['--restore', `--conferir-caso=${SHA}`, `--proposta=${SHA}`, '--casos=c.json', '--execucao=abc', ...comuns]), 'OPCAO_INVALIDA:EXECUCAO');
    recusa(() => argumentos(['--janela', '--recuperar', `--desde=${ISO}`, `--ate=${ISO}`, ...comuns]), 'OPCAO_OBRIGATORIA:BACKUP');
    recusa(() => argumentos(['--janela', '--conferir', '--desde=2026-10-28', `--ate=${ISO}`, ...comuns]), 'OPCAO_INVALIDA:DESDE');
    recusa(() => argumentos(['--janela', '--conferir', `--desde=${ISO}`, '--ate=2026-10-27T10:00:00Z', ...comuns]), 'JANELA_INVERTIDA');
    recusa(() => argumentos(['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`, '--base=b.json', ...comuns]), 'BASE_INVALIDA');
    recusa(() => argumentos(['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`, '--base=b.json', `--base-sha=${SHA}`, '--selar-base=c.json', ...comuns]), 'BASE_INVALIDA');
    // Arquivos: só nomes simples dentro da pasta de evidências.
    recusa(() => argumentos(['--restore', `--conferir-caso=${SHA}`, `--proposta=${SHA}`, '--casos=../x.json', `--execucao=${UUID}`, ...comuns]), 'OPCAO_INVALIDA:CASOS');
    recusa(() => argumentos(['--restore', `--conferir-caso=${SHA}`, `--proposta=${SHA}`, '--casos=/etc/x', `--execucao=${UUID}`, ...comuns]), 'OPCAO_INVALIDA:CASOS');
    recusa(() => argumentos(['--restore', `--conferir-caso=${SHA}`, '--proposta=abc', '--casos=c.json', `--execucao=${UUID}`, ...comuns]), 'OPCAO_INVALIDA:PROPOSTA');
    recusa(() => argumentos(['--restore', `--aplicar-caso=${SHA}`, `--conferir-caso=${SHA}`, `--proposta=${SHA}`, '--casos=c.json', '--backup=b.json', `--restaurado-em=${ISO}`, ...comuns]), 'OPCAO_NAO_ADMITIDA:CONFERIR_CASO');
    recusa(() => argumentos(['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`, '--migracoes=89', `--candidata=${CAND}`]), 'OPCAO_INVALIDA:MIGRACOES');
    recusa(() => argumentos(['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`, ...comuns, `--desde=${ISO}`]), 'OPCAO_INVALIDA:DESDE');
});

const env = (extra) => ({ DATABASE_URL: `postgresql://u:segredo@${PRODUCAO.host}:5432/${PRODUCAO.database}?sslmode=require`, KIDMAIS_B14_ALVO: `${PRODUCAO.database}@${PRODUCAO.host}:5432`,
    RENDER: 'true', KIDMAIS_DEPLOY_ENV: 'production', ASAAS_AMBIENTE: 'producao', DATABASE_SSL: 'true', ...extra });

test('alvo (D-B14-1): DATABASE_URL do serviço confirmada; production/staging exatos; local só o descartável; TLS', () => {
    const p = validarAlvo(env());
    assert.deepEqual([p.database, p.ambiente, p.local, p.conexao.ssl.rejectUnauthorized], [PRODUCAO.database, 'producao', false, true]);
    // P1 (revisão do incremento 5): a conexão é montada por campos validados; os parâmetros EFETIVOS do pg são o alvo.
    assert.equal(p.conexao.connectionString, undefined);
    const { Client } = require('pg');
    const efetivo = new Client(p.conexao).connectionParameters;
    assert.deepEqual([efetivo.host, efetivo.port, efetivo.database, efetivo.user, efetivo.password], [PRODUCAO.host, 5432, PRODUCAO.database, 'u', 'segredo']);
    // Query que o pg releria (host, port, options…) recusa antes de conectar; só sslmode é admitido.
    for (const q of ['host=other.invalid&port=5433', 'host=other.invalid', 'port=5433', 'options=-c%20search_path%3Dx', 'sslmode=require&host=x'])
        recusa(() => validarAlvo(env({ DATABASE_URL: `postgresql://u:segredo@${PRODUCAO.host}:5432/${PRODUCAO.database}?${q}` })), 'ALVO_COM_PARAMETRO_NA_URL');
    recusa(() => validarAlvo(env({ KIDMAIS_B14_ALVO: 'outro@h:5432' })), 'ALVO_NAO_CONFIRMADO');
    // P2-R1-1 (revisão da rodada 1): o pg completaria campo vazio com PG* do ambiente — prova do vetor e recusa.
    const herdado = (() => { const antes = { ...process.env }; Object.assign(process.env, { PGUSER: 'outro', PGOPTIONS: '-c search_path=outro,public' });
        try { return new Client({ ...p.conexao, user: '', options: '' }).connectionParameters; } finally { for (const k of ['PGUSER', 'PGOPTIONS']) if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; } })();
    assert.deepEqual([herdado.user, herdado.options], ['outro', '-c search_path=outro,public'], 'vetor: o pg herda PG* em campo vazio');
    for (const k of ['PGUSER', 'PGPASSWORD', 'PGOPTIONS', 'PGPORT', 'PGHOST', 'PGSSLMODE', 'PGAPPNAME', 'NODE_PG_FORCE_NATIVE'])
        recusa(() => validarAlvo(env({ [k]: k === 'PGOPTIONS' ? '' : 'x' })), 'AMBIENTE_COM_VARIAVEL_PG');
    recusa(() => validarAlvo(env({ DATABASE_URL: `postgresql://${PRODUCAO.host}:5432/${PRODUCAO.database}` })), 'ALVO_SEM_CREDENCIAL');
    recusa(() => validarAlvo(env({ DATABASE_URL: `postgresql://u@${PRODUCAO.host}:5432/${PRODUCAO.database}` })), 'ALVO_SEM_CREDENCIAL');
    recusa(() => validarAlvo(env({ DATABASE_URL: `postgresql://:segredo@${PRODUCAO.host}:5432/${PRODUCAO.database}` })), 'ALVO_SEM_CREDENCIAL');
    // P2-R1-2: porta 0 cairia em PGPORT/5432 — recusa antes da confirmação do alvo.
    recusa(() => validarAlvo({ DATABASE_URL: 'postgresql://u@127.0.0.1:0/kidmais_desc', KIDMAIS_B14_ALVO: 'kidmais_desc@127.0.0.1:0', KIDMAIS_B14_DESCARTAVEL: 'kidmais_desc', ASAAS_AMBIENTE: 'sandbox' }), 'ALVO_INVALIDO');
    // Local descartável: usuário obrigatório, senha opcional (trust); porta efetiva = a validada.
    const loc = validarAlvo({ DATABASE_URL: 'postgresql://u@127.0.0.1:55498/kidmais_desc', KIDMAIS_B14_ALVO: 'kidmais_desc@127.0.0.1:55498', KIDMAIS_B14_DESCARTAVEL: 'kidmais_desc', ASAAS_AMBIENTE: 'sandbox' });
    assert.equal(new Client(loc.conexao).connectionParameters.port, 55498);
    recusa(() => validarAlvo({ DATABASE_URL: 'postgresql://127.0.0.1:55498/kidmais_desc', KIDMAIS_B14_ALVO: 'kidmais_desc@127.0.0.1:55498', KIDMAIS_B14_DESCARTAVEL: 'kidmais_desc', ASAAS_AMBIENTE: 'sandbox' }), 'ALVO_SEM_CREDENCIAL');
    recusa(() => validarAlvo(env({ KIDMAIS_DEPLOY_ENV: 'staging' })), 'ALVO_PRODUCAO_FORA_DO_SERVICO');
    recusa(() => validarAlvo(env({ RENDER: undefined })), 'ALVO_PRODUCAO_FORA_DO_SERVICO');
    recusa(() => validarAlvo(env({ ASAAS_AMBIENTE: 'sandbox' })), 'ALVO_PRODUCAO_FORA_DO_SERVICO');
    recusa(() => validarAlvo(env({ DATABASE_SSL: undefined })), 'TLS_RECUSADO');
    recusa(() => validarAlvo(env({ DATABASE_URL: undefined })), 'ALVO_SEM_URL');
    const s = validarAlvo({ DATABASE_URL: `postgresql://u:p@${STAGING.host}/${STAGING.database}`, KIDMAIS_B14_ALVO: `${STAGING.database}@${STAGING.host}:5432`, RENDER: 'true',
        KIDMAIS_DEPLOY_ENV: 'staging', ASAAS_AMBIENTE: 'sandbox', DATABASE_SSL: 'true' });
    assert.equal(s.ambiente, 'sandbox');
    const local = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:55498/kidmais_b14_descartavel', KIDMAIS_B14_ALVO: 'kidmais_b14_descartavel@127.0.0.1:55498',
        KIDMAIS_B14_DESCARTAVEL: 'kidmais_b14_descartavel', ASAAS_AMBIENTE: 'sandbox' };
    assert.deepEqual([validarAlvo(local).local, validarAlvo(local).conexao.ssl], [true, false]);
    recusa(() => validarAlvo({ ...local, KIDMAIS_B14_DESCARTAVEL: undefined }), 'ALVO_RECUSADO');
    recusa(() => validarAlvo({ ...local, DATABASE_URL: 'postgresql://u:p@127.0.0.1:55498/kidmais_manager', KIDMAIS_B14_ALVO: 'kidmais_manager@127.0.0.1:55498', KIDMAIS_B14_DESCARTAVEL: 'kidmais_manager' }), 'ALVO_RECUSADO');
    recusa(() => validarAlvo({ ...env(), DATABASE_URL: 'postgresql://u:p@outro.example/kidmais_production', KIDMAIS_B14_ALVO: 'kidmais_production@outro.example:5432' }), 'ALVO_RECUSADO');
    // A mensagem nunca traz a URL nem a senha.
    try { validarAlvo(env({ KIDMAIS_B14_ALVO: 'x' })); } catch (e) { assert.equal(String(e.message).includes('segredo'), false); }
});

test('saída (D-B14-3): lista estrita — códigos, ids opacos, uuid, datas, prefixos e arquivos da ferramenta', () => {
    const r = sanitizar({ codigo: 2, ok: true, identidade: SHA, quando: '2026-10-28T10:00:00.000Z', motivo: 'SERVICO:X_Y', nome: 'Buffet da Ana', 'chave com espaço': 1,
        lista: ['A', 'b c', null, 3, 'palavra', 'P9', `casos-${UUID}.json`, UUID, '2026-10-28T10:00:00.123456Z'], fn: () => 1 });
    assert.deepEqual(r, { codigo: 2, ok: true, identidade: SHA, quando: '2026-10-28T10:00:00.000Z', motivo: 'SERVICO:X_Y', nome: 'OUTRO', OUTRO: 1, lista: ['A', 'OUTRO', null, 3, 'OUTRO', 'P9', `casos-${UUID}.json`, UUID, '2026-10-28T10:00:00.123456Z'], fn: null });
});

test('arquivos restritos: pasta própria, nunca sobrescritos, só nomes simples, invalidação por renomeação', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'b14-'));
    try {
        const a = arquivosEm(path.join(pasta, 'b14'));
        a.gravarNovo('casos-1.json', { x: 1 });
        assert.deepEqual(a.ler('casos-1.json'), { x: 1 });
        assert.throws(() => a.gravarNovo('casos-1.json', { x: 2 }), /EEXIST/);
        assert.deepEqual(a.ler('casos-1.json'), { x: 1 });
        assert.equal(a.ler('nao-existe.json'), null);
        recusa(() => a.ler('../fora.json'), 'ARQUIVO_INVALIDO');
        recusa(() => a.gravarNovo('sub/x.json', {}), 'ARQUIVO_INVALIDO');
        a.gravarNovo('liberacao-1.json', {});
        assert.deepEqual(a.listar('liberacao-'), ['liberacao-1.json']);
        a.invalidar('liberacao-1.json');
        assert.deepEqual(a.listar('liberacao-'), []);
        if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(pasta, 'b14', 'casos-1.json')).mode & 0o777, 0o600);
    }
    finally { fs.rmSync(pasta, { recursive: true, force: true }); }
});

test('constantes: trava só do B-14, nome da sessão, prazo de 15 min', () => {
    assert.deepEqual(TRAVA, [1414, 1027]);
    assert.equal(NOME_APLICACAO, 'kidmais-recuperacao-b14');
    assert.equal(PRAZO_TOTAL_MS, 15 * 60 * 1000);
    // O cron de conferência não usa a trava do B-14 (D-B14-4).
    assert.equal(fs.readFileSync(path.join(__dirname, 'assinatura-reconciliar.cjs'), 'utf8').includes('advisory'), false);
});

test('main: argumento inválido ou Asaas desligado → código 1, sem conexão e sem segredo na saída', async () => {
    const saidas = [];
    const log = console.log;
    console.log = (s) => saidas.push(s);
    try {
        let codigo = null;
        await main(['--aplicar'], {}, (c) => { codigo = c; });
        assert.equal(codigo, 1);
        assert.equal(JSON.parse(saidas.at(-1)).motivo, 'ARGUMENTO_INVALIDO');
        const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'b14-'));
        try {
            await main(['--fila', '--url-webhook=https://x.example/w', `--saida=${pasta}`], { ASAAS_AMBIENTE: 'producao', DATABASE_URL: 'postgresql://u:segredo@h/db' }, (c) => { codigo = c; });
            assert.equal(codigo, 1);
            assert.equal(JSON.parse(saidas.at(-1)).motivo, 'ASAAS_DESLIGADO');
            assert.equal(saidas.join('').includes('segredo'), false);
            assert.equal(fs.readdirSync(pasta).filter((n) => n.startsWith('execucao-')).length, 1, 'a execução fica registrada');
        }
        finally { fs.rmSync(pasta, { recursive: true, force: true }); }
    }
    finally { console.log = log; }
});

test('P2-R2-1: SIGTERM ou prazo que chegam DURANTE a consulta da trava não viram "continuar"', async () => {
    const { criarControle } = require('./recuperacao-pagamentos-producao.cjs');
    const cliente = (aoConsultar, ok = true) => ({ query: async () => { aoConsultar(); return { rows: [{ ok }] }; } });
    let sig = false;
    assert.equal(await criarControle({ client: cliente(() => { sig = true; }), sinal: () => sig, inicio: 0, agora: () => 1 }).parar(), 'SIGTERM');
    let t = 0;
    assert.equal(await criarControle({ client: cliente(() => { t = 16 * 60 * 1000; }), sinal: () => false, inicio: 0, agora: () => t }).parar(), 'LIMITE_EXECUCAO');
    assert.equal(await criarControle({ client: cliente(() => undefined, false), sinal: () => false, inicio: 0, agora: () => 1 }).parar(), 'TRAVA_PERDIDA');
    assert.equal(await criarControle({ client: { query: async () => { throw new Error('rede'); } }, sinal: () => false, inicio: 0, agora: () => 1 }).parar(), 'TRAVA_PERDIDA');
    assert.equal(await criarControle({ client: cliente(() => undefined), sinal: () => false, inicio: 0, agora: () => 1 }).parar(), null);

    // O cenário reproduzido pelo Astra: sinal durante a ÚLTIMA consulta de trava da drenagem → sem PASS, sem arquivo.
    const modos = await import('../lib/assinatura/recuperacao-modos.ts');
    let sinal = false, consultas = 0;
    const client = { query: async (sql) => {
        if (sql.includes('pg_locks')) { if (++consultas === 3) sinal = true; return { rows: [{ ok: true }] }; }
        return { rows: [{ n: '0' }] };
    } };
    const gravados = [];
    const arquivos = { ler: () => null, gravarNovo: (n) => gravados.push(n), invalidar: () => undefined, listar: () => [] };
    const r = await modos.modoDrenagem({ client, cliente: {}, execucao: 'e', ambiente: 'sandbox', creditos: null, arquivos, migracoes: [], codigoNoAr: 'CANDIDATA',
        controle: criarControle({ client, sinal: () => sinal, inicio: 0, agora: () => 1 }) },
    { reinicio: '2026-10-28T10:00:00.000Z', contencaoDesde: '2026-10-28T09:00:00.000Z', amostras: 2, intervaloMs: 0, esperar: async () => undefined });
    assert.deepEqual([r.codigo, r.resultado, gravados], [1, 'INTERROMPIDA', []]);
});

test('P2-R3-1: com o prazo já vencido, a trava ainda é consultada — trava perdida é 1, nunca 3', async () => {
    const { criarControle } = require('./recuperacao-pagamentos-producao.cjs');
    let consultas = 0;
    const semTrava = { query: async () => { consultas++; return { rows: [{ ok: false }] }; } };
    const vencido = { sinal: () => false, inicio: 0, agora: () => 16 * 60 * 1000 };
    // Prazo vencido ANTES da chamada + trava ausente → TRAVA_PERDIDA (com a consulta feita).
    assert.equal(await criarControle({ client: semTrava, ...vencido }).parar(), 'TRAVA_PERDIDA');
    assert.equal(consultas, 1);
    // Prazo vencido + consulta rejeitada → TRAVA_PERDIDA.
    assert.equal(await criarControle({ client: { query: async () => { throw new Error('rede'); } }, ...vencido }).parar(), 'TRAVA_PERDIDA');
    // Prazo vencido + trava ok → LIMITE_EXECUCAO (3).
    assert.equal(await criarControle({ client: { query: async () => ({ rows: [{ ok: true }] }) }, ...vencido }).parar(), 'LIMITE_EXECUCAO');
    // SIGTERM continua imediato, sem consulta.
    let c2 = 0;
    assert.equal(await criarControle({ client: { query: async () => { c2++; return { rows: [{ ok: false }] }; } }, ...vencido, sinal: () => true }).parar(), 'SIGTERM');
    assert.equal(c2, 0);
});

test('P2-R4-1: consulta da trava sem resposta não prende a parada — SIGTERM ou limite no processo, conexão descartada, código 1', async () => {
    const { criarControle, LIMITE_CONSULTA_TRAVA_MS } = require('./recuperacao-pagamentos-producao.cjs');
    const modos = await import('../lib/assinatura/recuperacao-modos.ts');
    assert.equal(LIMITE_CONSULTA_TRAVA_MS, 10_000);
    const presa = { query: () => new Promise(() => undefined) };
    // O cenário do Astra: prazo vencido, consulta pendente, SIGTERM durante a espera → SIGTERM sem a resposta chegar.
    let sig = false, descartes = 0;
    const c1 = criarControle({ client: presa, sinal: () => sig, inicio: 0, agora: () => 16 * 60 * 1000, intervaloMs: 5, limiteConsultaMs: 60_000, descartar: () => { descartes++; } });
    const p1 = c1.parar();
    setTimeout(() => { sig = true; }, 20);
    const t0 = Date.now();
    assert.equal(await p1, 'SIGTERM');
    assert.ok(Date.now() - t0 < 2_000, 'não esperou a resposta');
    assert.deepEqual([descartes, c1.descartada()], [1, 'SIGTERM']);
    // Depois do descarte, nenhuma nova consulta: a parada é a mesma.
    assert.equal(await c1.parar(), 'SIGTERM');
    // Sem sinal: o limite no processo vence → TRAVA_SEM_RESPOSTA, conexão descartada; é recusa técnica (1), não cobertura.
    let d2 = 0;
    const c2 = criarControle({ client: presa, sinal: () => false, inicio: 0, agora: () => 1, intervaloMs: 5, limiteConsultaMs: 30, descartar: () => { d2++; } });
    assert.equal(await c2.parar(), 'TRAVA_SEM_RESPOSTA');
    assert.deepEqual([d2, c2.descartada()], [1, 'TRAVA_SEM_RESPOSTA']);
    assert.equal(modos.PARADAS_DE_COBERTURA.has('TRAVA_SEM_RESPOSTA'), false);
    // Resposta normal dentro do limite: sem descarte.
    let d3 = 0;
    const c3 = criarControle({ client: { query: async () => ({ rows: [{ ok: true }] }) }, sinal: () => false, inicio: 0, agora: () => 1, intervaloMs: 5, limiteConsultaMs: 1_000, descartar: () => { d3++; } });
    assert.deepEqual([await c3.parar(), d3, c3.descartada()], [null, 0, null]);
});

test('P2-R1-1: PG* no process.env (o que o pg de fato lê) recusa antes de criar o Client, mesmo com o env recebido limpo', async () => {
    const saidas = [];
    const log = console.log;
    console.log = (x) => saidas.push(x);
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'b14-'));
    const antes = process.env.PGOPTIONS;
    process.env.PGOPTIONS = '-c search_path=outro,public';
    try {
        let codigo = null;
        await main(['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`, ...comuns, `--saida=${pasta}`],
            { ASAAS_AMBIENTE: 'sandbox', DATABASE_URL: 'postgresql://u@127.0.0.1:55498/kidmais_desc', KIDMAIS_B14_ALVO: 'kidmais_desc@127.0.0.1:55498', KIDMAIS_B14_DESCARTAVEL: 'kidmais_desc' },
            (c) => { codigo = c; }, { cliente: {} });
        assert.equal(codigo, 1);
        assert.equal(JSON.parse(saidas.at(-1)).motivo, 'AMBIENTE_COM_VARIAVEL_PG');
        assert.doesNotMatch(saidas.join('\n'), /search_path|outro/, 'só o código, nunca o valor');
    }
    finally {
        console.log = log;
        if (antes === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = antes;
        fs.rmSync(pasta, { recursive: true, force: true });
    }
});
