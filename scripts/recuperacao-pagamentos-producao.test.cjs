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

test('B-23 (B23-F1): o CLI reconhece cada base antiga pelo SHA completo e recusa o desconhecido antes de criar o Client', async () => {
    // Literais, não a lista importada: tirar uma base da lista não pode tirá-la também do teste.
    const BASES = ['00d3019ade199ce609eab296050e07f4b379e87b', '4ef9adb6830f0816f8a2f2ae0c98e16b8357db61', '5bdd5ac47a7f2e8b25892eeadb4e49398e593af1',
        '7329cbfe1bd78fbf817fc418785b7f62910a9b01', '5e4340db485520eabc84f67f090907de7fddac06', 'd67d10e63e43c4f066f06456e72d0df55bfd1949', '767fff4ac3bce2dcc03fa16d01c42dc25d7b563a',
        '0de9aea27715b64bea73cbefb20bfc87bc96deec', '4b9ce8303ddb9b366c839eb61cfa25bad4a4b735', 'cc4bab508dd617dbdbc402f049113a8e99b2239a'];
    // Barreira explícita: o `pg` do processo é trocado por um dublê cujo Client só registra e lança; nada conecta.
    const resolvido = require.resolve('pg');
    const original = require.cache[resolvido];
    const criados = [];
    class BARREIRA extends Error {}
    require.cache[resolvido] = { id: resolvido, filename: resolvido, loaded: true, exports: { Client: class { constructor(c) { criados.push(c.database); throw new BARREIRA(); } } } };
    const saidas = [];
    const log = console.log;
    console.log = (x) => saidas.push(x);
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'b14-'));
    const rodar = async (commit) => {
        const antes = criados.length;
        let codigo = null, barreira = false;
        try {
            // Schema P0a (nenhuma migration além de production): ANTIGO admite JANELA-conferir; CANDIDATA não.
            await main(['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`, '--migracoes=nenhuma', `--candidata=${CAND}`, `--saida=${pasta}`],
                { ASAAS_AMBIENTE: 'sandbox', DATABASE_URL: 'postgresql://u@127.0.0.1:55498/kidmais_desc', KIDMAIS_B14_ALVO: 'kidmais_desc@127.0.0.1:55498',
                    KIDMAIS_B14_DESCARTAVEL: 'kidmais_desc', RENDER_GIT_COMMIT: commit },
                (c) => { codigo = c; }, { cliente: {} });
        }
        catch (e) { if (!(e instanceof BARREIRA)) throw e; barreira = true; }
        return barreira ? { barreira: criados.length - antes } : { codigo, motivo: JSON.parse(saidas.at(-1)).motivo, criados: criados.length - antes };
    };
    try {
        for (const base of BASES) {
            assert.deepEqual(await rodar(base), { barreira: 1 }, `base exata ${base.slice(0, 8)} chega ao Client`);
            assert.deepEqual(await rodar(` ${base.toUpperCase()} `), { barreira: 1 }, 'normalizada como no unitário');
            assert.deepEqual(await rodar(base.slice(0, 8) + '0'.repeat(32)), { codigo: 1, motivo: 'CODIGO_NO_AR_DESCONHECIDO', criados: 0 }, 'mesmo prefixo, sufixo falso');
        }
        assert.deepEqual(await rodar('c'.repeat(40)), { codigo: 1, motivo: 'CODIGO_NO_AR_DESCONHECIDO', criados: 0 }, 'SHA completo desconhecido');
        assert.deepEqual(await rodar(undefined), { codigo: 1, motivo: 'CODIGO_NO_AR_DESCONHECIDO', criados: 0 }, 'sem RENDER_GIT_COMMIT');
        // A candidata exata passa da classificação e cai na matriz (P0a não admite CANDIDATA), também sem Client.
        assert.deepEqual(await rodar(CAND), { codigo: 1, motivo: 'MODO_NAO_ADMITIDO', criados: 0 });
    }
    finally {
        console.log = log;
        if (original) require.cache[resolvido] = original; else delete require.cache[resolvido];
        fs.rmSync(pasta, { recursive: true, force: true });
    }
});

