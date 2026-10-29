/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Renovação Fundador RESTRITA (G2): processa SOMENTE as empresas de uma lista explícita, nunca a base inteira.
 * Execução manual e autorizada; NÃO é agendada (nenhum cron, render.yaml ou package.json chama este arquivo).
 * O executável antigo (scripts/assinatura-renovar.cjs) continua como está.
 *
 *   node --experimental-strip-types scripts/assinatura-renovar-restrito.cjs --empresas=<uuid>[,<uuid>…]
 *   node --experimental-strip-types scripts/assinatura-renovar-restrito.cjs --empresas-arquivo=<lista.json>
 *   opções: --aplicar           grava, envia e altera o provedor (padrão: simulação, transações READ ONLY)
 *           --agora=<ISO 8601>  instante de negócio injetado (ensaio acelerado); a janela de 23 h da retentativa
 *                               do aviso continua no relógio real (deps.relogioReal, G1). Só com a lista.
 *   lista.json: ["<uuid>", …] ou { "empresas": ["<uuid>", …] }; 1 a 50 empresas, sem repetição.
 *
 * Alvo SEMPRE explícito, como na reconciliação (KIDMAIS_RECONCILIAR_DATABASE_URL + KIDMAIS_RECONCILIAR_ALVO; nunca
 * DATABASE_URL nem .env.local). Recusados antes de conectar: produção (KIDMAIS_DEPLOY_ENV=production ou serviço de
 * produção), qualquer serviço Render que não seja o web de staging (inclusive crons), Asaas fora do sandbox, banco
 * kidmais_manager/produção, e banco remoto que não seja o de staging executado no próprio Render.
 * Aplicação: local só com e-mail em arquivo; staging só com Resend configurado. Executar em staging exige
 * autorização explícita (docs/OPERACAO_AGENTES.md).
 *
 * Saída (JSON sanitizado): por empresa, resultado, estado antes/depois, motivo (código) e nome do erro; nenhum
 * e-mail, destinatário, mensagem, valor ou id do provedor. Código: 0 sem pendência; 2 alguma empresa em revisão,
 * erro, envio incerto ou sem Fundador (alerta); 1 configuração recusada ou interrupção.
 */
const fs = require('node:fs');
const { validarAlvo, opcoesConexao, provedorDaExecucao } = require('./assinatura-reconciliar.cjs');

const SERVICO_PRODUCAO = 'srv-dak77m2d0e5s73b8rkkg';
/** Somente o web de staging (Shell). O cron de reconciliação (crn-…) não é aceito: esta entrada não é agendada. */
const SERVICOS_PERMITIDOS = new Set(['srv-daif418ae00c73e8k2gg']);
const BANCO_STAGING = 'kidmais_staging_1z91';
const MAX_EMPRESAS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const RESULTADO_ALERTA = /ERRO|DIVERGENTE|INCERTO|PERDIDA|ALTERADO|INVALIDO|REVISAO|PROCESSADA|PRAZO|SEM_FUNDADOR|ILEGIVEL/;

function argumentos(argv) {
    const r = { aplicar: false, empresas: null, arquivo: null, agora: null };
    const vistos = new Set();
    for (const a of argv) {
        const [nome, ...resto] = a.split('=');
        const valor = resto.join('=');
        if (vistos.has(nome)) throw new Error(`Argumento repetido: ${nome}`);
        vistos.add(nome);
        if (a === '--aplicar') r.aplicar = true;
        else if (nome === '--empresas' && resto.length) r.empresas = valor;
        else if (nome === '--empresas-arquivo' && resto.length) r.arquivo = valor;
        else if (nome === '--agora' && resto.length) r.agora = valor;
        else throw new Error(`Argumento desconhecido: ${nome.slice(0, 40)}`);
    }
    return r;
}

/** Lista explícita: obrigatória, 1..50 UUIDs, sem repetição. Nunca há execução global. */
function listaDeEmpresas(args, lerArquivo = (p) => fs.readFileSync(p, 'utf8')) {
    if ((args.empresas === null) === (args.arquivo === null))
        throw new Error('Informe exatamente uma lista de empresas: --empresas=<uuid,…> ou --empresas-arquivo=<lista.json>. Execução global é recusada.');
    let bruta;
    if (args.empresas !== null) bruta = args.empresas.split(',').map((x) => x.trim());
    else {
        let json;
        try { json = JSON.parse(lerArquivo(args.arquivo)); }
        catch { throw new Error('Arquivo de empresas ilegível ou não é JSON.'); }
        bruta = Array.isArray(json) ? json : json && Array.isArray(json.empresas) ? json.empresas : null;
        if (!bruta) throw new Error('Arquivo de empresas deve ser uma lista ou { "empresas": [...] }.');
    }
    if (bruta.length === 0 || bruta.every((x) => x === '')) throw new Error('Lista de empresas vazia: execução global é recusada.');
    if (bruta.length > MAX_EMPRESAS) throw new Error(`No máximo ${MAX_EMPRESAS} empresas por execução.`);
    const empresas = bruta.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : ''));
    if (empresas.some((x) => !UUID.test(x))) throw new Error('Lista de empresas com identificador inválido.');
    if (new Set(empresas).size !== empresas.length) throw new Error('Lista de empresas com repetição.');
    return empresas;
}

