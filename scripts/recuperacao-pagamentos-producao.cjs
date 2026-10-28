/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * B-14 — recuperação persistente de pagamentos (plano rev. 8.1; docs/PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md).
 * Roda no Shell do web (D-B14-1), a partir da árvore entregue (ENTREGA-B14), nunca do checkout implantado.
 *
 *   --fila --url-webhook=<https://…>                                          estado da fila do webhook (não conecta ao banco)
 *   --janela --conferir --desde=<ISO> --ate=<ISO> [--base=<arq> --base-sha=<sha> | --selar-base=<arq>]   DML revertido por caso
 *   --janela --recuperar --desde=<ISO> --ate=<ISO> --backup=<arq>             COMMIT por caso (regras da candidata)
 *   --restore --drenagem --reinicio=<ISO> --contencao-desde=<ISO>             prova de drenagem depois do reinício (§5) e início da manutenção
 *   --restore --inventario --desde=<ISO> --reinicio=<ISO> --drenagem=<arq>    casos + arquivo restrito (nada gravado)
 *   --restore --aplicar-caso=<id> --proposta=<hash> --casos=<arq> --backup=<arq> --restaurado-em=<ISO>
 *   --restore --conferir-caso=<id> --proposta=<hash> --casos=<arq> --execucao=<uuid da aplicação>   depois de COMMIT sem resposta
 *   --restore --liberacao --desde=<ISO> --reinicio=<ISO> --drenagem=<arq> --decisoes=<arq> --url-webhook=<…> [--prova-cron=<arq>]
 * Comuns (todos menos --fila): --migracoes=<089,092,…> (CONFERIR do B-5) e --candidata=<sha40>. [--saida=<pasta>]
 *
 * Alvo: a DATABASE_URL do próprio serviço por exceção desta entrada (D-B14-1), confirmada pelo literal
 * KIDMAIS_B14_ALVO="<banco>@<host>:<porta>", por current_database() e por TLS (pg_stat_ssl). Só production, staging
 * (homologação) ou o cluster descartável local (KIDMAIS_B14_DESCARTAVEL=<banco>). A URL nunca é impressa.
 * Trava global de sessão só entre execuções do B-14 (D-B14-4). SIGTERM, trava perdida e COMMIT sem resposta → 1; prazo
 * total de 15 min → 3. Códigos pela tabela única (§3.10). Stdout só com ids opacos (D-B14-3); evidências em arquivos 600.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PRODUCAO, BANCOS_PROIBIDOS } = require('./assinatura-reconciliar.cjs');

const STAGING = Object.freeze({ database: 'kidmais_staging_1z91', host: 'dpg-daidko3m8hqs73ce4jt0-a', port: 5432 });
const SAIDA_PADRAO = '/opt/render/project/src/data/b14';
const NOME_APLICACAO = 'kidmais-recuperacao-b14';
/** Trava global (pg_try_advisory_lock(int4, int4)): só entre execuções do B-14; o cron de conferência não a usa. */
const TRAVA = Object.freeze([1414, 1027]);
const PRAZO_TOTAL_MS = 15 * 60 * 1000;

const ARQUIVO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SHA = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const MIGRACAO = /^\d{3}[a-z]?$/;

