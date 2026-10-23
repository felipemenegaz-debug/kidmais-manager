/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Reconciliação da cobrança (E8, Asaas SANDBOX): reprocessa eventos PENDENTE/FALHOU e ressincroniza todas as empresas
 * com assinatura vinculada ao provedor, aplicando o estado ATUAL do provedor (mesmas funções do webhook).
 *
 *   node scripts/assinatura-reconciliar.cjs            simulação (padrão): cada item roda em BEGIN … ROLLBACK
 *   node scripts/assinatura-reconciliar.cjs --aplicar  grava (COMMIT por item)
 *   Saída: 0 ciclo sem falhas; 2 itens falhos/recusados; 1 configuração inválida/interrupção.
 *
 * Alvo SEMPRE explícito (nunca DATABASE_URL, nunca .env.local):
 *   KIDMAIS_RECONCILIAR_DATABASE_URL  conexão do banco alvo (não é impressa)
 *   KIDMAIS_RECONCILIAR_ALVO          confirmação literal "<banco>@<host>:<porta>" — tem de bater com a URL e, depois de
 *                                     conectar, com current_database()
 *   ASAAS_AMBIENTE=sandbox, ASAAS_API_KEY ($aact_hmlg_…), ASAAS_WEBHOOK_TOKEN — mesmas regras do serviço
 * Recusados: banco kidmais_manager (proibido pela política) e bancos de produção (produção do Asaas não está
 * autorizada nesta versão). Executar em staging também exige autorização explícita (docs/OPERACAO_AGENTES.md):
 * --aplicar grava em empresa_assinaturas, cobranca_eventos e auditoria.
 *
 * Cron de staging criado em modo aguardando; habilitação depende das validações operacionais.
 *
 * PRODUÇÃO — CONFERÊNCIA (somente simulação): o banco de produção só é aceito com o alvo exato (PRODUCAO), no Render, com
 * KIDMAIS_DEPLOY_ENV=production e ASAAS_AMBIENTE=producao. `--aplicar` é recusado em produção: divergência encontrada sai
 * com código 2 (o cron falha e avisa) e a correção é pelo reenvio do webhook no painel do Asaas ou por pacote autorizado.
 * TLS em produção: a mesma política do serviço (DATABASE_SSL=true obrigatório; lib/db/postgres.ts), nunca mais frouxa.
 *
 * ALARME POR IDADE (D-C4, aprovada por Felipe em 20/10/2026; só na conferência de produção): a saída 2 vem só de item novo
 * ou de item cuja idade cai num dia de aviso (1, 3, 7 e depois a cada 7); os demais saem em `pendentesConhecidos`, sem
 * alarme. Regra, idades e janelas: classificarConferencia e docs/CRON_ASSINATURA_PRODUCAO_20261020.md §5a. Staging inalterado.
 *
 * PEDIDOS DE CANCELAMENTO E DEVOLUÇÃO (089, P2-3 da revisão de 21/10/2026): com a 089 instalada, a conferência lê a fila
 * (somente leitura, sem ids nem dados pessoais) e cada pedido VENCIDO vira um item da mesma regra por idade:
 *   - DEVOLUCAO_PENDENTE: estorno AGUARDANDO_MANUAL/EM_CURSO/SEM_CONFIRMACAO/RECUSADO depois do prazo (arrependimento:
 *     1 h após o pedido; proporcional: fim do dia de prazo_processamento, Brasília);
 *   - ARREPENDIMENTO_PENDENTE: manifestação de arrependimento (097) ainda RECEBIDA depois de 1 h, sem comunicação ao
 *     intermediador (SEM_COMUNICACAO) ou sem conclusão (SEM_CONCLUSAO); o prazo legal é imediato;
 *   - RENOVACAO_NAO_REMOVIDA: remoção da assinatura PENDENTE/SEM_CONFIRMACAO/RECUSADO há mais de 1 h (a renovação pode
 *     continuar gerando cobrança no Asaas).
 * A idade conta do vencimento do prazo (dia 0 = NOVO; 1, 3, 7 e semanais). Em staging o relatório só conta (`encerramentos`).
 */
/** Máximo de eventos PENDENTE/FALHOU lidos por ciclo (os mais antigos primeiro, `eventosPendentes`). */
const LIMITE_EVENTOS = 500;
const BANCOS_PROIBIDOS = new Set(['kidmais_manager', 'kidmais-production']);
const PRODUCAO = Object.freeze({ database: 'kidmais_production', host: 'dpg-dak750gae00c73fudmg0-a', port: 5432 });