/** Ambiente e alvo, sem conectar. Lança Error com mensagem sem a URL. */
function guardarAmbiente(env, alvo) {
    if (env.KIDMAIS_DEPLOY_ENV === 'production' || env.RENDER_SERVICE_ID === SERVICO_PRODUCAO)
        throw new Error('Produção recusada: a renovação restrita só roda em banco local isolado ou em staging.');
    if (env.ASAAS_AMBIENTE !== 'sandbox') throw new Error('Renovação aceita somente Asaas sandbox.');
    const noRender = env.RENDER === 'true' || Boolean(env.RENDER_SERVICE_ID);
    if (noRender && (!SERVICOS_PERMITIDOS.has(env.RENDER_SERVICE_ID) || env.KIDMAIS_DEPLOY_ENV !== 'staging'))
        throw new Error('Serviço Render recusado: somente o Shell do web de staging (nenhum cron).');
    if (!alvo.local && (!noRender || env.KIDMAIS_DEPLOY_ENV !== 'staging' || alvo.database !== BANCO_STAGING))
        throw new Error('Banco remoto recusado: somente o banco de staging, a partir do próprio serviço de staging.');
}

function configuracaoRestrita(env, argv, lerArquivo) {
    const args = argumentos(argv);
    const empresas = listaDeEmpresas(args, lerArquivo);
    let agora = null;
    if (args.agora !== null) {
        if (!empresas.length) throw new Error('--agora exige a lista de empresas.');
        const [ano, mes, dia] = args.agora.slice(0, 10).split('-').map(Number);
        if (!ISO.test(args.agora) || !Number.isFinite(Date.parse(args.agora)) || new Date(Date.UTC(ano, mes - 1, dia)).getUTCDate() !== dia)
            throw new Error('--agora deve ser um instante ISO 8601 com fuso.');
        agora = new Date(Date.parse(args.agora));
    }
    const alvo = validarAlvo(env);
    guardarAmbiente(env, alvo);
    if (args.aplicar && alvo.local && env.EMAIL_PROVIDER !== 'arquivo')
        throw new Error('Aplicação em banco local exige e-mail em arquivo.');
    if (args.aplicar && !alvo.local && env.EMAIL_PROVIDER !== 'resend')
        throw new Error('Aplicação em staging exige o provedor de e-mail Resend configurado.');
    return { aplicar: args.aplicar, empresas, agora, alvo };
}

/**
 * Tempo de negócio injetado com aplicação fora de banco local: só para fixtures de homologação (regra única
 * ehFixtureHomologacao, código hml- E nome "TESTE "). Toda empresa da lista tem de existir e ser fixture; uma empresa
 * real nunca recebe aviso ou preço antecipado. Simulação (READ ONLY) e banco local não precisam desta trava.
 */
function conferirAgoraSomenteFixtures(cfg, linhas, ehFixture) {
    if (!cfg.agora || !cfg.aplicar || cfg.alvo.local) return;
    const porId = new Map(linhas.map((l) => [String(l.id), l]));
    const recusadas = cfg.empresas.filter((id) => { const l = porId.get(id); return !l || !ehFixture({ codigo:l.codigo, nome:l.nome }); });
    if (recusadas.length)
        throw new Error(`--agora com --aplicar fora de banco local só para fixtures de homologação (${recusadas.length} empresa(s) recusada(s)).`);
}

/** Só estado e código de erro do registro: nada de destinatário, e-mail, mensagem ou valores. */
function estadoSanitizado(contexto) {
    if (!contexto) return { estado: 'SEM_FUNDADOR', motivo: null };
    return { estado: contexto.registro ? contexto.registro.estado : 'SEM_REGISTRO', motivo: contexto.registro ? contexto.registro.ultimoErro : null };
}

/** Processa só a lista, em ordem, uma empresa por vez; nenhuma exceção interrompe as demais. */
async function executarRestrito({ empresas, processar, ler }) {
    const itens = [];
    const estado = async (empresaId) => {
        try { return estadoSanitizado(await ler(empresaId)); }
        catch { return { estado: 'ILEGIVEL', motivo: null }; }
    };
    for (const empresaId of empresas) {
        const antes = await estado(empresaId);
        let resultado, erro = null;
        try { resultado = await processar(empresaId); }
        catch (e) { resultado = 'ERRO_REPROCESSAVEL'; erro = e instanceof Error ? e.name : 'Erro'; }
        const depois = await estado(empresaId);
        itens.push({ empresaId, resultado, estadoAntes: antes.estado, estadoDepois: depois.estado, motivo: depois.motivo, erro });
    }
    const resultados = {};
    for (const i of itens) resultados[i.resultado] = (resultados[i.resultado] ?? 0) + 1;
    const alerta = itens.some((i) => RESULTADO_ALERTA.test(i.resultado) || RESULTADO_ALERTA.test(i.estadoDepois) || i.erro !== null);
    return { itens, resultados, alerta };
}