test('B-23c (D-B23c-2): trava dos avisos ligada recusa AVISOS_EMAIL_LIGADOS antes do Client — ANTIGO e CANDIDATA, env e process.env', async () => {
    const resolvido = require.resolve('pg');
    const original = require.cache[resolvido];
    const criados = [];
    class BARREIRA extends Error {}
    require.cache[resolvido] = { id: resolvido, filename: resolvido, loaded: true, exports: { Client: class { constructor(c) { criados.push(c.database); throw new BARREIRA(); } } } };
    const saidas = [];
    const log = console.log;
    console.log = (x) => saidas.push(x);
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'b14-'));
    const antes = process.env.ASSINATURA_AVISOS_EMAIL;
    const ANTIGO = '5e4340db485520eabc84f67f090907de7fddac06';
    const alvo = { ASAAS_AMBIENTE: 'sandbox', DATABASE_URL: 'postgresql://u@127.0.0.1:55498/kidmais_desc', KIDMAIS_B14_ALVO: 'kidmais_desc@127.0.0.1:55498', KIDMAIS_B14_DESCARTAVEL: 'kidmais_desc' };
    // Schema P0a: ANTIGO admite JANELA-conferir e os restore; o schema de `comuns` admite CANDIDATA.
    const ARGS = {
        janela: ['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`],
        drenagem: ['--restore', '--drenagem', `--reinicio=${ISO}`, `--contencao-desde=${ISO}`],
    };
    const rodar = async ({ commit, args = ARGS.janela, migracoes = ['--migracoes=nenhuma', `--candidata=${CAND}`], env = {}, processo }) => {
        const n = criados.length;
        let codigo = null, barreira = false;
        if (processo === undefined) delete process.env.ASSINATURA_AVISOS_EMAIL; else process.env.ASSINATURA_AVISOS_EMAIL = processo;
        try { await main([...args, ...migracoes, `--saida=${pasta}`], { ...alvo, RENDER_GIT_COMMIT: commit, ...env }, (c) => { codigo = c; }, { cliente: {} }); }
        catch (e) { if (!(e instanceof BARREIRA)) throw e; barreira = true; }
        return barreira ? { barreira: criados.length - n } : { codigo, motivo: JSON.parse(saidas.at(-1)).motivo, criados: criados.length - n };
    };
    const RECUSA = { codigo: 1, motivo: 'AVISOS_EMAIL_LIGADOS', criados: 0 };
    try {
        for (const v of ['ligado', 'LIGADO', ' ligado ']) {
            assert.deepEqual(await rodar({ commit: ANTIGO, env: { ASSINATURA_AVISOS_EMAIL: v } }), RECUSA, `ANTIGO, env "${v}"`);
            assert.deepEqual(await rodar({ commit: ANTIGO, processo: v }), RECUSA, `ANTIGO, só process.env "${v}"`);
        }
        assert.deepEqual(await rodar({ commit: ANTIGO, args: ARGS.drenagem, env: { ASSINATURA_AVISOS_EMAIL: 'ligado' } }), RECUSA, 'restore também');
        assert.deepEqual(await rodar({ commit: '00d3019ade199ce609eab296050e07f4b379e87b', processo: 'ligado' }), RECUSA, 'base sem o gancho também: roda esta árvore');
        assert.deepEqual(await rodar({ commit: CAND, migracoes: comuns, env: { ASSINATURA_AVISOS_EMAIL: 'ligado' } }), RECUSA, 'CANDIDATA');
        assert.deepEqual(await rodar({ commit: CAND, migracoes: comuns }), { barreira: 1 }, 'CANDIDATA desligada chega ao Client');
        for (const v of [undefined, '', 'desligado', 'sim', 'true', 'ligada'])
            assert.deepEqual(await rodar({ commit: ANTIGO, env: v === undefined ? {} : { ASSINATURA_AVISOS_EMAIL: v }, processo: v }), { barreira: 1 }, `desligada: ${v}`);
        assert.doesNotMatch(saidas.join('\n'), /ligado/, 'só o código, nunca o valor');
        // A guarda nunca altera a variável.
        process.env.ASSINATURA_AVISOS_EMAIL = 'ligado';
        const env = { ASSINATURA_AVISOS_EMAIL: 'ligado' };
        await rodar({ commit: ANTIGO, env, processo: 'ligado' });
        assert.deepEqual([env.ASSINATURA_AVISOS_EMAIL, process.env.ASSINATURA_AVISOS_EMAIL], ['ligado', 'ligado']);
    }
    finally {
        console.log = log;
        if (antes === undefined) delete process.env.ASSINATURA_AVISOS_EMAIL; else process.env.ASSINATURA_AVISOS_EMAIL = antes;
        if (original) require.cache[resolvido] = original; else delete require.cache[resolvido];
        fs.rmSync(pasta, { recursive: true, force: true });
    }
});