/** Conferência de produção: alvo exato + serviço e provedor de produção. Qualquer outra combinação recusa. */
function alvoDeProducao(alvo, env) {
    if (alvo.database.toLowerCase() !== PRODUCAO.database) return false;
    if (alvo.host !== PRODUCAO.host || alvo.port !== PRODUCAO.port || env.RENDER !== 'true'
        || env.KIDMAIS_DEPLOY_ENV?.trim() !== 'production' || env.ASAAS_AMBIENTE?.trim() !== 'producao')
        throw new Error(`Banco ${alvo.database} recusado: conferência de produção exige o alvo exato, o serviço e o provedor de produção.`);
    return true;
}

function hostLocal(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** Valida o alvo sem conectar. Lança Error com mensagem sem a URL. */
function validarAlvo(env) {
    if (env.DATABASE_URL && env.KIDMAIS_RECONCILIAR_DATABASE_URL === env.DATABASE_URL)
        throw new Error('Alvo recusado: use uma conexão própria em KIDMAIS_RECONCILIAR_DATABASE_URL, não a DATABASE_URL do serviço.');
    const bruto = env.KIDMAIS_RECONCILIAR_DATABASE_URL;
    if (!bruto)
        throw new Error('Defina KIDMAIS_RECONCILIAR_DATABASE_URL (DATABASE_URL não é usada).');
    let url;
    try {
        url = new URL(bruto);
    }
    catch {
        throw new Error('KIDMAIS_RECONCILIAR_DATABASE_URL inválida.');
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
        throw new Error('KIDMAIS_RECONCILIAR_DATABASE_URL inválida.');
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!/^[A-Za-z0-9_-]+$/.test(database))
        throw new Error('Nome de banco inválido.');
    if (BANCOS_PROIBIDOS.has(database.toLowerCase()))
        throw new Error(`Banco ${database} recusado: proibido como alvo desta reconciliação (sandbox).`);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port || 5432);
    const esperado = `${database}@${host}:${port}`;
    if (env.KIDMAIS_RECONCILIAR_ALVO !== esperado)
        throw new Error(`Confirme o alvo: defina KIDMAIS_RECONCILIAR_ALVO="${esperado}" (literal).`);
    const alvo = { connectionString: bruto, database, host, port, local: hostLocal(host) };
    return { ...alvo, producao: alvoDeProducao(alvo, env) };
}

/**
 * Na SIMULAÇÃO o banco volta atrás (ROLLBACK), mas uma chamada ao provedor não volta: a remoção de duplicatas (compensação
 * das pendências de contratação) é só contada, nunca executada. Leituras continuam reais para o relatório ser fiel.
 */
