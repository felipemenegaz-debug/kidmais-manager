/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Job dos avisos por e-mail da assinatura (087): enfileira os avisos por tempo (fim do teste, pagamento pendente,
 * somente leitura, suspensão próxima, suspensão) e envia os pendentes (inclusive os de pagamento confirmado e
 * cancelamento gravados pela sincronização). Não consulta o Asaas. Não agenda nada no Render.
 *
 *   node scripts/assinatura-avisos.cjs            simulação (padrão): transações READ ONLY, nada gravado nem enviado
 *   node scripts/assinatura-avisos.cjs --aplicar  grava e envia, em UM destes modos (qualquer outra combinação recusa
 *                                                 antes de conectar):
 *     APLICAR_LOCAL_EMAIL_ARQUIVO  banco local isolado + EMAIL_PROVIDER=arquivo (prova local, desde 20/10);
 *     APLICAR_STAGING / APLICAR_PRODUCAO  (rodada 2 de 02/11, P2-2 do Astra) só no serviço do Render
 *       (RENDER=true), no ambiente declarado (KIDMAIS_DEPLOY_ENV), com o alvo exato do banco daquele ambiente
 *       (production: a mesma trava de alvo do cron de reconciliação, PRODUCAO de assinatura-reconciliar.cjs),
 *       EMAIL_PROVIDER=resend configurado, ASSINATURA_AVISOS_EMAIL=ligado, KIDMAIS_AVISOS_MODO=aplicar e
 *       KIDMAIS_AVISOS_SCHEMA_VALIDADO=087 (só depois da 087 aplicada e conferida naquele banco).
 *   KIDMAIS_AVISOS_MODO=aguardando  → sai 0 sem conectar (estado inicial do cron, como o C1 da reconciliação);
 *   KIDMAIS_AVISOS_MODO=simular     → simulação (só leitura) MESMO com --aplicar, para o cron passar por aguardando →
 *                                      simular → aplicar mudando só a env; qualquer outro valor é recusado.
 *   A URL do alvo não pode ter fragmento nem parâmetros além dos de TLS: `?host=`/`?port=` trocariam o servidor depois
 *   da validação (o driver pg dá precedência a eles). Porta e usuário têm de ser explícitos (sem eles o driver lê PGPORT/
 *   PGUSER do ambiente). A conexão é montada só com host/porta/banco do alvo validado, nunca pela string. Recusado
 *   antes de conectar, em qualquer modo que conecte.
 *   Saída: 0 ciclo sem pendência humana; 2 aviso INCERTO, envio falho ou erro; 1 configuração recusada/interrupção/sem a 087.
 *   Falha (03/11/2026, r2): além da mensagem genérica, registra {etapa, tipo, codigo, motivo} só com valores de listas
 *   fechadas ou formatos restritos; o motivo é um código fechado (MOTIVOS), nunca o texto da mensagem. Falha no corpo e no
 *   encerramento do pool: a do corpo é a principal e a do encerramento vai separada em `secundaria`.
 *
 * Alvo SEMPRE explícito, mesmas regras da reconciliação (scripts/assinatura-reconciliar.cjs → validarAlvo):
 * KIDMAIS_RECONCILIAR_DATABASE_URL + KIDMAIS_RECONCILIAR_ALVO; nunca DATABASE_URL nem .env.local; kidmais_manager
 * recusado. TLS pela mesma política (opcoesConexao: em produção DATABASE_SSL=true obrigatório). Executar em qualquer
 * banco exige autorização explícita de Felipe (docs/OPERACAO_AGENTES.md). Frequência recomendada do cron: a cada 12 h
 * (uma tentativa falha é repetida dentro da janela de 23 h da chave idempotente; P3 da revisão). Ver
 * docs/AVISOS_ASSINATURA_EMAIL_20261020.md e docs/RECORTE_COBRANCA_PRODUCTION_20261102.md.
 */
