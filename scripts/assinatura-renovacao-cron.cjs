/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * B-9 — cron da renovação Fundador (plano docs/PLANO_RENOVACAO_AGENDADA_B9_20261025.md, rev. 3.1; D-B9-1..5 de Felipe).
 * Serviço de cron PRÓPRIO por ambiente, de hora em hora. A reconciliação (assinatura-cron.cjs) não muda.
 *
 *   KIDMAIS_DEPLOY_ENV       staging | production (outro valor: recusa, código 1)
 *   KIDMAIS_RENOVACAO_MODO   aguardando (sai 0 sem conectar) | simular (READ ONLY) | aplicar (modo agendado da rotina)
 *   KIDMAIS_RENOVACAO_PRODUCAO_DESDE=AAAA-MM-DD   production: `aplicar` só a partir desta data (Brasília); antes, simula
 *   Alvo: KIDMAIS_RECONCILIAR_DATABASE_URL + KIDMAIS_RECONCILIAR_ALVO (nunca DATABASE_URL), como na reconciliação.
 *
 * Homologação, SÓ em staging e só pelo Shell (nunca no comando do cron): --empresas=<uuid,…> (interseção com a seleção global)
 * e --agora=<ISO> (exige --empresas; com `aplicar`, toda empresa precisa ser fixture `ehFixtureHomologacao`).
 *
 * T2 (27/10/2026, aprovada por Felipe): credencial igual à DATABASE_URL do web de staging, só no Shell da homologação, por
 * exceção EXPLÍCITA (ver CREDENCIAL_DO_SERVICO abaixo). A igualdade é conferida, nunca escondida, e sai no relatório.
 *
 * Saída: JSON sanitizado (ids internos de empresa, códigos e contagens). Código 0 sem pendência; 2 alerta; 1 recusa ou
 * interrupção. Nenhum e-mail, destinatário, valor ou id do provedor.
 */
const { validarAlvo, opcoesConexao, provedorDaExecucao } = require('./assinatura-reconciliar.cjs');
const { listaDeEmpresas, conferirAgoraSomenteFixtures } = require('./assinatura-renovar-restrito.cjs');

const STAGING = Object.freeze({ database: 'kidmais_staging_1z91', host: 'dpg-daidko3m8hqs73ce4jt0-a', port: 5432 });
const TRAVA_GLOBAL = 'kidmais:renovacao-cron';
/**
 * T1 (26/10/2026, aprovada por Felipe): lista FECHADA da exceção TLS `render-interno-criptografado` para a renovação, nas
 * mesmas condições da reconciliação (Render, staging, sandbox, alvo literal `kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432`).
 *   - web de staging: só para o Shell da homologação (a aplicação web não chama esta entrada);
 *   - cron da renovação de staging (`kidmais-assinatura-renovacao-staging`, criado em `aguardando` em 27/10/2026, depois da
 *     homologação do passo 2). O cron da reconciliação NÃO está nesta lista, e o web não está na dela.
 */
const CRON_RENOVACAO_STAGING = 'crn-dbg512hsrm7s73chk57g'; // kidmais-assinatura-renovacao-staging, criado em aguardando em 27/10/2026
const SERVICOS_TLS_RENOVACAO = Object.freeze(['srv-daif418ae00c73e8k2gg', ...(CRON_RENOVACAO_STAGING ? [CRON_RENOVACAO_STAGING] : [])]);
/**
 * T2 (27/10/2026, aprovada por Felipe): no Shell do web de staging, a credencial do cron de reconciliação é a MESMA
 * DATABASE_URL do web, que `validarAlvo` recusa por padrão. A renovação aceita essa igualdade só com TODAS as condições:
 *   - opt-in literal KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO=web-staging-homologacao;
 *   - staging, RENDER=true, RENDER_SERVICE_ID = web de staging (lista fechada, sem cron), Asaas sandbox;
 *   - alvo literal de staging (conferido depois, como sempre);
 *   - `simular` livre; `aplicar` só com --empresas e só para fixtures de homologação (conferido depois de conectar).
 * Com o opt-in fora dessas condições: CREDENCIAL_DO_SERVICO_RECUSADA. O relatório declara `credencialDoServico`.
 * A reconciliação e as demais entradas continuam recusando a igualdade. O cron da renovação (sem DATABASE_URL) não usa isto.
 */