function opcoesConexao(alvo, env = {}) {
    const url = new URL(alvo.connectionString);
    const modo = url.searchParams.get('sslmode');
    if (!alvo.local && modo && !['require', 'verify-full', 'verify-ca'].includes(modo)) throw Error('TLS_MODO_RECUSADO');
    for (const chave of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(chave);
    if (alvo.producao) {
        // Mesma política do serviço de produção (lib/db/postgres.ts); sem TLS, recusa.
        if (env.KIDMAIS_RECONCILIAR_TLS !== undefined || env.DATABASE_SSL !== 'true') throw Error('TLS_PRODUCAO_RECUSADO');
        return {connectionString: url.toString(), ssl: {rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', minVersion: 'TLSv1.2'}};
    }
    const politica = env.KIDMAIS_RECONCILIAR_TLS ?? 'verificado';
    if (!['verificado', 'render-interno-criptografado'].includes(politica)) throw Error('TLS_POLITICA_RECUSADA');
    if (politica === 'render-interno-criptografado') {
        // Opt-in operacional: Render não fornece verify-full para seu Postgres interno.
        // Limitado ao cron e banco exatos, dentro da rede privada. Nenhuma configuração global.
        const confirmado = validarAlvo(env);
        if (env.RENDER !== 'true' || env.RENDER_SERVICE_ID !== 'crn-db493i142hec73ahmoe0'
            || env.KIDMAIS_DEPLOY_ENV !== 'staging' || env.ASAAS_AMBIENTE !== 'sandbox'
            || confirmado.host !== 'dpg-daidko3m8hqs73ce4jt0-a' || confirmado.port !== 5432
            || confirmado.database !== 'kidmais_staging_1z91' || alvo.connectionString !== confirmado.connectionString) {
            throw Error('TLS_REDE_PRIVADA_RECUSADA');
        }
        return {connectionString: url.toString(), ssl: {rejectUnauthorized: false, minVersion: 'TLSv1.2'}};
    }
    const ca = env.KIDMAIS_RECONCILIAR_CA_PEM;
    return {connectionString: url.toString(), ssl: alvo.local ? false : {rejectUnauthorized: true, ...(ca ? {ca} : {})}};
}

function provedorDaExecucao(provedor, aplicar, relatorio) {
    if (aplicar)
        return provedor;
    return {
        ...provedor,
        removerAssinatura: async () => {
            relatorio.removeriaNoProvedor = (relatorio.removeriaNoProvedor ?? 0) + 1;
            return { removida: false };
        },
        atualizarValorAssinatura: async () => { throw new Error('Mutação proibida na simulação.'); },
        atualizarValorCobranca: async () => { throw new Error('Mutação proibida na simulação.'); },
        suspenderGeracao: async () => { throw new Error('Mutação proibida na simulação.'); },
    };
}

/**
 * Transação independente para o marcador de exclusão (COMMIT próprio, ANTES do DELETE).
 * Aplicando: uma conexão NOVA por transação (`abrirMarcador`, mesmo alvo conferido), com prazo do lado da aplicação
 * (`comPrazo`, lib/db/transacao-com-prazo.ts): vencido → a conexão é destruída e o resultado é desconhecido; a próxima
 * transação abre outra conexão. Simulação: SAVEPOINT da transação principal, que é desfeita no fim (nada persiste; a
 * simulação nunca chama o DELETE de verdade), sem prazo próprio (vale o statement_timeout da sessão).
 */
function transacaoIndependenteDaExecucao(aplicar, principal, abrirMarcador, comPrazo, prazoMs) {
    if (!aplicar)
        return async (trabalho) => {
            await principal.query('SAVEPOINT kidmais_simulacao_marcador');
            try {
                const r = await trabalho(principal);
                await principal.query('RELEASE SAVEPOINT kidmais_simulacao_marcador');
                return r;
            }
            catch (error) {
                await principal.query('ROLLBACK TO SAVEPOINT kidmais_simulacao_marcador');
                throw error;
            }
        };
    if (typeof abrirMarcador !== 'function' || typeof comPrazo !== 'function' || !(prazoMs > 0))
        throw new Error('Aplicar exige a conexão do marcador de exclusão com prazo.');
    return comPrazo(abrirMarcador, prazoMs);
}

/**
 * Conexão nova para UMA transação do marcador: confere o alvo antes de qualquer escrita; liberar/descartar a encerram
 * (descartar destrói o soquete). O adaptador é REGISTRADO no prazo antes de conectar e de conferir o banco: se a conexão
 * ou o `SELECT current_database()` nunca responderem, o prazo destrói o soquete (não fica conexão aberta para trás).
 */
async function abrirConexaoDoMarcador(Client, alvo, conexaoDeClientePg, registrar = () => undefined, env = {}) {
    const c = new Client({
        ...opcoesConexao(alvo, env),
        connectionTimeoutMillis: 10_000, application_name: 'kidmais-assinatura-reconciliar-marcador',
    });
    c.on('error', () => undefined);
    const conexao = conexaoDeClientePg(c, { liberar: () => { c.end().catch(() => undefined); }, descartar: () => { c.end().catch(() => undefined); } });
    registrar(conexao);
    try {
        await c.connect();
        const id = (await c.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        if (id.db !== alvo.database || (!alvo.local && id.tls !== true))
            throw new Error('Alvo recusado: o banco conectado não é o confirmado.');
    }
    catch (error) {
        conexao.descartar(error);
        throw error;
    }
    return conexao;
}

function argumentos(argv) {
    const extras = argv.filter((a) => a !== '--aplicar');
    if (extras.length)
        throw new Error(`Argumento desconhecido: ${extras[0]}`);
    return { aplicar: argv.includes('--aplicar') };
}

/**
 * Ciclo compartilhado pelo CLI e pela homologacao, com transacao por item. `transacaoIndependente`: marcador de exclusão
 * (conexão própria com prazo ao aplicar; SAVEPOINT na simulação). Sem ela, nenhuma exclusão no provedor acontece.
 */
async function executarCiclo({ client, provedor, aplicar, banco, sinc, transacaoIndependente, idadesDosEventos, pendenciasEncerramento }) {
    const modo = aplicar ? 'APLICAR' : 'SIMULACAO';
    const item = async (trabalho) => {
        await client.query('BEGIN');
        try {
            const r = await trabalho();
            await client.query(aplicar ? 'COMMIT' : 'ROLLBACK');
            return r;
        }
        catch (error) {
            await client.query('ROLLBACK');
            // Recusa de domínio vira ERRO_<código> (ex.: ERRO_FUNDADOR_OFERTA_EXPIRADA): continua alarmando e o atendimento vê a causa.
            const codigo = error instanceof Error && error.name === 'AcessoServiceError' && /^[A-Z0-9_]{1,80}$/.test(String(error.code)) ? String(error.code) : null;
            return { erro: codigo ?? (error instanceof Error ? error.name : 'Erro') };
        }
    };
    const relatorio = { modo, banco, eventos: {}, empresas: {} };
    const provedorUsado = provedorDaExecucao(provedor, aplicar, relatorio);
    const conta = (grupo, chave) => { grupo[chave] = (grupo[chave] ?? 0) + 1; };
    // D-C4 (só quando a conferência de produção passa `idadesDosEventos`): um item por evento e por empresa divergente.
    const itens = [];
    const ids = await sinc.eventosPendentes(client, LIMITE_EVENTOS);
    const idades = idadesDosEventos ? await idadesDosEventos(client, ids) : null;
    for (const eventoId of ids) {
        const r = await item(() => sinc.processarEvento(client, eventoId, { provedor: provedorUsado, transacaoIndependente }));
        const chave = r.erro ? `ERRO_${r.erro}` : r.situacao;
        conta(relatorio.eventos, chave);
        const idade = idades?.eventos?.get(String(eventoId));
        itens.push({ item: idade?.item ?? 'EVENTO', resultado: chave, motivo: r.motivo, recebidoMs: idade?.recebidoMs ?? null });
    }
    for (const empresaId of await sinc.empresasComProvedor(client)) {
        const r = await item(() => sinc.sincronizarEmpresa(client, empresaId, { provedor: provedorUsado }, { tipo: 'RECONCILIACAO' }));
        const chave = r.erro ? `ERRO_${r.erro}` : r.resultado === 'SINCRONIZADA' ? (r.mudou ? `MUDOU_${r.antes}_PARA_${r.depois}` : 'SEM_MUDANCA') : r.resultado;
        conta(relatorio.empresas, chave);
        if (chave !== 'SEM_MUDANCA') itens.push({ item: 'EMPRESA', resultado: chave, motivo: r.motivo, recebidoMs: null });
    }
    // 089/097: pedidos de cancelamento/devolução e manifestações de arrependimento vencidos (fora das transações por item; só leitura).
    if (pendenciasEncerramento) {
        relatorio.encerramentos = {};
        for (const p of await pendenciasEncerramento(client)) {
            conta(relatorio.encerramentos, `${p.item}_${p.resultado}`);
            itens.push({ item: p.item, resultado: p.resultado, motivo: p.motivo, recebidoMs: p.recebidoMs });
        }
    }
    // P2-2: a lista traz só os LIMITE_EVENTOS mais antigos; no limite, um evento novo pode ter ficado de fora → alarma.
    if (idades) Object.assign(relatorio, classificarConferencia(itens, idades.agoraMs, { listaNoLimite: ids.length >= LIMITE_EVENTOS }));

    relatorio.incompleto = Object.entries(relatorio.eventos).some(([k, n]) => n > 0 && (k === 'FALHOU' || k.startsWith('ERRO_')))
        || Object.entries(relatorio.empresas).some(([k, n]) => n > 0 && (k === 'RECUSADA' || k === 'SEM_CONFIRMACAO' || k.startsWith('ERRO_')));
    // Conferência: evento de pagamento ainda não concluído ou empresa cujo estado mudaria = banco diverge do provedor.
    relatorio.divergente = Object.values(relatorio.eventos).some((n) => n > 0)
        || Object.entries(relatorio.empresas).some(([k, n]) => n > 0 && k !== 'SEM_MUDANCA');
    return relatorio;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fila de pedidos de cancelamento e devolução (089) vencidos — somente leitura; `$1` fixa o instante (testes), padrão = relógio do banco.
const SQL_PENDENCIAS_ENCERRAMENTO = `SELECT item, resultado, motivo, (extract(epoch FROM limite) * 1000)::float8 AS limite_ms FROM (
    SELECT 'DEVOLUCAO_PENDENTE' AS item, estorno_situacao AS resultado, tipo AS motivo,
           CASE WHEN tipo = 'ARREPENDIMENTO_7_DIAS' THEN solicitado_em + interval '1 hour'
                ELSE ((prazo_processamento + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') END AS limite
      FROM assinatura_encerramentos WHERE estorno_situacao IN ('AGUARDANDO_MANUAL', 'EM_CURSO', 'SEM_CONFIRMACAO', 'RECUSADO')
    UNION ALL
    SELECT 'RENOVACAO_NAO_REMOVIDA', cancelamento_provedor, tipo, solicitado_em + interval '1 hour'
      FROM assinatura_encerramentos WHERE cancelamento_provedor IN ('PENDENTE', 'SEM_CONFIRMACAO', 'RECUSADO')
  ) x WHERE limite <= coalesce($1::timestamptz, clock_timestamp()) ORDER BY limite`;
// 097: manifestações de arrependimento ainda RECEBIDAS depois de 1 h (o prazo é imediato) — somente leitura.
const SQL_PENDENCIAS_ARREPENDIMENTO = `SELECT 'ARREPENDIMENTO_PENDENTE' AS item,
    CASE WHEN intermediador_comunicado_em IS NULL THEN 'SEM_COMUNICACAO' ELSE 'SEM_CONCLUSAO' END AS resultado, canal AS motivo,
    (extract(epoch FROM solicitado_em + interval '1 hour') * 1000)::float8 AS limite_ms
  FROM assinatura_arrependimentos WHERE situacao = 'RECEBIDO' AND solicitado_em + interval '1 hour' <= coalesce($1::timestamptz, clock_timestamp())
  ORDER BY solicitado_em`;
async function lerPendenciasEncerramento(client, instanteMs = null) {
    const instante = [instanteMs === null ? null : new Date(instanteMs).toISOString()];
    const linhas = [];
    if ((await client.query("SELECT to_regclass('public.assinatura_encerramentos') IS NOT NULL AS ok")).rows[0]?.ok === true)
        linhas.push(...(await client.query(SQL_PENDENCIAS_ENCERRAMENTO, instante)).rows);
    if ((await client.query("SELECT to_regclass('public.assinatura_arrependimentos') IS NOT NULL AS ok")).rows[0]?.ok === true)
        linhas.push(...(await client.query(SQL_PENDENCIAS_ARREPENDIMENTO, instante)).rows);
    return linhas.map((l) => ({ item: l.item, resultado: l.resultado, motivo: l.motivo, recebidoMs: Number(l.limite_ms) })).sort((a, b) => a.recebidoMs - b.recebidoMs);
}

// ---------------------------------------------------------------------------------------------------------------------
// D-C4 — alarme por idade na conferência de PRODUÇÃO (sem estado: nada é gravado; a idade vem do próprio banco)
// ---------------------------------------------------------------------------------------------------------------------
/** Hora UTC da agenda do cron de produção (`0 9 * * *`, infra/render-assinatura-cron-production.yaml; teste amarra os dois). */
const HORA_CRON_UTC = 9;
const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;
/** Execução até 1 h ANTES das 09:00 (relógio adiantado, disparo manual cedo) ainda conta como a do dia: não perde o marco. */
const ANTECIPACAO_TOLERADA_MS = HORA_MS;

/**
 * Referência do dia da execução: as 09:00:00 UTC (horário nominal do cron) mais recentes, com a antecipação tolerada.
 * Toda execução entre 08:00 UTC de um dia e 08:00 UTC do dia seguinte usa a MESMA referência; execuções diárias
 * consecutivas usam referências exatamente 24 h distantes, qualquer que seja o atraso de cada uma (< 23 h).
 */
function referenciaDoDia(agoraMs) {
    const deslocamento = HORA_CRON_UTC * HORA_MS;
    return Math.floor((agoraMs + ANTECIPACAO_TOLERADA_MS - deslocamento) / DIA_MS) * DIA_MS + deslocamento;
}

/** Dia do item = dias completos entre `recebido_em` e a referência (recebido depois dela = 0). Sem os dois números = null. */
function diaDoItem(recebidoMs, referenciaMs) {
    if (typeof recebidoMs !== 'number' || typeof referenciaMs !== 'number' || !Number.isFinite(recebidoMs) || !Number.isFinite(referenciaMs))
        return null;
    return Math.max(0, Math.floor((referenciaMs - recebidoMs) / DIA_MS));
}

/** Dias de aviso: 0 (novo), 1, 3, 7 e depois a cada 7 (14, 21, 28…). */
const diaDeAviso = (dia) => dia === 0 || dia === 1 || dia === 3 || (dia >= 7 && dia % 7 === 0);
function proximoDiaDeAviso(dia) {
    let d = dia + 1;
    while (!diaDeAviso(d)) d++;
    return d;
}

/** Só o código do motivo (ex.: `REVISAO_HUMANA: ASSINATURAS_AMBIGUAS`): maiúsculas, dígitos e `_`; nada de ids, nomes ou texto livre. */
function motivoSeguro(motivo) {
    if (typeof motivo !== 'string') return null;
    const codigos = [];
    for (const parte of motivo.split(': ').slice(0, 2)) {
        if (!/^[A-Z][A-Z0-9_]{0,59}$/.test(parte)) break;
        codigos.push(parte);
    }
    return codigos.length ? codigos.join(': ') : null;
}

/**
 * Falha DESTA execução — a conferência não conseguiu verificar o item hoje, então não é pendência antiga e alarma sempre:
 * exceção no item (ERRO_*), provedor fora (PROVEDOR_INDISPONIVEL), lista do provedor acima do limite conferido
 * (LISTA_INCOMPLETA), provedor sem as operações da reconciliação (PROVEDOR_SEM_ESCRITA) ou erro interno (ERRO_INTERNO).
 */
const MOTIVOS_ERRO_DA_EXECUCAO = /^(?:PROVEDOR_INDISPONIVEL|LISTA_INCOMPLETA|PROVEDOR_SEM_ESCRITA|ERRO_INTERNO)(?::|$)/;
const erroDaExecucao = (i) => i.resultado.startsWith('ERRO_') || MOTIVOS_ERRO_DA_EXECUCAO.test(typeof i.motivo === 'string' ? i.motivo : '');

/** Item de alarme da própria lista (não é evento nem empresa: fica fora da conferência de contagem). */
const ITEM_LISTA = 'LISTA_EVENTOS';

/**
 * Classifica os itens da conferência de produção (D-C4). Saída: `alarme.itens` (cada um com o aviso que o fez alarmar) e
 * `pendentesConhecidos` (idade, motivo e próximo dia de aviso). Nenhum id, evento_id, empresa ou texto livre sai daqui.
 *   - lista de eventos no limite (`listaNoLimite`) → alarma (LISTA_LIMITE_ATINGIDO: pode haver evento novo fora da lista);
 *   - erro desta execução (ERRO_*, PROVEDOR_INDISPONIVEL, LISTA_INCOMPLETA, PROVEDOR_SEM_ESCRITA, ERRO_INTERNO) → alarma
 *     (ERRO_NESTA_EXECUCAO);
 *   - empresa com resultado ≠ SEM_MUDANCA → alarma sempre (EMPRESA_SEM_IDADE: não há no banco quando a divergência começou);
 *   - evento/pendência sem `recebido_em` legível (ou sem `agora`) → alarma (SEM_IDADE: falha fechada);
 *   - dia 0 → NOVO; dias 1, 3, 7, 14, 21… → DIA_n; os demais → pendentesConhecidos (sem alarme).
 */
function classificarConferencia(itens, agoraMs, { listaNoLimite = false } = {}) {
    const referenciaMs = typeof agoraMs === 'number' && Number.isFinite(agoraMs) ? referenciaDoDia(agoraMs) : null;
    const alarmes = [];
    if (listaNoLimite)
        alarmes.push({ item: ITEM_LISTA, resultado: `LIMITE_${LIMITE_EVENTOS}`, motivo: 'LISTA_LIMITE_ATINGIDO', aviso: 'LISTA_LIMITE_ATINGIDO' });
    const pendentesConhecidos = [];
    for (const i of itens) {
        const base = { item: i.item, resultado: i.resultado, motivo: motivoSeguro(i.motivo) };
        if (erroDaExecucao(i)) { alarmes.push({ ...base, aviso: 'ERRO_NESTA_EXECUCAO' }); continue; }
        if (i.item === 'EMPRESA') { alarmes.push({ ...base, aviso: 'EMPRESA_SEM_IDADE' }); continue; }
        const dia = diaDoItem(i.recebidoMs, referenciaMs);
        if (dia === null) { alarmes.push({ ...base, aviso: 'SEM_IDADE' }); continue; }
        if (diaDeAviso(dia)) alarmes.push({ ...base, idadeDias: dia, aviso: dia === 0 ? 'NOVO' : `DIA_${dia}` });
        else pendentesConhecidos.push({ ...base, idadeDias: dia, proximoAvisoDia: proximoDiaDeAviso(dia) });
    }
    return {
        alarme: { regra: 'D-C4', referencia: referenciaMs === null ? null : new Date(referenciaMs).toISOString(), itens: alarmes },
        pendentesConhecidos,
    };
}

/**
 * Idade dos eventos listados (leitura, fora das transações por item). `recebido_em` é NOT NULL, gravado pelo banco na
 * inserção e imutável (guarda da 068); cada pendência interna é uma linha nova (evento_id único: UUID aleatório, ou o id da
 * intenção em `kidmais:vinculo:`) e um evento concluído não reabre — a idade nunca é reiniciada. `agora` é o relógio do banco, o mesmo de `recebido_em`.
 */
const SQL_IDADES_EVENTOS = `SELECT id::text AS id, (extract(epoch FROM recebido_em) * 1000)::float8 AS recebido_ms,
    CASE WHEN tipo <> 'KIDMAIS_RECONCILIAR_CONTRATACAO' OR evento_id NOT LIKE 'kidmais:%' THEN 'EVENTO_ASAAS'
         WHEN evento_id LIKE 'kidmais:criacao:%' THEN 'PENDENCIA_CRIACAO'
         WHEN evento_id LIKE 'kidmais:contratacao:%' THEN 'PENDENCIA_CONTRATACAO'
         WHEN evento_id LIKE 'kidmais:vinculo:%' THEN 'PENDENCIA_VINCULO'
         WHEN evento_id LIKE 'kidmais:remocao:%' THEN 'MARCADOR_REMOCAO'
         ELSE 'PENDENCIA_INTERNA' END AS item
  FROM cobranca_eventos WHERE id = ANY($1::uuid[])`;
async function lerIdadesDosEventos(client, ids) {
    const agora = (await client.query('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS agora_ms')).rows[0];
    const eventos = new Map();
    if (ids.length) {
        for (const l of (await client.query(SQL_IDADES_EVENTOS, [ids])).rows)
            eventos.set(String(l.id), { item: l.item, recebidoMs: l.recebido_ms === null ? null : Number(l.recebido_ms) });
    }
    return { agoraMs: agora ? Number(agora.agora_ms) : null, eventos };
}

/**
 * Gratuidade da Kidmais (leitura): exatamente uma empresa `kidmais`, ATIVA, sem situação comercial, contratação ou vaga
 * Fundador. Qualquer desvio é violação (o produto só cria assinatura no cadastro público, para empresa nova).
 */
const SQL_KIDMAIS = `SELECT count(*)::int AS empresas,
    count(*) FILTER (WHERE e.status = 'ATIVA')::int AS ativas,
    (SELECT count(*) FROM empresa_assinaturas a JOIN empresas k ON k.id = a.empresa_id WHERE k.codigo = 'kidmais')::int AS assinaturas,
    (SELECT count(*) FROM assinatura_contratacoes c JOIN empresas k ON k.id = c.empresa_id WHERE k.codigo = 'kidmais')::int AS contratacoes,
    (SELECT count(*) FROM assinatura_fundadores f JOIN empresas k ON k.id = f.empresa_id WHERE k.codigo = 'kidmais')::int AS fundadores,
    (SELECT count(*) FROM assinatura_isencoes i JOIN empresas k ON k.id = i.empresa_id WHERE k.codigo = 'kidmais')::int AS isencoes
  FROM empresas e WHERE e.codigo = 'kidmais'`;
async function conferirKidmais(client) {
    const k = (await client.query(SQL_KIDMAIS)).rows[0];
    const violada = k.empresas !== 1 || k.ativas !== 1 || k.assinaturas !== 0 || k.contratacoes !== 0 || k.fundadores !== 0;
    return { ...k, isenta: k.isencoes === 1, violada };
}

/**
 * Produção: só conferência. Saída 2 com gratuidade da Kidmais violada (sempre) ou, com a classificação D-C4 presente, com
 * algum item em alarme; pendências antigas fora dos dias de aviso saem 0 e ficam em `pendentesConhecidos`. Sem a
 * classificação (ou com contagem que não fecha), vale a regra anterior: divergência ou falha = 2 (falha fechada).
 * Staging (producao=false): inalterado — 2 com item falho/recusado ou Kidmais violada.
 */
function codigoDeSaida(relatorio, producao) {
    if (relatorio.kidmais?.violada) return 2;
    if (producao && Array.isArray(relatorio.alarme?.itens) && Array.isArray(relatorio.pendentesConhecidos)) {
        const soma = (grupo, filtro = () => true) => Object.entries(grupo ?? {}).reduce((t, [k, n]) => t + (filtro(k) ? n : 0), 0);
        const total = soma(relatorio.eventos) + soma(relatorio.empresas, (k) => k !== 'SEM_MUDANCA') + soma(relatorio.encerramentos);
        const classificados = relatorio.alarme.itens.filter((i) => i.item !== ITEM_LISTA).length + relatorio.pendentesConhecidos.length;
        if (classificados !== total) return 2;
        return relatorio.alarme.itens.length > 0 ? 2 : 0;
    }
    if (relatorio.incompleto) return 2;
    return producao && relatorio.divergente ? 2 : 0;
}

async function main() {
    const { aplicar } = argumentos(process.argv.slice(2));
    const alvo = validarAlvo(process.env);
    if (alvo.producao && aplicar)
        throw new Error('Produção aceita só conferência (sem --aplicar): corrija pelo reenvio do webhook no Asaas ou por pacote autorizado.');
    const asaas = await import('../lib/assinatura/asaas.ts');
    const sinc = await import('../lib/assinatura/sincronizacao.ts');
    const estado = asaas.configuracaoAsaas(process.env);
    if (!estado.ligado)
        throw new Error(asaas.explicarDesligado(estado.motivo));
    const provedor = asaas.criarClienteAsaas(estado.config);
    const { Client } = require('pg');
    const client = new Client({
        ...opcoesConexao(alvo, process.env),
        connectionTimeoutMillis: 10_000, application_name: 'kidmais-assinatura-reconciliar',
    });
    client.on('error', () => undefined);
    await client.connect();
    // Aplicando: o marcador de exclusão usa uma conexão nova por transação, com prazo do lado da aplicação.
    const { transacaoComPrazo, conexaoDeClientePg } = await import('../lib/db/transacao-com-prazo.ts');
    const { PRAZO_TRANSACAO_INDEPENDENTE_MS } = await import('../lib/assinatura/reconciliacao-contratacao.ts');
    const abrirMarcador = (registrar) => abrirConexaoDoMarcador(Client, alvo, conexaoDeClientePg, registrar, process.env);
    try {
        const id = (await client.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        if (id.db !== alvo.database || (!alvo.local && id.tls !== true))
            throw new Error('Alvo recusado: o banco conectado não é o confirmado.');
        await client.query("SET statement_timeout = '60s'");
        await client.query("SET lock_timeout = '5s'");
        if (!(await client.query("SELECT to_regclass('public.cobranca_eventos') IS NOT NULL AS ok")).rows[0].ok)
            throw new Error('Banco sem a 068 (cobranca_eventos): nada a reconciliar.');
        const transacaoIndependente = transacaoIndependenteDaExecucao(aplicar, client, abrirMarcador, transacaoComPrazo, PRAZO_TRANSACAO_INDEPENDENTE_MS);
        // D-C4: só a conferência de produção classifica por idade; staging (simular/aplicar) segue sem classificação.
        const idadesDosEventos = alvo.producao ? lerIdadesDosEventos : undefined;
        const relatorio = await executarCiclo({ client, provedor, aplicar, banco: alvo.database, sinc, transacaoIndependente, idadesDosEventos,
            pendenciasEncerramento: lerPendenciasEncerramento });
        relatorio.kidmais = await conferirKidmais(client);
        // Staging: saída 2 com relatório incompleto (inclui ADIADA/REVISAO_HUMANA da #147) ou gratuidade violada.
        // Produção: gratuidade violada ou item em alarme pela regra D-C4 (codigoDeSaida).
        process.exitCode = codigoDeSaida(relatorio, alvo.producao);
        console.log(JSON.stringify(relatorio, null, 2));
        if (!aplicar)
            console.log('Simulação: nada foi gravado. Use --aplicar (com autorização para o alvo) para gravar.');
    }
    finally {
        await client.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Reconciliação recusada/interrompida: ${error instanceof Error ? error.message : 'erro'}`);
        process.exitCode = 1;
    });
}

module.exports = { validarAlvo, argumentos, provedorDaExecucao, executarCiclo, opcoesConexao, codigoDeSaida, conferirKidmais, SQL_KIDMAIS, BANCOS_PROIBIDOS, PRODUCAO, transacaoIndependenteDaExecucao, abrirConexaoDoMarcador,
    HORA_CRON_UTC, LIMITE_EVENTOS, referenciaDoDia, diaDoItem, diaDeAviso, classificarConferencia, lerIdadesDosEventos, SQL_IDADES_EVENTOS,
    lerPendenciasEncerramento, SQL_PENDENCIAS_ENCERRAMENTO, SQL_PENDENCIAS_ARREPENDIMENTO, motivoSeguro };