async function main() {
    const cfg = configuracaoRestrita(process.env, process.argv.slice(2));
    const { criarClienteAsaas, configuracaoAsaas } = await import('../lib/assinatura/asaas.ts');
    const { processarRenovacao } = await import('../lib/assinatura/renovacao-fundador.ts');
    const { repositorioRenovacao } = await import('../lib/assinatura/renovacao-repositorio.ts');
    const { criarEnviarEmail, situacaoEmail, origemPublica } = await import('../lib/acessos/email.ts');
    const { travaPorEmpresa } = await import('../lib/assinatura/cobranca.ts');
    const config = configuracaoAsaas(process.env);
    if (!config.ligado) throw new Error('Asaas sandbox não configurado.');
    if (cfg.aplicar && !situacaoEmail(process.env).configurado) throw new Error('E-mail não configurado para a aplicação.');
    const { Pool } = require('pg');
    const pool = new Pool({ ...opcoesConexao(cfg.alvo, process.env), max: 3, connectionTimeoutMillis: 10000, application_name: 'kidmais-renovacao-restrita' });
    pool.on('error', () => undefined);
    const transacao = async (f) => {
        const tx = await pool.connect();
        try {
            await tx.query(cfg.aplicar ? 'BEGIN' : 'BEGIN READ ONLY');
            await tx.query("SET LOCAL statement_timeout = '30s'");
            await tx.query("SET LOCAL lock_timeout = '5s'");
            const r = await f(tx); await tx.query('COMMIT'); return r;
        } catch (e) { await tx.query('ROLLBACK'); throw e; }
        finally { tx.release(); }
    };
    try {
        const id = (await pool.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        if (id.db !== cfg.alvo.database || (!cfg.alvo.local && id.tls !== true)) throw new Error('Banco conectado diverge do alvo confirmado.');
        // Antes de qualquer processamento: tempo injetado com aplicação em staging só para fixtures.
        const { ehFixtureHomologacao } = await import('../lib/assinatura/renovacao-operacao.ts');
        const linhas = (await pool.query('SELECT id::text AS id, codigo, nome FROM empresas WHERE id = ANY($1::uuid[])', [cfg.empresas])).rows;
        conferirAgoraSomenteFixtures(cfg, linhas, ehFixtureHomologacao);
        // B-9 production (plano rev. 5 §2.6): mesma capacidade do cron; schema incompatível recusa antes de processar.
        const { capacidadeRenovacao } = await import('../lib/assinatura/renovacao-schema.ts');
        const cap = await transacao(capacidadeRenovacao);
        if (cap.capacidade === 'INCOMPATIVEL') throw new Error('SCHEMA_RENOVACAO_INCOMPATIVEL');
        const repositorio = repositorioRenovacao(transacao, { capacidade: cap.capacidade });
        const relatorio = {};
        const deps = { repositorio, provedor: provedorDaExecucao(criarClienteAsaas(config.config), cfg.aplicar, relatorio),
            enviar: cfg.aplicar ? criarEnviarEmail(process.env) : async () => { throw new Error('Envio proibido na simulação.'); },
            origem: origemPublica(), simular: !cfg.aplicar, travar: travaPorEmpresa(transacao),
            agora: cfg.agora ? () => new Date(cfg.agora.getTime()) : () => new Date(),
            ...(cfg.agora ? { relogioReal: () => new Date() } : {}) };
        const r = await executarRestrito({ empresas: cfg.empresas, processar: (e) => processarRenovacao(e, deps), ler: (e) => repositorio.ler(e) });
        console.log(JSON.stringify({ modo: cfg.aplicar ? 'APLICAR' : 'SIMULACAO_SEM_ESCRITA', banco: cfg.alvo.database,
            agoraInjetado: cfg.agora ? cfg.agora.toISOString() : null, empresas: cfg.empresas.length, resultados: r.resultados, itens: r.itens, alerta: r.alerta }, null, 2));
        if (r.alerta) process.exitCode = 2;
    } finally { await pool.end(); }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Renovação restrita recusada/interrompida: ${error instanceof Error ? error.message : 'erro'}`);
        process.exitCode = 1;
    });
}

module.exports = { argumentos, listaDeEmpresas, guardarAmbiente, configuracaoRestrita, executarRestrito, estadoSanitizado, conferirAgoraSomenteFixtures, MAX_EMPRESAS, SERVICO_PRODUCAO };