const CREDENCIAL_DO_SERVICO = Object.freeze({ optIn: 'web-staging-homologacao', servicos: Object.freeze(['srv-daif418ae00c73e8k2gg']) });
function politicaCredencialDoServico(env, ambiente) {
    const pedido = env.KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO;
    if (pedido === undefined || pedido === '') return 'recusar';
    if (pedido !== CREDENCIAL_DO_SERVICO.optIn || ambiente !== 'staging' || env.RENDER !== 'true'
        || !CREDENCIAL_DO_SERVICO.servicos.includes(env.RENDER_SERVICE_ID) || env.ASAAS_AMBIENTE?.trim() !== 'sandbox')
        throw new Error('CREDENCIAL_DO_SERVICO_RECUSADA');
    return 'aceitar';
}
/**
 * Opções de conexão da renovação: a política da reconciliação com a lista fechada acima. Calculada antes de conectar.
 * A revalidação do alvo na exceção TLS recebe a MESMA política de credencial do planejamento (T2), recalculada do ambiente.
 */
const conexaoDaRenovacao = (alvo, env) => opcoesConexao(alvo, env, SERVICOS_TLS_RENOVACAO,
    { credencialDoServico: politicaCredencialDoServico(env, env.KIDMAIS_DEPLOY_ENV?.trim()) });
/** Trava global ainda desta sessão, pela chave exata: bigint = classid (32 bits altos) + objid (32 baixos), objsubid = 1. */
const SQL_TRAVA_MINHA = `SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND objsubid = 1
      AND ((classid::bigint << 32) | objid::bigint) = hashtext($1)::bigint`;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const diaBrasil = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const dataValida = (s) => typeof s === 'string' && DATA.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function argumentos(argv) {
    const r = { empresas: null, agora: null };
    const vistos = new Set();
    for (const a of argv) {
        const [nome, ...resto] = a.split('=');
        if (vistos.has(nome)) throw new Error(`Argumento repetido: ${nome.slice(0, 40)}`);
        vistos.add(nome);
        if (nome === '--empresas' && resto.length) r.empresas = resto.join('=');
        else if (nome === '--agora' && resto.length) r.agora = resto.join('=');
        else throw new Error(`Argumento desconhecido: ${nome.slice(0, 40)}`);
    }
    return r;
}

/** Sem conectar. null = aguardando. Recusas lançam Error (código 1). */
function planejar(env, argv = [], agora = new Date()) {
    const ambiente = env.KIDMAIS_DEPLOY_ENV?.trim();
    if (ambiente !== 'staging' && ambiente !== 'production') throw new Error('AMBIENTE_RECUSADO');
    const pedido = env.KIDMAIS_RENOVACAO_MODO?.trim();
    if (pedido === 'aguardando') {
        if (argv.length) throw new Error('ARGUMENTOS_EM_AGUARDANDO');
        return null;
    }
    if (pedido !== 'simular' && pedido !== 'aplicar') throw new Error('MODO_INVALIDO');
    const args = argumentos(argv);
    if ((args.empresas !== null || args.agora !== null) && ambiente !== 'staging') throw new Error('ARGUMENTOS_SO_EM_STAGING');
    if (args.agora !== null && args.empresas === null) throw new Error('AGORA_EXIGE_EMPRESAS');
    const empresas = args.empresas === null ? null : listaDeEmpresas({ empresas: args.empresas, arquivo: null });
    let agoraInjetado = null;
    if (args.agora !== null) {
        if (!ISO.test(args.agora) || !Number.isFinite(Date.parse(args.agora)) || !dataValida(args.agora.slice(0, 10)))
            throw new Error('AGORA_INVALIDO');
        agoraInjetado = new Date(Date.parse(args.agora));
    }
    const alvo = validarAlvo(env, { credencialDoServico: politicaCredencialDoServico(env, ambiente) });
    if (ambiente === 'staging') {
        if (alvo.producao || alvo.database !== STAGING.database || alvo.host !== STAGING.host || alvo.port !== STAGING.port)
            throw new Error('ALVO_STAGING_RECUSADO');
        if (env.ASAAS_AMBIENTE?.trim() !== 'sandbox') throw new Error('PROVEDOR_RECUSADO');
    } else if (!alvo.producao) throw new Error('ALVO_PRODUCAO_RECUSADO'); // alvoDeProducao já exige serviço e Asaas de produção
    let modo = pedido, rebaixado = false;
    if (ambiente === 'production' && modo === 'aplicar') {
        const desde = env.KIDMAIS_RENOVACAO_PRODUCAO_DESDE?.trim();
        if (!dataValida(desde) || diaBrasil(agora) < desde) { modo = 'simular'; rebaixado = true; }
    }
    if (modo === 'aplicar' && env.EMAIL_PROVIDER?.trim().toLowerCase() !== 'resend') throw new Error('EMAIL_RECUSADO');
    if (alvo.credencialDoServico && modo === 'aplicar' && empresas === null) throw new Error('CREDENCIAL_DO_SERVICO_EXIGE_EMPRESAS');
    return { ambiente, modo, rebaixado, alvo, empresas, agora: agoraInjetado };
}