// P2-B23C-COD-R1-01 (Astra, r1): a guarda é exercitada em CADA modo que conecta, com o código e o schema que a matriz
// admite: ANTIGO (P0a, `--migracoes=nenhuma`) nos restores e na janela-conferir; CANDIDATA (`comuns`) em todos, inclusive
// a janela-recuperar, que nunca é admitida ao ANTIGO. Os arquivos (backup, casos, drenagem…) só são lidos depois do Client,
// então os nomes abaixo não precisam existir: com a trava desligada a execução tem de chegar à barreira.
test('B-23c r2/B-23d/B-23e/B-23f: a trava ligada recusa antes do Client em cada modo admitido (5e4340db, d67d10e6, 767fff4a, 0de9aea2, 4b9ce830, cc4bab50 e CANDIDATA; env, process.env e desacordo)', async () => {
    const resolvido = require.resolve('pg');
    const original = require.cache[resolvido];
    const criados = [];
    class BARREIRA extends Error {}
    require.cache[resolvido] = { id: resolvido, filename: resolvido, loaded: true, exports: { Client: class { constructor(c) { criados.push(c.database); throw new BARREIRA(); } } } };
    const saidas = [];
    const log = console.log;
    console.log = (x) => saidas.push(x);
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'b14-'));
    const antes = process.env.ASSINATURA_AVISOS_EMAIL;
    // Literais: as bases cujo código no ar depende da trava (#299 e os recortes do B-23d, do B-23e e do B-23f).
    const ANTIGOS = ['5e4340db485520eabc84f67f090907de7fddac06', 'd67d10e63e43c4f066f06456e72d0df55bfd1949', '767fff4ac3bce2dcc03fa16d01c42dc25d7b563a',
        '0de9aea27715b64bea73cbefb20bfc87bc96deec', '4b9ce8303ddb9b366c839eb61cfa25bad4a4b735', 'cc4bab508dd617dbdbc402f049113a8e99b2239a'];
    const alvo = { ASAAS_AMBIENTE: 'sandbox', DATABASE_URL: 'postgresql://u@127.0.0.1:55498/kidmais_desc', KIDMAIS_B14_ALVO: 'kidmais_desc@127.0.0.1:55498', KIDMAIS_B14_DESCARTAVEL: 'kidmais_desc' };
    const P0A = ['--migracoes=nenhuma', `--candidata=${CAND}`];
    const comAntigos = () => [...ANTIGOS.map((a) => [a, P0A]), [CAND, comuns]];
    const MODOS = {
        'janela-conferir': { args: ['--janela', '--conferir', `--desde=${ISO}`, `--ate=${ISO}`], codigos: comAntigos() },
        'janela-recuperar': { args: ['--janela', '--recuperar', `--desde=${ISO}`, `--ate=${ISO}`, '--backup=backup.json'], codigos: [[CAND, comuns]] },
        'restore-drenagem': { args: ['--restore', '--drenagem', `--reinicio=${ISO}`, `--contencao-desde=${ISO}`], codigos: comAntigos() },
        'restore-inventario': { args: ['--restore', '--inventario', `--desde=${ISO}`, `--reinicio=${ISO}`, '--drenagem=drenagem.json'], codigos: comAntigos() },
        'restore-aplicar': { args: ['--restore', `--aplicar-caso=${'b'.repeat(64)}`, `--proposta=${'a'.repeat(64)}`, '--casos=casos.json', '--backup=backup.json', `--restaurado-em=${ISO}`], codigos: comAntigos() },
        'restore-conferir': { args: ['--restore', `--conferir-caso=${'b'.repeat(64)}`, `--proposta=${'a'.repeat(64)}`, '--casos=casos.json', '--execucao=00000000-0000-4000-8000-000000000000'], codigos: comAntigos() },
        'restore-liberacao': { args: ['--restore', '--liberacao', `--desde=${ISO}`, `--reinicio=${ISO}`, '--drenagem=drenagem.json', '--decisoes=decisoes.json', '--url-webhook=https://exemplo.invalid/api/asaas/webhook'], codigos: comAntigos() },
    };
    const rodar = async (args, migracoes, commit, env, processo) => {
        const n = criados.length;
        let codigo = null, barreira = false;
        if (processo === undefined) delete process.env.ASSINATURA_AVISOS_EMAIL; else process.env.ASSINATURA_AVISOS_EMAIL = processo;
        try { await main([...args, ...migracoes, `--saida=${pasta}`], { ...alvo, RENDER_GIT_COMMIT: commit, ...env }, (c) => { codigo = c; }, { cliente: {} }); }
        catch (e) { if (!(e instanceof BARREIRA)) throw e; barreira = true; }
        return barreira ? { barreira: criados.length - n } : { codigo, motivo: JSON.parse(saidas.at(-1)).motivo, criados: criados.length - n };
    };
    const RECUSA = { codigo: 1, motivo: 'AVISOS_EMAIL_LIGADOS', criados: 0 };
    // [env recebido, process.env]: ligado só num deles, nos dois e em desacordo nos dois sentidos.
    const LIGADA = [[{ ASSINATURA_AVISOS_EMAIL: 'ligado' }, undefined], [{}, 'ligado'], [{ ASSINATURA_AVISOS_EMAIL: 'ligado' }, 'ligado'],
        [{ ASSINATURA_AVISOS_EMAIL: 'ligado' }, 'desligado'], [{ ASSINATURA_AVISOS_EMAIL: 'desligado' }, 'ligado']];
    let cenarios = 0;
    try {
        for (const [modo, { args, codigos }] of Object.entries(MODOS))
            for (const [commit, migracoes] of codigos) {
                const rotulo = `${modo} ${commit === CAND ? 'CANDIDATA' : `ANTIGO ${commit.slice(0, 8)}`}`;
                for (const [env, processo] of LIGADA) {
                    assert.deepEqual(await rodar(args, migracoes, commit, env, processo), RECUSA, `${rotulo}, env=${env.ASSINATURA_AVISOS_EMAIL} process=${processo}`);
                    cenarios++;
                }
                assert.deepEqual(await rodar(args, migracoes, commit, { ASSINATURA_AVISOS_EMAIL: 'desligado' }, 'desligado'), { barreira: 1 }, `${rotulo}, desligada chega ao Client`);
                assert.deepEqual(await rodar(args, migracoes, commit, {}, undefined), { barreira: 1 }, `${rotulo}, ausente chega ao Client`);
                cenarios += 2;
            }
        // A janela-recuperar nunca é admitida ao ANTIGO: a recusa é da matriz, antes da guarda (e também sem Client).
        for (const antigo of ANTIGOS)
            assert.deepEqual(await rodar(MODOS['janela-recuperar'].args, P0A, antigo, {}, 'ligado'), { codigo: 1, motivo: 'MODO_NAO_ADMITIDO', criados: 0 }, antigo);
        assert.equal(cenarios, (6 * 7 + 1) * 7, 'todos os modos que conectam, com cada código admitido (6 bases antigas + candidata)');
        assert.doesNotMatch(saidas.join('\n'), /ligado/, 'só o código, nunca o valor');
    }
    finally {
        console.log = log;
        if (antes === undefined) delete process.env.ASSINATURA_AVISOS_EMAIL; else process.env.ASSINATURA_AVISOS_EMAIL = antes;
        if (original) require.cache[resolvido] = original; else delete require.cache[resolvido];
        fs.rmSync(pasta, { recursive: true, force: true });
    }
});

test('B-23c (D-B23c-2): a fila não é afetada pela trava', async () => {
    const fonte = fs.readFileSync(path.join(__dirname, 'recuperacao-pagamentos-producao.cjs'), 'utf8');
    const fila = fonte.indexOf("if (a.modo === 'fila') return terminar(");
    const guarda = fonte.indexOf("motivo: 'AVISOS_EMAIL_LIGADOS'");
    const cliente = fonte.indexOf("new Client({ ...alvo.conexao");
    assert.ok(fila > 0 && guarda > fila && cliente > guarda, 'fila sai antes da guarda; a guarda vem antes do Client');
});