/** Opções aceitas por modo (lista fechada; qualquer outra recusa). */
const MODOS = {
    'fila': { obrig: ['url-webhook'], opc: ['saida'] },
    'janela-conferir': { obrig: ['desde', 'ate', 'migracoes', 'candidata'], opc: ['base', 'base-sha', 'selar-base', 'saida'] },
    'janela-recuperar': { obrig: ['desde', 'ate', 'migracoes', 'candidata', 'backup'], opc: ['saida'] },
    'restore-drenagem': { obrig: ['reinicio', 'contencao-desde', 'migracoes', 'candidata'], opc: ['saida'] },
    'restore-inventario': { obrig: ['desde', 'reinicio', 'drenagem', 'migracoes', 'candidata'], opc: ['saida'] },
    'restore-aplicar': { obrig: ['aplicar-caso', 'proposta', 'casos', 'backup', 'restaurado-em', 'migracoes', 'candidata'], opc: ['saida'] },
    'restore-conferir': { obrig: ['conferir-caso', 'proposta', 'casos', 'execucao', 'migracoes', 'candidata'], opc: ['saida'] },
    'restore-liberacao': { obrig: ['desde', 'reinicio', 'drenagem', 'decisoes', 'url-webhook', 'migracoes', 'candidata'], opc: ['prova-cron', 'saida'] },
};
const VALIDAR = {
    'desde': (v) => ISO.test(v), 'ate': (v) => ISO.test(v), 'reinicio': (v) => ISO.test(v), 'restaurado-em': (v) => ISO.test(v), 'contencao-desde': (v) => ISO.test(v),
    'execucao': (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
    'base': (v) => ARQUIVO.test(v), 'selar-base': (v) => ARQUIVO.test(v), 'backup': (v) => ARQUIVO.test(v), 'casos': (v) => ARQUIVO.test(v),
    'drenagem': (v) => ARQUIVO.test(v), 'decisoes': (v) => ARQUIVO.test(v), 'prova-cron': (v) => ARQUIVO.test(v),
    'base-sha': (v) => SHA.test(v), 'proposta': (v) => SHA.test(v), 'aplicar-caso': (v) => SHA.test(v), 'conferir-caso': (v) => SHA.test(v),
    'candidata': (v) => SHA1.test(v), 'migracoes': (v) => v === 'nenhuma' || v.split(',').every((m) => MIGRACAO.test(m)),
    'url-webhook': (v) => { try { return new URL(v).protocol === 'https:'; } catch { return false; } },
    'saida': (v) => path.isAbsolute(v),
};

class Recusa extends Error {
    constructor(codigo) { super(codigo); this.name = 'Recusa'; this.codigo = codigo; }
}

/** Modo + opções. Bandeiras de modo exclusivas; opção repetida, desconhecida, sem valor ou inválida recusa (código 1). */
function argumentos(argv) {
    const bandeiras = new Set();
    const opcoes = {};
    for (const a of argv) {
        const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
        if (!m) throw new Recusa('ARGUMENTO_INVALIDO');
        const [, nome, valor] = m;
        if (valor === undefined) {
            if (!['fila', 'janela', 'restore', 'conferir', 'recuperar', 'drenagem', 'inventario', 'liberacao'].includes(nome) || bandeiras.has(nome)) throw new Recusa('ARGUMENTO_INVALIDO');
            bandeiras.add(nome);
        }
        else {
            if (Object.hasOwn(opcoes, nome) || !VALIDAR[nome] || !VALIDAR[nome](valor)) throw new Recusa(`OPCAO_INVALIDA:${nome.toUpperCase().replaceAll('-', '_')}`);
            opcoes[nome] = valor;
        }
    }
    const tem = (...b) => b.length === bandeiras.size && b.every((x) => bandeiras.has(x));
    // `--drenagem` é bandeira no modo de drenagem e opção (arquivo) no inventário/liberação.
    const modo = tem('fila') ? 'fila' : tem('janela', 'conferir') ? 'janela-conferir' : tem('janela', 'recuperar') ? 'janela-recuperar'
        : tem('restore', 'drenagem') ? 'restore-drenagem' : tem('restore', 'inventario') ? 'restore-inventario' : tem('restore', 'liberacao') ? 'restore-liberacao'
        : tem('restore') && opcoes['aplicar-caso'] ? 'restore-aplicar' : tem('restore') && opcoes['conferir-caso'] ? 'restore-conferir' : null;
    if (!modo) throw new Recusa('MODO_INVALIDO');
    const regra = MODOS[modo];
    for (const o of regra.obrig) if (!Object.hasOwn(opcoes, o)) throw new Recusa(`OPCAO_OBRIGATORIA:${o.toUpperCase().replaceAll('-', '_')}`);
    for (const o of Object.keys(opcoes)) if (!regra.obrig.includes(o) && !regra.opc.includes(o)) throw new Recusa(`OPCAO_NAO_ADMITIDA:${o.toUpperCase().replaceAll('-', '_')}`);
    if (opcoes['base'] && !opcoes['base-sha'] || !opcoes['base'] && opcoes['base-sha'] || opcoes['base'] && opcoes['selar-base']) throw new Recusa('BASE_INVALIDA');
    if (opcoes.desde && opcoes.ate && Date.parse(opcoes.desde) > Date.parse(opcoes.ate)) throw new Recusa('JANELA_INVERTIDA');
    const migracoes = !opcoes.migracoes || opcoes.migracoes === 'nenhuma' ? [] : [...new Set(opcoes.migracoes.split(','))].sort();
    return { modo, opcoes, migracoes };
}

const hostLocal = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
/**
 * Revisão da rodada 1 do incremento 5 (P2-R1-1): o pg completa todo campo vazio ou falso com PG<CAMPO> do ambiente
 * (PGUSER, PGPASSWORD, PGOPTIONS, PGPORT, PGSSLMODE, PGAPPNAME…) e NODE_PG_FORCE_NATIVE troca o driver pelo libpq, que lê
 * ainda mais variáveis. Qualquer uma PRESENTE recusa (nada é neutralizado em silêncio). Só os nomes, nunca os valores.
 */
const variaveisPg = (e) => Object.keys(e).filter((k) => (k.startsWith('PG') || k === 'NODE_PG_FORCE_NATIVE') && e[k] !== undefined);
/**
 * Alvo (D-B14-1): a DATABASE_URL do serviço, confirmada pelo literal. Production e staging exigem o alvo exato, o Render e o
 * par serviço/provedor do ambiente; o local só o cluster descartável nomeado. Mensagens sem a URL.
 */
function validarAlvo(env) {
    let url;
    try { url = new URL(env.DATABASE_URL ?? ''); }
    catch { throw new Recusa('ALVO_SEM_URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Recusa('ALVO_SEM_URL');
    const database = decodeURIComponent(url.pathname.slice(1));
    const host = url.hostname.toLowerCase();
    const port = Number(url.port || 5432);
    if (!/^[A-Za-z0-9_-]+$/.test(database)) throw new Recusa('ALVO_INVALIDO');
    // P2-R1-2: porta 0 (ou fora de 1–65535) faria o pg cair em PGPORT ou na 5432; só inteiro válido.
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Recusa('ALVO_INVALIDO');
    if (variaveisPg(env).length) throw new Recusa('AMBIENTE_COM_VARIAVEL_PG');
    if (env.KIDMAIS_B14_ALVO !== `${database}@${host}:${port}`) throw new Recusa('ALVO_NAO_CONFIRMADO');
    const igual = (a) => database === a.database && host === a.host && port === a.port;
    let ambiente;
    if (igual(PRODUCAO)) {
        if (env.RENDER !== 'true' || env.KIDMAIS_DEPLOY_ENV !== 'production' || env.ASAAS_AMBIENTE !== 'producao') throw new Recusa('ALVO_PRODUCAO_FORA_DO_SERVICO');
        ambiente = 'producao';
    }
    else if (igual(STAGING)) {
        if (env.RENDER !== 'true' || env.KIDMAIS_DEPLOY_ENV !== 'staging' || env.ASAAS_AMBIENTE !== 'sandbox') throw new Recusa('ALVO_STAGING_FORA_DO_SERVICO');
        ambiente = 'sandbox';
    }
    else if (hostLocal(host) && env.KIDMAIS_B14_DESCARTAVEL === database && !BANCOS_PROIBIDOS.has(database.toLowerCase()) && env.ASAAS_AMBIENTE === 'sandbox') ambiente = 'sandbox';
    else throw new Recusa('ALVO_RECUSADO');
    // Revisão do incremento 5 (P1): o pg relê parâmetros da query (host, port, options…) e eles SOBRESCREVERIAM o alvo
    // validado. Só `sslmode` é admitido (a política TLS é a desta entrada); qualquer outro recusa. A conexão é montada com
    // os campos já validados, sem connectionString.
    for (const k of url.searchParams.keys()) if (k !== 'sslmode') throw new Recusa('ALVO_COM_PARAMETRO_NA_URL');
    const local = hostLocal(host);
    if (!local && env.DATABASE_SSL !== 'true') throw new Recusa('TLS_RECUSADO');
    // P2-R1-1: credenciais explícitas na URL do serviço. Usuário sempre; senha fora do local. No local (cluster descartável
    // em trust) a senha pode faltar; ATENÇÃO (aprovação com ressalvas do incremento 5, P3-R2-1): se o servidor pedir senha, o
    // pg 8 ainda consulta o pgpass padrão (HOME/.pgpass ou %APPDATA%/postgresql/pgpass.conf) mesmo sem PG*; o PGPASSFILE é
    // recusado com as demais PG*. Em production/staging a senha é obrigatória e esse caminho não existe.
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    if (!user || (!local && !password)) throw new Recusa('ALVO_SEM_CREDENCIAL');
    return { database, host, port, local, ambiente,
        conexao: { host: host.replace(/^\[|\]$/g, ''), port, database, user, password,
            ssl: local ? false : { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', minVersion: 'TLSv1.2' } } };
}

/**
 * Stdout (D-B14-3), por lista estrita de formas: códigos (MAIÚSCULAS, dígitos, `_`, `:`, `+`), ids opacos (sha-256), uuid
 * da execução, datas ISO, prefixos de schema (P0a…P11; o PH de homologação sai pela forma de código) e nomes de arquivo da própria ferramenta. Qualquer outro texto vira
 * OUTRO — inclusive palavras comuns. Chaves também passam por filtro (nunca um nome vira chave).
 */
const FORMAS_SEGURAS = [/^[A-Z0-9_:+]{1,140}$/, /^[0-9a-f]{64}$/, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/, /^P\d{1,2}[ab]?$/, /^[a-z]+-[0-9a-f-]{36}\.json$/];
function sanitizar(v) {
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
    if (typeof v === 'string') return FORMAS_SEGURAS.some((r) => r.test(v)) ? v : 'OUTRO';
    if (Array.isArray(v)) return v.map(sanitizar);
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [/^[A-Za-z0-9_:+.-]{1,140}$/.test(k) ? k : 'OUTRO', sanitizar(x)]));
    return null;
}

/** Arquivos restritos: pasta 700, arquivos 600 criados com `wx` (nunca sobrescritos); só nomes simples dentro da pasta. */
function arquivosEm(pasta) {
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
    // mkdir não corrige uma pasta que já existia: a permissão é forçada (sem efeito no Windows).
    if (process.platform !== 'win32') fs.chmodSync(pasta, 0o700);
    const caminho = (nome) => {
        if (!ARQUIVO.test(nome) || nome.includes('..')) throw new Recusa('ARQUIVO_INVALIDO');
        return path.join(pasta, nome);
    };
    return {
        ler(nome) {
            try { return JSON.parse(fs.readFileSync(caminho(nome), 'utf8')); }
            catch (e) { if (e instanceof Recusa) throw e; return null; }
        },
        gravarNovo(nome, conteudo) { fs.writeFileSync(caminho(nome), `${JSON.stringify(conteudo, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); },
        invalidar(nome) { fs.renameSync(caminho(nome), `${caminho(nome)}.invalidada-${Date.now()}`); },
        listar(prefixo) { return fs.readdirSync(pasta).filter((n) => n.startsWith(prefixo) && n.endsWith('.json')).sort(); },
    };
}

/**
 * Controle de parada (§3.9). Revisão da rodada 2 do incremento 4 (P2-R2-1): SIGTERM e prazo são reavaliados DEPOIS da
 * consulta da trava — um sinal ou um prazo que chega enquanto ela está pendente não pode virar "continuar". Ordem da
 * resposta: SIGTERM e trava perdida (1) antes do prazo (3). Rodada 3 (P2-R3-1): só o SIGTERM encerra sem consultar; com
 * o prazo já vencido a trava AINDA é consultada, para que uma trava perdida não saia como limitação de cobertura (3).
 * Rodada 4 (P2-R4-1): statement_timeout limita o servidor, não a entrega da resposta. A espera pela consulta tem limite NO
 * PROCESSO (`limiteConsultaMs`) e é interrompida por SIGTERM (verificado a cada `intervaloMs`). Em qualquer dos dois, a
 * conexão é DESCARTADA (`descartar`: destrói o soquete — o servidor desfaz a transação aberta; nada mais usa essa conexão)
 * e a parada é 1: SIGTERM ou TRAVA_SEM_RESPOSTA (nunca cobertura). `descartada()` informa o motivo a quem encerra.
 */
const LIMITE_CONSULTA_TRAVA_MS = 10_000;
function criarControle({ client, sinal, inicio, agora = () => Date.now(), prazoMs = PRAZO_TOTAL_MS, limiteConsultaMs = LIMITE_CONSULTA_TRAVA_MS,
    intervaloMs = 100, descartar = () => undefined }) {
    const prazo = () => (agora() - inicio > prazoMs ? 'LIMITE_EXECUCAO' : null);
    let descarte = null;
    const esperar = (p) => new Promise((resolve) => {
        let feito = false;
        const fim = (v) => { if (!feito) { feito = true; clearInterval(vigia); clearTimeout(limite); resolve(v); } };
        const vigia = setInterval(() => { if (sinal()) fim({ sinal: true }); }, intervaloMs);
        const limite = setTimeout(() => fim({ limite: true }), limiteConsultaMs);
        p.then((r) => fim({ r }), () => fim({ erro: true }));
    });
    return {
        descartada: () => descarte,
        async parar() {
            if (descarte) return descarte;
            if (sinal()) return 'SIGTERM';
            const r = await esperar(Promise.resolve().then(() => client.query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
                AND classid = $1::int::oid AND objid = $2::int::oid AND objsubid = 2) AS ok`, TRAVA)));
            if (r.sinal || r.limite) {
                descarte = r.sinal ? 'SIGTERM' : 'TRAVA_SEM_RESPOSTA';
                try { descartar(); } catch { /* o descarte não muda o motivo */ }
                return descarte;
            }
            const trava = r.erro || r.r?.rows?.[0]?.ok !== true ? 'TRAVA_PERDIDA' : null;
            if (sinal()) return 'SIGTERM';
            return trava ?? prazo();
        },
    };
}

async function conferirMarcadores(client, migracoes, marcadores, divergenciasDeMarcadores) {
    const presentes = new Set();
    for (const [m, o] of Object.entries(marcadores)) {
        const sql = o.tipo === 'tabela' ? "SELECT to_regclass('public.' || $1) IS NOT NULL AS ok" : "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1) AS ok";
        if ((await client.query(sql, [o.nome])).rows[0].ok === true) presentes.add(m);
    }
    return divergenciasDeMarcadores(migracoes, presentes, marcadores);
}

/** `deps.cliente`: dublê do Asaas, só nos testes (sem ele, o cliente real da configuração do serviço). */
async function main(argv = process.argv.slice(2), env = process.env, sair = (c) => { process.exitCode = c; }, deps = {}) {
    const execucao = randomUUID();
    const imprimir = (r) => console.log(JSON.stringify(sanitizar(r), null, 2));
    let a;
    try { a = argumentos(argv); }
    catch (e) { imprimir({ modo: null, codigo: 1, execucao, resultado: 'RECUSADA', motivo: e instanceof Recusa ? e.codigo : 'ERRO' }); return sair(1); }
    // Nome público do modo (FILA, JANELA_CONFERIR…): a saída estrita só aceita códigos em maiúsculas.
    const modo = a.modo.toUpperCase().replace(/-/g, '_');
    const exec = await import('../lib/assinatura/recuperacao-execucao.ts');
    const modos = await import('../lib/assinatura/recuperacao-modos.ts');
    const asaas = await import('../lib/assinatura/asaas.ts');
    const { contaProvedor, contaValida } = await import('../lib/creditos/config.ts');
    const arquivos = arquivosEm(a.opcoes.saida ?? SAIDA_PADRAO);
    const registrar = (r) => { try { arquivos.gravarNovo(`execucao-${execucao}.json`, sanitizar(r)); } catch { /* a evidência da execução não muda o código */ } };
    const terminar = (r) => { registrar(r); imprimir(r); sair(r.codigo); };

    const estado = deps.cliente ? { ligado: true, config: { ambiente: env.ASAAS_AMBIENTE } } : asaas.configuracaoAsaas(env);
    if (!estado.ligado) return terminar({ modo, codigo: 1, execucao, resultado: 'RECUSADA', motivo: 'ASAAS_DESLIGADO' });
    const cliente = deps.cliente ?? asaas.criarClienteAsaas(estado.config);
    if (a.modo === 'fila') return terminar(await modos.modoFila(cliente, a.opcoes['url-webhook'], execucao));

    let alvo;
    // P2-R1-1: o pg lê o process.env do processo (não o `env` recebido); confere os dois.
    try { alvo = validarAlvo(env); if (variaveisPg(process.env).length) throw new Recusa('AMBIENTE_COM_VARIAVEL_PG'); }
    catch (e) { return terminar({ modo, codigo: 1, execucao, resultado: 'RECUSADA', motivo: e instanceof Recusa ? e.codigo : 'ALVO' }); }
    if (alvo.ambiente !== estado.config.ambiente) return terminar({ modo, codigo: 1, execucao, resultado: 'RECUSADA', motivo: 'AMBIENTE_DIVERGENTE' });
    const codigoNoAr = exec.codigoNoAr(env.RENDER_GIT_COMMIT, a.opcoes.candidata);
    const prefixo = (await import('../lib/assinatura/recuperacao-baseline.ts')).prefixoDoSchema(a.migracoes, alvo.ambiente);
    if (!exec.modoAdmitido(prefixo ? prefixo.indice : null, codigoNoAr, a.modo))
        return terminar({ modo, codigo: 1, execucao, resultado: 'RECUSADA', motivo: !codigoNoAr ? 'CODIGO_NO_AR_DESCONHECIDO' : !prefixo ? 'SCHEMA_FORA_DA_LISTA' : 'MODO_NAO_ADMITIDO' });

    const { Client } = require('pg');
    const client = new Client({ ...alvo.conexao, connectionTimeoutMillis: 10_000, application_name: NOME_APLICACAO });
    client.on('error', () => undefined);
    let sigterm = false;
    let controle = null;
    const aoSigterm = () => { sigterm = true; };
    process.on('SIGTERM', aoSigterm);
    const inicio = Date.now();
    try {
        await client.connect();
        const id = (await client.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls, (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS agora')).rows[0];
        if (id.db !== alvo.database || (!alvo.local && id.tls !== true)) return terminar({ modo, codigo: 1, execucao, resultado: 'RECUSADA', motivo: 'ALVO_CONECTADO_DIFERENTE' });
        await client.query("SET statement_timeout = '60s'");
        await client.query("SET lock_timeout = '5s'");
        if ((await client.query('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', TRAVA)).rows[0].ok !== true)
            return terminar({ modo, codigo: 1, execucao, resultado: 'RECUSADA', motivo: 'TRAVA_OCUPADA' });
        const divergentes = await conferirMarcadores(client, a.migracoes, exec.marcadoresDoAmbiente(alvo.ambiente), exec.divergenciasDeMarcadores);
        if (divergentes.length) return terminar({ modo, codigo: 1, execucao, resultado: 'RECUSADA', motivo: 'MIGRACOES_DIVERGENTES', migracoes: divergentes });
        if (a.modo === 'janela-recuperar' || a.modo === 'restore-aplicar') {
            const motivo = exec.validarBackup(arquivos.ler(a.opcoes.backup), { banco: alvo.database, agoraMs: Number(id.agora),
                restauradoEmMs: a.opcoes['restaurado-em'] ? Date.parse(a.opcoes['restaurado-em']) : null });
            if (motivo) return terminar({ modo, codigo: 1, execucao, resultado: 'RECUSADA', motivo });
        }
        // Descarte: destrói o soquete (sem esperar a resposta pendente); o servidor desfaz a transação aberta.
        controle = criarControle({ client, sinal: () => sigterm, inicio, descartar: () => { client.connection?.stream?.destroy(); } });
        const x = { client, cliente, execucao, ambiente: alvo.ambiente, creditos: contaValida(env) ? { ambiente: alvo.ambiente, conta: contaProvedor(env) } : null,
            controle, arquivos, migracoes: a.migracoes, codigoNoAr };
        const o = a.opcoes;
        const ate = o.ate ?? new Date(Number(id.agora)).toISOString();
        const r = a.modo === 'janela-conferir' ? await modos.modoJanela(x, { desde: o.desde, ate, recuperar: false, base: o.base ? { nome: o.base, sha: o['base-sha'] } : null, selar: o['selar-base'] ?? null })
            : a.modo === 'janela-recuperar' ? await modos.modoJanela(x, { desde: o.desde, ate, recuperar: true })
            : a.modo === 'restore-drenagem' ? await modos.modoDrenagem(x, { reinicio: o.reinicio, contencaoDesde: o['contencao-desde'] })
            : a.modo === 'restore-inventario' ? await modos.modoInventario(x, { desde: o.desde, ate, drenagem: o.drenagem, reinicio: o.reinicio })
            : a.modo === 'restore-aplicar' ? await modos.modoAplicarCaso(x, { casos: o.casos, identidade: o['aplicar-caso'], proposta: o.proposta })
            : a.modo === 'restore-conferir' ? await modos.modoConferirCaso(x, { casos: o.casos, identidade: o['conferir-caso'], proposta: o.proposta, execucaoDaAplicacao: o.execucao })
            : await modos.modoLiberacao(x, { desde: o.desde, ate, drenagem: o.drenagem, reinicio: o.reinicio, decisoes: o.decisoes, urlWebhook: o['url-webhook'], provaCron: o['prova-cron'] ?? null });
        return terminar(r);
    }
    catch (e) {
        // Conexão descartada pelo controle: o erro seguinte (ROLLBACK numa conexão destruída) não troca o motivo da parada.
        const motivo = controle?.descartada() ?? (e instanceof modos.ParadaExecucao ? e.motivo : e instanceof Recusa ? e.codigo : e instanceof Error && e.message === 'DECISOES_INVALIDAS' ? 'DECISOES_INVALIDAS' : 'ERRO_INTERNO');
        // Código pela tabela única: só a parada de prazo é cobertura (3); o resto é recusa técnica (1).
        return terminar({ modo, codigo: modos.PARADAS_DE_COBERTURA.has(motivo) ? 3 : 1, execucao, resultado: 'INTERROMPIDA', motivo });
    }
    finally {
        process.off('SIGTERM', aoSigterm);
        await client.end().catch(() => undefined);
    }
}

if (require.main === module) main().catch(() => { console.log(JSON.stringify({ codigo: 1, resultado: 'ERRO_INTERNO' })); process.exitCode = 1; });

module.exports = { argumentos, validarAlvo, sanitizar, arquivosEm, criarControle, LIMITE_CONSULTA_TRAVA_MS, Recusa, STAGING, TRAVA, NOME_APLICACAO, PRAZO_TOTAL_MS, main };