/**
 * Alertas de FIXTURE DE HOMOLOGAÇÃO DESATIVADA (ehFixtureHomologacao + empresas.status = 'DESATIVADA') continuam no relatório,
 * em `alertasInformativos`, mas não contam para o código 2 (decisão de Felipe, 27/10/2026: uma fixture antiga desativada em
 * REVISAO fazia o cron sair 2 a cada hora). Só rebaixa 2 → 0 numa execução CONCLUIDA em que TODOS os alertas são desse tipo;
 * 1 (interrupção) e execuções não concluídas não mudam. Empresa real, ou fixture ativa, continua contando.
 * `linhas`: { id, codigo, nome, status } das empresas dos alertas (lidas do banco); empresa sem linha conta como real.
 */
function separarAlertasInformativos(relatorio, linhas, ehFixture) {
    const porId = new Map(linhas.map((l) => [String(l.id), l]));
    const informativo = (a) => { const l = porId.get(a.empresaId); return !!l && l.status === 'DESATIVADA' && ehFixture({ codigo: l.codigo, nome: l.nome }); };
    const alertas = relatorio.alertas.filter((a) => !informativo(a));
    const alertasInformativos = relatorio.alertas.filter(informativo);
    const codigo = relatorio.codigo === 2 && relatorio.execucao === 'CONCLUIDA' && alertas.length === 0 && alertasInformativos.length > 0 ? 0 : relatorio.codigo;
    return { ...relatorio, alertas, alertasInformativos, codigo };
}

/**
 * Execução com dependências injetáveis (testes PostgreSQL usam provedor e e-mail falsos). `f`:
 *   Pool, Client (pg), conexao (opções de conexão), provedor (cliente Asaas), enviar, origem, interrompido? () => boolean.
 */