const { validarAlvo, argumentos, opcoesConexao } = require('./assinatura-reconciliar.cjs');
const { parse: parseConexaoDoDriver } = require('pg-connection-string');

const STAGING = Object.freeze({ database: 'kidmais_staging_1z91', host: 'dpg-daidko3m8hqs73ce4jt0-a', port: 5432 });
const SCHEMA_EXIGIDO = '087';
const MODOS = new Set(['', 'aguardando', 'simular', 'aplicar']);
/** Únicos parâmetros de URL tolerados: os de TLS, em minúsculas (os mesmos nomes que opcoesConexao remove/valida). Qualquer outro (host, port, hostaddr,
 * dbname, user, password, options, application_name…) substituiria o destino DEPOIS da validação do alvo, porque o driver pg
 * dá precedência a eles (P2 #5 do Astra, 03/11/2026). */
const PARAMETROS_TLS = new Set(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']);

/** Recusa, sem imprimir a URL, fragmento ou parâmetro capaz de redirecionar a conexão. validarAlvo já garantiu URL válida. */
function recusarParametrosDeDestino(bruto) {
    const url = new URL(bruto);
    if (url.hash) throw new Error('URL do alvo recusada: fragmento não é permitido.');
    // P2 #7 (Astra r3): sem porta explícita o driver completa com PGPORT do ambiente; a validação teria assumido 5432.
    if (!url.port) throw new Error('URL do alvo recusada: a porta deve ser explícita (PGPORT do ambiente não é aceita).');
    // P3 #8 (Astra r4): o driver trata 0 como ausente e cairia em PGPORT; só porta inteira entre 1 e 65535.
    if (!/^\d{1,5}$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535) throw new Error('URL do alvo recusada: porta fora de 1..65535.');
    if (!url.username) throw new Error('URL do alvo recusada: o usuário deve ser explícito (PGUSER do ambiente não é aceito).');
    const estranhos = [...new Set([...url.searchParams.keys()])].filter((k) => !PARAMETROS_TLS.has(k));
    if (estranhos.length)
        throw new Error(`URL do alvo recusada: parâmetro(s) ${estranhos.map((k) => k.replace(/[^A-Za-z0-9_-]/g, '?')).join(', ')} podem substituir o destino validado.`);
}

const ligado = (env) => env.ASSINATURA_AVISOS_EMAIL?.trim().toLowerCase() === 'ligado';

/** Decide o modo sem conectar. Lança Error (sem URL) em qualquer combinação não prevista. */
function configuracaoExecucao(env, argv) {
    const { aplicar } = argumentos(argv);
    const modoEnv = (env.KIDMAIS_AVISOS_MODO ?? '').trim();
    if (!MODOS.has(modoEnv)) throw new Error('KIDMAIS_AVISOS_MODO desconhecido: use aguardando, simular ou aplicar.');
    if (modoEnv === 'aguardando') return { aguardando: true, aplicar: false, alvo: null, modo: 'AGUARDANDO_HABILITACAO' };
    const alvo = validarAlvo(env);
    recusarParametrosDeDestino(env.KIDMAIS_RECONCILIAR_DATABASE_URL);
    // `simular` vale mesmo com o --aplicar fixo do startCommand do cron (P3 #6): só leitura, nenhum envio.
    if (!aplicar || modoEnv === 'simular') return { aguardando: false, aplicar: false, alvo, modo: 'SIMULACAO_SEM_ESCRITA' };
    if (!ligado(env)) throw new Error('Avisos desligados: defina ASSINATURA_AVISOS_EMAIL=ligado para aplicar.');
    if (alvo.local) {
        if (env.EMAIL_PROVIDER !== 'arquivo') throw new Error('Aplicação local exige banco local isolado e e-mail em arquivo.');
        return { aguardando: false, aplicar: true, alvo, modo: 'APLICAR_LOCAL_EMAIL_ARQUIVO' };
    }
    // Remoto: só o serviço do Render, com liberação explícita, provedor de e-mail real e schema conferido.
    if (env.RENDER !== 'true' || modoEnv !== 'aplicar')
        throw new Error('Aplicação remota exige o serviço do Render e KIDMAIS_AVISOS_MODO=aplicar.');
    if (env.KIDMAIS_AVISOS_SCHEMA_VALIDADO?.trim() !== SCHEMA_EXIGIDO)
        throw new Error(`Schema não liberado: defina KIDMAIS_AVISOS_SCHEMA_VALIDADO=${SCHEMA_EXIGIDO} só depois da 087 aplicada e conferida.`);
    if (env.EMAIL_PROVIDER !== 'resend') throw new Error('Aplicação remota exige EMAIL_PROVIDER=resend.');
    const ambiente = env.KIDMAIS_DEPLOY_ENV?.trim();
    if (ambiente === 'production') {
        if (!alvo.producao) throw new Error('Alvo de produção recusado: production exige o alvo exato de kidmais_production.');
        return { aguardando: false, aplicar: true, alvo, modo: 'APLICAR_PRODUCAO' };
    }
    if (ambiente === 'staging') {
        if (alvo.producao || alvo.database !== STAGING.database || alvo.host !== STAGING.host || alvo.port !== STAGING.port)
            throw new Error('Alvo de staging recusado: staging exige o alvo exato de kidmais_staging_1z91.');
        return { aguardando: false, aplicar: true, alvo, modo: 'APLICAR_STAGING' };
    }
    throw new Error('Ambiente recusado: KIDMAIS_DEPLOY_ENV deve ser staging ou production para aplicar fora do local.');
}

/**
 * Parâmetros efetivos da conexão, montados SÓ a partir do alvo validado: host, porta e banco explícitos (o driver só lê
 * PGHOST/PGPORT/PGDATABASE/PGUSER quando o campo falta), credenciais lidas pelo parser do próprio driver e conferidas
 * contra o alvo, TLS por opcoesConexao (mesma política da reconciliação). Nunca repassa a connectionString ao Pool.
 */
function parametrosDeConexao(alvo, env) {
    recusarParametrosDeDestino(alvo.connectionString);
    // P3 #9 (Astra r4): a política TLS (opcoesConexao) decide o ssl e devolve a URL sem os parâmetros TLS; só ESSA URL vai ao
    // parser do driver, que senão leria sslcert/sslkey/sslrootcert do disco ou exigiria CA em verify-ca+uselibpqcompat.
    const { connectionString: limpa, ssl } = opcoesConexao(alvo, env);
    // P3 #3 (Astra, log da falha r1): exceção do parser (ex.: URIError em usuário/senha com escape inválido) é texto de módulo
    // externo; troca por mensagem própria fixa.
    let lido;
    try { lido = parseConexaoDoDriver(limpa); } catch { throw new Error('URL do alvo ilegível.'); }
    if (!Number.isInteger(alvo.port) || alvo.port < 1 || alvo.port > 65535) throw new Error('Alvo com porta fora de 1..65535.');
    if ((lido.host ?? '').toLowerCase() !== alvo.host || Number(lido.port) !== alvo.port || lido.database !== alvo.database)
        throw new Error('URL do alvo diverge do alvo validado (host, porta ou banco).');
    if (!lido.user) throw new Error('URL do alvo sem usuário.');
    return { host: alvo.host, port: alvo.port, database: alvo.database, user: lido.user, password: lido.password ?? undefined, ssl };
}

/** Etapas do job, na ordem. A falha registra a etapa para o diagnóstico não depender do log do banco. */
const ETAPAS = Object.freeze(['configuracao', 'modulos', 'email', 'conexao-parametros', 'conexao', 'identidade', 'dependencias', 'execucao', 'encerramento']);
/**
 * Motivos conhecidos, por código fechado (P2 #1 do Astra, log da falha r1). O log NUNCA leva o texto da mensagem: só o
 * código da primeira linha cujo padrão (âncora fixa no início) casa com a mensagem. Mensagem sem correspondência → null.
 * Mensagens deste job e de assinatura-reconciliar.cjs (validarAlvo, argumentos, opcoesConexao).
 */
const MOTIVOS = Object.freeze([
    ['ARGUMENTO_DESCONHECIDO', /^Argumento desconhecido: /],
    ['URL_IGUAL_DATABASE_URL', /^Alvo recusado: use uma conexão própria em KIDMAIS_RECONCILIAR_DATABASE_URL/],
    ['URL_AUSENTE', /^Defina KIDMAIS_RECONCILIAR_DATABASE_URL /],
    ['URL_INVALIDA', /^KIDMAIS_RECONCILIAR_DATABASE_URL inválida\.$/],
    ['NOME_BANCO_INVALIDO', /^Nome de banco inválido\.$/],
    ['BANCO_PROIBIDO', /^Banco \S+ recusado: proibido como alvo/],
    ['PRODUCAO_EXIGE_SERVICO_E_PROVEDOR', /^Banco \S+ recusado: conferência de produção exige/],
    ['ALVO_NAO_CONFIRMADO', /^Confirme o alvo: defina KIDMAIS_RECONCILIAR_ALVO=/],
    ['URL_COM_FRAGMENTO', /^URL do alvo recusada: fragmento/],
    ['PORTA_AUSENTE', /^URL do alvo recusada: a porta deve ser explícita/],
    ['PORTA_FORA_DA_FAIXA', /^(URL do alvo recusada: porta|Alvo com porta) fora de 1\.\.65535\.$/],
    ['USUARIO_AUSENTE', /^(URL do alvo recusada: o usuário deve ser explícito|URL do alvo sem usuário\.$)/],
    ['PARAMETRO_DE_DESTINO', /^URL do alvo recusada: parâmetro\(s\) /],
    ['URL_ILEGIVEL', /^URL do alvo ilegível\.$/],
    ['URL_DIVERGE_DO_ALVO', /^URL do alvo diverge do alvo validado/],
    ['MODO_DESCONHECIDO', /^KIDMAIS_AVISOS_MODO desconhecido/],
    ['AVISOS_DESLIGADOS', /^Avisos desligados: /],
    ['LOCAL_EXIGE_EMAIL_ARQUIVO', /^Aplicação local exige banco local isolado/],
    ['REMOTO_EXIGE_RENDER_E_MODO', /^Aplicação remota exige o serviço do Render/],
    ['SCHEMA_NAO_LIBERADO', /^Schema não liberado: /],
    ['REMOTO_EXIGE_RESEND', /^Aplicação remota exige EMAIL_PROVIDER=resend\.$/],
    ['ALVO_PRODUCAO_RECUSADO', /^Alvo de produção recusado: /],
    ['ALVO_STAGING_RECUSADO', /^Alvo de staging recusado: /],
    ['AMBIENTE_RECUSADO', /^Ambiente recusado: /],
    ['EMAIL_NAO_CONFIGURADO', /^E-mail do ambiente não configurado\.$/],
    ['BANCO_CONECTADO_DIVERGE', /^Banco conectado diverge do alvo confirmado\.$/],
    ['CONEXAO_SEM_TLS', /^Conexão remota sem TLS recusada\.$/],
    ['ENVIO_PROIBIDO_NA_SIMULACAO', /^Envio proibido na simulação\.$/],
    ['TLS_MODO_RECUSADO', /^TLS_MODO_RECUSADO$/],
    ['TLS_PRODUCAO_RECUSADO', /^TLS_PRODUCAO_RECUSADO$/],
    ['TLS_POLITICA_RECUSADA', /^TLS_POLITICA_RECUSADA$/],
    ['TLS_REDE_PRIVADA_RECUSADA', /^TLS_REDE_PRIVADA_RECUSADA$/],
]);
/** Tipos de erro registráveis (lista fechada); qualquer outro vira 'Outro'. */
const TIPOS = Object.freeze(['Error', 'TypeError', 'RangeError', 'URIError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'DatabaseError']);
/**
 * Formatos de código registráveis: SQLSTATE (5 caracteres), código de sistema do Node (E + letras), ou maiúsculas com
 * sublinhado (ERR_*, códigos TLS/OpenSSL, códigos próprios como EMAIL_NAO_CONFIGURADO). Limite residual (P3 do Astra, r2):
 * `code` continua sendo conteúdo externo filtrado só por FORMATO; qualquer segredo compatível com um dos três formatos
 * passaria intacto (ex.: `ABCDE`, `ESEGREDO`, `SEGREDO_SINTETICO`). Nos caminhos conhecidos, `code` vem do PostgreSQL, do
 * Node/TLS ou de constantes deste código; uma garantia independente da origem exigiria lista fechada ou mapeamento para
 * constantes.
 */
const CODIGO_SEGURO = /^(?:[0-9A-Z]{5}|E[A-Z]{3,20}|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,8})$/;

/** Código fechado do motivo, a partir da mensagem; o texto nunca sai daqui. */
function motivoDe(erro) {
    const mensagem = erro && typeof erro === 'object' && typeof erro.message === 'string' ? erro.message : null;
    if (mensagem === null) return null;
    const achado = MOTIVOS.find(([, padrao]) => padrao.test(mensagem));
    return achado ? achado[0] : null;
}

/** Descrição segura de uma falha: só valores de listas fechadas ou formatos restritos. */
function descreverFalha(erro, etapa) {
    const etapaSegura = ETAPAS.includes(etapa) ? etapa : 'desconhecida';
    const ehObjeto = erro !== null && typeof erro === 'object';
    const nome = ehObjeto && erro.constructor ? erro.constructor.name : null;
    const tipo = ehObjeto ? (TIPOS.includes(nome) ? nome : 'Outro') : 'NaoErro';
    const codigoBruto = ehObjeto ? erro.code : undefined;
    const codigo = typeof codigoBruto === 'string' && codigoBruto.length <= 60 && CODIGO_SEGURO.test(codigoBruto) ? codigoBruto : null;
    return { etapa: etapaSegura, tipo, codigo, motivo: motivoDe(erro) };
}

/** Falha do ciclo com o pool aberto: a principal (com sua etapa) e, separada, a do encerramento (P2 #2 do Astra). */
class FalhaDoCiclo extends Error {
    constructor(principal, secundaria) {
        super('Falha do ciclo dos avisos.');
        this.principal = principal;
        this.secundaria = secundaria;
    }
}

/**
 * Executa o corpo e SEMPRE tenta encerrar. Só o corpo falha → principal com a etapa do corpo. Só o encerramento falha →
 * principal na etapa 'encerramento'. Os dois → principal do corpo + secundária do encerramento (nenhum substitui o outro).
 */
async function cicloComEncerramento(estado, corpo, encerrar) {
    let principal = null;
    let resultado;
    try { resultado = await corpo(); } catch (erro) { principal = { erro, etapa: estado.etapa }; }
    let secundaria = null;
    try { await encerrar(); } catch (erro) { secundaria = { erro, etapa: 'encerramento' }; }
    if (principal || secundaria) throw new FalhaDoCiclo(principal ?? secundaria, principal ? secundaria : null);
    return resultado;
}

/** Linha de log da falha: a principal e, se houver, a secundária. */
function registroDaFalha(erro, etapaAtual) {
    if (erro instanceof FalhaDoCiclo) {
        const registro = { falha: descreverFalha(erro.principal.erro, erro.principal.etapa) };
        if (erro.secundaria) registro.secundaria = descreverFalha(erro.secundaria.erro, erro.secundaria.etapa);
        return registro;
    }
    return { falha: descreverFalha(erro, etapaAtual) };
}

/** Saída 2 quando o relatório pede atenção humana; 1 sem a 087. */
function codigoDeSaida(relatorio, exigeAtencao) {
    if (!relatorio.instalado) return 1;
    return exigeAtencao(relatorio) ? 2 : 0;
}

async function main(estado = { etapa: 'configuracao' }) {
    estado.etapa = 'configuracao';
    const cfg = configuracaoExecucao(process.env, process.argv.slice(2));
    if (cfg.aguardando) { console.log(JSON.stringify({ modo: cfg.modo, conectou: false })); return; }
    const { aplicar, alvo } = cfg;
    estado.etapa = 'modulos';
    const { executarAvisos, exigeAtencao } = await import('../lib/assinatura/avisos-envio.ts');
    const { repositorioAvisos } = await import('../lib/assinatura/avisos-repositorio.ts');
    const { prazosDeAcesso } = await import('../lib/assinatura/configuracao.ts');
    const { criarEnviarEmail, situacaoEmail, origemPublica } = await import('../lib/acessos/email.ts');
    estado.etapa = 'email';
    if (aplicar && !situacaoEmail(process.env).configurado) throw new Error('E-mail do ambiente não configurado.');
    const { Pool } = require('pg');
    estado.etapa = 'conexao-parametros';
    const parametros = parametrosDeConexao(alvo, process.env);
    estado.etapa = 'conexao';
    const pool = new Pool({ ...parametros, max: 2, connectionTimeoutMillis: 10000, application_name: 'kidmais-assinatura-avisos' });
    pool.on('error', () => undefined);
    const transacao = async (f) => {
        const tx = await pool.connect();
        try {
            await tx.query(aplicar ? 'BEGIN' : 'BEGIN READ ONLY');
            await tx.query("SET LOCAL statement_timeout = '30s'");
            await tx.query("SET LOCAL lock_timeout = '5s'");
            const r = await f(tx); await tx.query('COMMIT'); return r;
        } catch (e) { await tx.query('ROLLBACK'); throw e; }
        finally { tx.release(); }
    };
    await cicloComEncerramento(estado, async () => {
        const id = (await pool.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        estado.etapa = 'identidade';
        if (id.db !== alvo.database) throw new Error('Banco conectado diverge do alvo confirmado.');
        if (!alvo.local && id.tls !== true) throw new Error('Conexão remota sem TLS recusada.');
        estado.etapa = 'dependencias';
        const deps = { repositorio: repositorioAvisos(transacao), prazos: prazosDeAcesso(process.env), origem: origemPublica(), simular: !aplicar,
            enviar: aplicar ? criarEnviarEmail(process.env) : async () => { throw new Error('Envio proibido na simulação.'); } };
        estado.etapa = 'execucao';
        const relatorio = await executarAvisos(deps);
        console.log(JSON.stringify({ modo: cfg.modo, banco: alvo.database, ...relatorio }, null, 2));
        if (!relatorio.instalado) console.error('Banco sem a 087 (assinatura_avisos): nada a fazer.');
        process.exitCode = codigoDeSaida(relatorio, exigeAtencao);
    }, () => pool.end());
}
if (require.main === module) {
    const estado = { etapa: 'configuracao' };
    main(estado).catch((erro) => {
        console.error('Avisos da assinatura interrompidos. Verifique configuração, autorização e alvo; nenhum dado sensível é registrado.');
        console.error(JSON.stringify(registroDaFalha(erro, estado.etapa)));
        process.exitCode = 1;
    });
}
module.exports = { configuracaoExecucao, codigoDeSaida, recusarParametrosDeDestino, parametrosDeConexao, descreverFalha, motivoDe, registroDaFalha,
    cicloComEncerramento, FalhaDoCiclo, ETAPAS, MOTIVOS, TIPOS, CODIGO_SEGURO, STAGING, SCHEMA_EXIGIDO, PARAMETROS_TLS };
