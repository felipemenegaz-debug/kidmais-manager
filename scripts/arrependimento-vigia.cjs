/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Vigia das manifestações de arrependimento (097; revisão 8da88ba, P2-C3). SOMENTE LEITURA, sem provedor, sem e-mail:
 * lê as manifestações ainda RECEBIDAS e sai com código 2 quando há algo a fazer, para que o cron falhe e avise (mesmo
 * canal de alarme do cron de conferência). Feito para rodar a cada 15 minutos (proposta em
 * infra/render-arrependimento-vigia-production.yaml, NÃO aplicada).
 *
 *   AVISO_INTERNO_NAO_ENTREGUE  aviso [AÇÃO HOJE] FALHOU / NAO_CONFIGURADO, ou ainda PENDENTE 5 min depois do registro
 *                               (processo interrompido): alarma já, sem esperar 1 h — ninguém foi avisado;
 *   VENCIDO_SEM_COMUNICACAO     RECEBIDA há 1 h ou mais sem comunicação ao intermediador registrada;
 *   VENCIDO_SEM_CONCLUSAO       RECEBIDA há 1 h ou mais, comunicada, sem conclusão registrada.
 * Latência máxima do alarme = limiar + intervalo do agendamento (1 h + 15 min; aviso não entregue: 5 + 15 min). O
 * limiar de 1 h NÃO é prazo de atendimento: é o ponto em que a pendência passa a alarmar a cada execução.
 *
 * Alvo e TLS: as MESMAS regras da conferência de pagamentos (scripts/assinatura-reconciliar.cjs: validarAlvo e
 * opcoesConexao; KIDMAIS_RECONCILIAR_DATABASE_URL + KIDMAIS_RECONCILIAR_ALVO literal; nunca DATABASE_URL; kidmais_manager
 * recusado). KIDMAIS_VIGIA_MODO=aguardando (padrão) sai 0 sem conectar; =conferir executa.
 * Saída: 0 nada a fazer (ou aguardando / 097 ausente); 2 alarme; 1 configuração inválida ou interrupção. Relatório só com
 * contagens e idades (sem protocolo, empresa, pessoa ou e-mail).
 */
const { validarAlvo, opcoesConexao } = require('./assinatura-reconciliar.cjs');

const LIMIAR_MS = 60 * 60_000;
const TOLERANCIA_AVISO_MS = 5 * 60_000;
const SQL_VIGIA = `SELECT aviso_interno, intermediador_comunicado_em IS NOT NULL AS comunicado,
    (extract(epoch FROM solicitado_em) * 1000)::float8 AS solicitado_ms
  FROM assinatura_arrependimentos WHERE situacao = 'RECEBIDO' ORDER BY solicitado_em`;

/** Classificação pura (testável sem banco): uma manifestação pode entrar em mais de um tipo. */
function avaliarVigia(linhas, agoraMs) {
    const tipos = new Map();
    const somar = (tipo, idadeMs) => {
        const t = tipos.get(tipo) ?? { tipo, quantidade: 0, maisAntigaMin: 0 };
        t.quantidade += 1;
        t.maisAntigaMin = Math.max(t.maisAntigaMin, Math.floor(idadeMs / 60_000));
        tipos.set(tipo, t);
    };
    for (const l of linhas) {
        const idade = agoraMs - Number(l.solicitado_ms);
        if (['FALHOU', 'NAO_CONFIGURADO'].includes(l.aviso_interno) || (l.aviso_interno === 'PENDENTE' && idade >= TOLERANCIA_AVISO_MS))
            somar('AVISO_INTERNO_NAO_ENTREGUE', idade);
        if (idade >= LIMIAR_MS) somar(l.comunicado ? 'VENCIDO_SEM_CONCLUSAO' : 'VENCIDO_SEM_COMUNICACAO', idade);
    }
    const alarmes = [...tipos.values()].sort((a, b) => a.tipo.localeCompare(b.tipo));
    return { recebidas: linhas.length, alarmes, codigo: alarmes.length ? 2 : 0 };
}

/** Leitura em transação READ ONLY; sem a 097: nada a vigiar. */
async function lerVigia(client, instanteMs = null) {
    await client.query('BEGIN TRANSACTION READ ONLY');
    try {
        const instalado = (await client.query("SELECT to_regclass('public.assinatura_arrependimentos') IS NOT NULL AS ok")).rows[0]?.ok === true;
        const agoraMs = instanteMs ?? Number((await client.query('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms')).rows[0].ms);
        const linhas = instalado ? (await client.query(SQL_VIGIA)).rows : [];
        return { instalado, agora: new Date(agoraMs).toISOString(), ...avaliarVigia(linhas, agoraMs) };
    }
    finally { await client.query('ROLLBACK'); }
}

function modo(env) {
    const m = env.KIDMAIS_VIGIA_MODO ?? 'aguardando';
    if (!['aguardando', 'conferir'].includes(m)) throw new Error('KIDMAIS_VIGIA_MODO inválido (aguardando | conferir).');
    return m;
}

async function main() {
    if (modo(process.env) === 'aguardando') { console.log(JSON.stringify({ estado: 'AGUARDANDO_HABILITACAO', conectou: false })); return; }
    const alvo = validarAlvo(process.env);
    const { Client } = require('pg');
    const client = new Client({ ...opcoesConexao(alvo, process.env), connectionTimeoutMillis: 10_000, application_name: 'kidmais-arrependimento-vigia' });
    client.on('error', () => undefined);
    await client.connect();
    try {
        const id = (await client.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        if (id.db !== alvo.database || (!alvo.local && id.tls !== true)) throw new Error('Alvo recusado: o banco conectado não é o confirmado.');
        await client.query("SET statement_timeout = '30s'");
        const r = await lerVigia(client);
        console.log(JSON.stringify({ estado: r.instalado ? 'CONFERIDO' : '097_AUSENTE', ...r }, null, 2));
        process.exitCode = r.codigo;
    }
    finally { await client.end(); }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Vigia recusado/interrompido: ${error instanceof Error ? error.message : 'erro'}`);
        process.exitCode = 1;
    });
}

module.exports = { avaliarVigia, lerVigia, modo, SQL_VIGIA, LIMIAR_MS, TOLERANCIA_AVISO_MS };