async function executarCron(cfg, f) {
    const { processarRenovacao } = await import('../lib/assinatura/renovacao-fundador.ts');
    const { repositorioRenovacao, empresasParaRenovacao } = await import('../lib/assinatura/renovacao-repositorio.ts');
    const { travaPorEmpresa } = await import('../lib/assinatura/cobranca.ts');
    const { executarAgendada, instrumentarProvedor, observarRepositorio, contagemVazia } = await import('../lib/assinatura/renovacao-agendada.ts');
    const { capacidadeRenovacao } = await import('../lib/assinatura/renovacao-schema.ts');
    const { ehFixtureHomologacao } = await import('../lib/assinatura/renovacao-operacao.ts');
    const aplicar = cfg.modo === 'aplicar';
    const pool = new f.Pool({ ...f.conexao, max: 4, connectionTimeoutMillis: 10_000, application_name: 'kidmais-renovacao-cron' });
    pool.on('error', () => undefined);
    // Conexão DEDICADA da trava global (de sessão): cai com a conexão em qualquer queda do processo.
    const dedicada = new f.Client({ ...f.conexao, connectionTimeoutMillis: 10_000, application_name: 'kidmais-renovacao-cron-trava' });
    let perdida = false;
    dedicada.on('error', () => { perdida = true; });
    dedicada.on('end', () => { perdida = true; });
    const transacao = async (trabalho) => {
        const tx = await pool.connect();
        try {
            await tx.query(aplicar ? 'BEGIN' : 'BEGIN READ ONLY');
            await tx.query("SET LOCAL statement_timeout = '30s'");
            await tx.query("SET LOCAL lock_timeout = '5s'");
            const r = await trabalho(tx); await tx.query('COMMIT'); return r;
        } catch (e) { await tx.query('ROLLBACK').catch(() => undefined); throw e; }
        finally { tx.release(); }
    };
    await dedicada.connect();
    try {
        for (const c of [pool, dedicada]) {
            const id = (await c.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
            if (id.db !== cfg.alvo.database || (!cfg.alvo.local && id.tls !== true)) throw new Error('Banco conectado diverge do alvo confirmado.');
        }
        const global = await transacao(empresasParaRenovacao);
        const empresas = cfg.empresas ? cfg.empresas.filter((e) => global.includes(e)) : global;
        const naoElegiveis = cfg.empresas ? cfg.empresas.filter((e) => !global.includes(e)) : [];
        if (cfg.empresas) {
            // Mesma guarda da ferramenta restrita: tempo injetado com aplicação fora de banco local só para fixtures.
            const linhas = (await pool.query('SELECT id::text AS id, codigo, nome FROM empresas WHERE id = ANY($1::uuid[])', [cfg.empresas])).rows;
            conferirAgoraSomenteFixtures({ agora: cfg.agora, aplicar, alvo: cfg.alvo, empresas: cfg.empresas }, linhas, ehFixtureHomologacao);
            // T2: com a credencial do serviço, aplicar só em fixtures de homologação, com ou sem --agora.
            if (aplicar && cfg.alvo.credencialDoServico) {
                const porId = new Map(linhas.map((l) => [String(l.id), l]));
                const recusadas = cfg.empresas.filter((id) => { const l = porId.get(id); return !l || !ehFixtureHomologacao({ codigo: l.codigo, nome: l.nome }); });
                if (recusadas.length) throw new Error(`CREDENCIAL_DO_SERVICO_SO_FIXTURES (${recusadas.length} empresa(s) recusada(s))`);
            }
        } else if (aplicar && cfg.alvo.credencialDoServico) throw new Error('CREDENCIAL_DO_SERVICO_EXIGE_EMPRESAS');
        // Plano rev. 5 §2.6: capacidade lida UMA vez, depois das guardas de seleção e antes da primeira empresa. INCOMPATIVEL (retrato diferente da 075 e da
        // 109) = sem garantia do prazo do aviso, da imutabilidade e das transições: nada é processado, código 1.
        const cap = await transacao(capacidadeRenovacao);
        if (cap.capacidade === 'INCOMPATIVEL')
            return { modo: cfg.modo, execucao: 'SCHEMA_RENOVACAO_INCOMPATIVEL', divergencias: cap.divergencias, empresas: 0, processadas: 0,
                resultados: { SCHEMA_RENOVACAO_INCOMPATIVEL: 1 }, alertas: [], emAndamento: [], avisosNaJanela: 0,
                putsTotais: { ...contagemVazia(), empresasComTentativa: 0 }, alertasInformativos: [], codigo: 1 };
        const repositorio = repositorioRenovacao(transacao, { capacidade: cap.capacidade });
        const provedor = provedorDaExecucao(f.provedor, aplicar, {});
        const deps = { repositorio, provedor, origem: f.origem, simular: !aplicar, modoAgendado: true, capacidade: cap.capacidade,
            enviar: aplicar ? f.enviar : async () => { throw new Error('Envio proibido na simulação.'); },
            agora: cfg.agora ? () => new Date(cfg.agora.getTime()) : () => new Date(),
            ...(cfg.agora ? { relogioReal: () => new Date() } : {}) };
        const travaGlobal = {
            adquirir: async () => (await dedicada.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [TRAVA_GLOBAL])).rows[0].ok === true,
            aindaMinha: async () => !perdida && (await dedicada.query(SQL_TRAVA_MINHA, [TRAVA_GLOBAL])).rows[0].n === 1,
            liberar: async () => { if (!perdida) await dedicada.query('SELECT pg_advisory_unlock(hashtext($1))', [TRAVA_GLOBAL]); },
        };
        const relatorio = await executarAgendada({ modo: cfg.modo, empresas, naoElegiveis, travaGlobal, travarEmpresa: travaPorEmpresa(transacao),
            ler: (e) => repositorio.ler(e), provedor, agora: deps.agora, interrompido: f.interrompido,
            // D-P5-5 = B: por empresa, contagem POR FORA do bloqueio da simulação (provedorDaExecucao) e estado vigente observado.
            processar: (e, travar, i) => processarRenovacao(e, { ...deps, travar, provedor: instrumentarProvedor(provedor, i),
                repositorio: observarRepositorio(repositorio, i) }) });
        if (!relatorio.alertas || relatorio.alertas.length === 0) return { ...relatorio, alertasInformativos: [] };
        let linhas;
        try {
            linhas = (await pool.query("SELECT id::text AS id, codigo, nome, status::text AS status FROM empresas WHERE id = ANY($1::uuid[])",
                [relatorio.alertas.map((a) => a.empresaId)])).rows;
        } catch {
            // A finalização nunca descarta o relatório nem as contagens: sem a leitura, todos os alertas contam como reais.
            return { ...relatorio, alertasInformativos: [] };
        }
        return separarAlertasInformativos(relatorio, linhas, ehFixtureHomologacao);
    } finally {
        await dedicada.end().catch(() => undefined);
        await pool.end().catch(() => undefined);
    }
}

async function main() {
    const cfg = planejar(process.env, process.argv.slice(2));
    if (cfg === null) { console.log(JSON.stringify({ estado: 'AGUARDANDO_HABILITACAO', conectou: false })); return; }
    const { criarClienteAsaas, configuracaoAsaas } = await import('../lib/assinatura/asaas.ts');
    const { criarEnviarEmail, situacaoEmail, origemPublica } = await import('../lib/acessos/email.ts');
    const asaas = configuracaoAsaas(process.env);
    const esperado = cfg.ambiente === 'production' ? 'producao' : 'sandbox';
    if (!asaas.ligado || asaas.config.ambiente !== esperado) throw new Error('PROVEDOR_RECUSADO');
    if (cfg.modo === 'aplicar' && !situacaoEmail(process.env).configurado) throw new Error('EMAIL_RECUSADO');
    let interrompido = false;
    process.once('SIGTERM', () => { interrompido = true; });
    const { Pool, Client } = require('pg');
    const relatorio = await executarCron(cfg, { Pool, Client, conexao: conexaoDaRenovacao(cfg.alvo, process.env), provedor: criarClienteAsaas(asaas.config),
        enviar: criarEnviarEmail(process.env), origem: origemPublica(), interrompido: () => interrompido });
    console.log(JSON.stringify({ ambiente: cfg.ambiente, modo: cfg.modo, rebaixadoParaSimular: cfg.rebaixado, credencialDoServico: cfg.alvo.credencialDoServico,
        agoraInjetado: cfg.agora ? cfg.agora.toISOString() : null, ...relatorio }, null, 2));
    process.exitCode = relatorio.codigo;
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`Renovação agendada recusada/interrompida: ${e instanceof Error ? e.message.slice(0, 120) : 'erro'}`);
        process.exitCode = 1;
    });
}

module.exports = { planejar, executarCron, separarAlertasInformativos, argumentos, conexaoDaRenovacao, politicaCredencialDoServico, CREDENCIAL_DO_SERVICO, STAGING, TRAVA_GLOBAL,
    SQL_TRAVA_MINHA, SERVICOS_TLS_RENOVACAO };
