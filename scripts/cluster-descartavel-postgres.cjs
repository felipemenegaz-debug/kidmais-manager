/* eslint-disable @typescript-eslint/no-require-imports */
// Ciclo de vida de um cluster PostgreSQL 18 LOCAL e DESCARTÁVEL (docs/CONCORRENCIA_VAGAS_ISOLADO_20261010.md).
// Serve a mais de uma frente por parâmetro, mas só os clusters da lista fechada CLUSTERS (nome ↔ porta fixos).
// Subcomandos: plano (padrão; só imprime, não executa nada), criar, iniciar, conferir (leitura), parar, remover.
// Cada subcomando que muda algo exige a própria flag (--criar-autorizado, --iniciar-autorizado, --parar-autorizado,
// --remover-autorizado). A pasta do cluster fica na raiz do repositório, ignorada pelo Git (.local-*/), e leva uma
// marca escrita na criação (guid, nome, porta). remover só apaga uma pasta com essa marca, parada e sem links.
// Nunca lê arquivos de ambiente, nunca usa DATABASE_URL/PG* herdadas, nunca conecta fora de 127.0.0.1, sem rede.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {spawnSync} = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..');
const FERRAMENTA = 'kidmais-cluster-descartavel';
const MARCA = '.kidmais-cluster-descartavel.json';
const VERSAO_PG = 18;
const VAR_BIN = 'KIDMAIS_PG_BIN';
/** Lista fechada: nome do cluster = papel do initdb = cluster_name; porta fixa por nome. */
const CLUSTERS = Object.freeze({
    kidmais_concorrencia: Object.freeze({porta:55480, prefixo:'concorrencia'}),
    kidmais_navegador: Object.freeze({porta:55481, prefixo:'navegador'}),
    // Suítes *.postgres.test.ts (check:v1:postgres): a receita exige cluster_name = papel = kidmais_descartavel na 55498.
    kidmais_descartavel: Object.freeze({porta:55498, prefixo:'descartavel'}),
});
const PADRAO_PASTA = /^\.local-([a-z]+)-pg-([0-9a-f]{32})$/;
const BANCOS_DE_SISTEMA = Object.freeze(['postgres', 'template0', 'template1']);
const SUBCOMANDOS = Object.freeze({
    plano:{opcoes:['--cluster'], obrigatorias:[], flag:null},
    criar:{opcoes:['--cluster'], obrigatorias:['--cluster'], flag:'--criar-autorizado'},
    iniciar:{opcoes:['--pasta'], obrigatorias:['--pasta'], flag:'--iniciar-autorizado'},
    conferir:{opcoes:['--pasta', '--banco'], obrigatorias:['--pasta'], flag:null},
    parar:{opcoes:['--pasta'], obrigatorias:['--pasta'], flag:'--parar-autorizado'},
    remover:{opcoes:['--pasta'], obrigatorias:['--pasta'], flag:'--remover-autorizado'},
});
const USO = 'USO: node scripts/cluster-descartavel-postgres.cjs [plano [--cluster <nome>]] | criar --cluster <nome> --criar-autorizado'
    + ' | iniciar --pasta <pasta> --iniciar-autorizado | conferir --pasta <pasta> [--banco <nome>] | parar --pasta <pasta> --parar-autorizado'
    + ' | remover --pasta <pasta> --remover-autorizado. Clusters: ' + Object.keys(CLUSTERS).join(', ');

const recusa = (codigo, detalhe) => Object.assign(Error(detalhe ? `${codigo} ${detalhe}` : codigo), {codigo});
const noWindows = process.platform === 'win32';
const normal = p => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return noWindows ? r.toLowerCase() : r; };
const mesmoCaminho = (a, b) => normal(a) === normal(b);

/** Argumentos estritos: subcomando, opções com valor, só a flag do próprio subcomando, nada repetido. */
function lerArgumentos(argv) {
    const lista = [...argv];
    const sub = lista.length && !lista[0].startsWith('--') ? lista.shift() : 'plano';
    const def = SUBCOMANDOS[sub];
    if (!def) throw recusa('USO_SUBCOMANDO_DESCONHECIDO');
    const r = {sub, cluster:null, pasta:null, banco:null, autorizado:false};
    const vistos = new Set();
    while (lista.length) {
        const a = lista.shift();
        if (vistos.has(a)) throw recusa('USO_OPCAO_REPETIDA');
        vistos.add(a);
        if (def.flag && a === def.flag) { r.autorizado = true; continue; }
        if (!def.opcoes.includes(a)) throw recusa('USO_OPCAO_DESCONHECIDA');
        const v = lista.shift();
        if (typeof v !== 'string' || v === '' || v.startsWith('--')) throw recusa('USO_VALOR_AUSENTE');
        r[a.slice(2)] = v;
    }
    for (const o of def.obrigatorias) if (r[o.slice(2)] === null) throw recusa('USO_OPCAO_OBRIGATORIA');
    if (def.flag && !r.autorizado) throw recusa('FLAG_AUSENTE', def.flag);
    if (r.cluster !== null) definicao(r.cluster);
    return r;
}

function definicao(cluster) {
    if (!Object.hasOwn(CLUSTERS, cluster)) throw recusa('CLUSTER_FORA_DA_LISTA');
    return {cluster, ...CLUSTERS[cluster]};
}
const clusterDoPrefixo = prefixo => Object.keys(CLUSTERS).find(c => CLUSTERS[c].prefixo === prefixo) ?? null;

/** Banco permitido num cluster: <cluster>_[a-z0-9_]{1,40}; nada além do padrão (nem nome de outro ambiente). */
function validarBanco(banco, cluster) {
    if (!new RegExp(`^${cluster}_[a-z0-9_]{1,40}$`).test(banco)) throw recusa('BANCO_FORA_DO_PADRAO');
    return banco;
}

const variavelHerdada = nome => nome === 'DATABASE_URL' || /^PG/i.test(nome);
function semConexaoHerdada(env) {
    const herdadas = Object.keys(env).filter(variavelHerdada);
    if (herdadas.length) throw recusa('CONEXAO_HERDADA', herdadas.join(','));
}

/** A pasta só pode nascer se o Git já a ignora (regra .local-* na raiz) e nenhuma regra a reinclui. */
function conferirGitignore(raiz) {
    let linhas;
    try { linhas = fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8').split(/\r?\n/).map(l => l.trim()); }
    catch { return {ignorada:false, regra:null}; }
    const regra = linhas.find(l => ['.local-*/', '.local-*', '/.local-*/', '/.local-*'].includes(l)) ?? null;
    const reinclusao = linhas.some(l => l.startsWith('!') && l.includes('.local-'));
    return {ignorada:Boolean(regra) && !reinclusao, regra};
}

/** Binários por KIDMAIS_PG_BIN (pasta absoluta) ou pelo PATH; os três precisam estar na mesma pasta. */
function localizarBinarios(env, fsImpl = fs) {
    const ext = noWindows ? '.exe' : '';
    const nomes = ['initdb', 'pg_ctl', 'psql'];
    const completa = dir => nomes.every(n => { try { return fsImpl.statSync(path.join(dir, n + ext)).isFile(); } catch { return false; } });
    const montar = dir => Object.freeze({dir, origem:env[VAR_BIN] ? VAR_BIN : 'PATH', ...Object.fromEntries(nomes.map(n => [n, path.join(dir, n + ext)]))});
    const explicito = env[VAR_BIN];
    if (typeof explicito === 'string' && explicito !== '') {
        if (!path.isAbsolute(explicito)) throw recusa('BINARIOS_CAMINHO_RELATIVO');
        if (!completa(explicito)) throw recusa('BINARIOS_AUSENTES', VAR_BIN);
        return montar(explicito);
    }
    const chavePath = Object.keys(env).find(k => k.toUpperCase() === 'PATH');
    for (const dir of String(chavePath ? env[chavePath] : '').split(path.delimiter).filter(d => path.isAbsolute(d)))
        if (completa(dir)) return montar(dir);
    throw recusa('BINARIOS_AUSENTES', `defina ${VAR_BIN}`);
}

/** Recusa qualquer binário que não seja PostgreSQL 18 (initdb, pg_ctl e psql conferidos). */
function exigirVersao(bins, executar) {
    for (const n of ['initdb', 'pg_ctl', 'psql']) {
        const r = executar(bins[n], ['--version']);
        const m = /\(PostgreSQL\)\s+(\d+)/.exec(String(r.stdout ?? ''));
        if (r.status !== 0 || !m || Number(m[1]) !== VERSAO_PG) throw recusa('VERSAO_RECUSADA', `${n}: ${m ? m[1] : '?'}`);
    }
}

/** Ambiente mínimo dos processos filhos: nada de PG* nem DATABASE_URL do pai; extras só os definidos aqui. */
function ambienteFilho(env, extras = {}) {
    const permitidas = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']);
    const r = {};
    for (const [k, v] of Object.entries(env)) if (permitidas.has(k.toUpperCase())) r[k] = v;
    return {...r, ...extras};
}

/**
 * Valida uma pasta de cluster: filha direta da raiz (sem "..", sem link em nenhum nível), nome .local-<prefixo>-pg-<guid>,
 * marca regular, legível e coerente com o nome, a lista fechada e a pasta. Lança antes de qualquer efeito.
 */
function validarPasta(texto, raiz, fsImpl = fs) {
    if (typeof texto !== 'string' || texto === '') throw recusa('PASTA_AUSENTE');
    const alvo = path.resolve(raiz, texto);
    if (!mesmoCaminho(path.dirname(alvo), raiz)) throw recusa('PASTA_FORA_DA_RAIZ');
    const nome = path.basename(alvo);
    const m = PADRAO_PASTA.exec(nome);
    if (!m) throw recusa('PASTA_NOME_INVALIDO');
    const cluster = clusterDoPrefixo(m[1]);
    if (!cluster) throw recusa('PASTA_NOME_INVALIDO');
    let st;
    try { st = fsImpl.lstatSync(alvo); } catch { throw recusa('PASTA_INEXISTENTE'); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw recusa('PASTA_LINK_OU_ARQUIVO');
    const raizReal = fsImpl.realpathSync.native(raiz);
    if (!mesmoCaminho(fsImpl.realpathSync.native(alvo), path.join(raizReal, nome))) throw recusa('PASTA_LINK_OU_ARQUIVO');
    const arquivoMarca = path.join(alvo, MARCA);
    let marca;
    try {
        const sm = fsImpl.lstatSync(arquivoMarca);
        if (!sm.isFile() || sm.size > 4096) throw recusa('MARCA_INVALIDA');
        marca = JSON.parse(fsImpl.readFileSync(arquivoMarca, 'utf8'));
    } catch (e) { throw e.codigo ? e : recusa(e.code === 'ENOENT' ? 'MARCA_AUSENTE' : 'MARCA_INVALIDA'); }
    const d = definicao(cluster);
    const esperado = {ferramenta:FERRAMENTA, versao:1, guid:m[2], cluster, porta:d.porta, pasta:nome};
    for (const [k, v] of Object.entries(esperado)) if (marca?.[k] !== v) throw recusa('MARCA_DIVERGENTE', k);
    return Object.freeze({pasta:alvo, nome, guid:m[2], cluster, porta:d.porta, dados:path.join(alvo, 'dados')});
}

const existe = (p, fsImpl = fs) => { try { fsImpl.lstatSync(p); return true; } catch { return false; } };

/** Nenhum link simbólico/junção dentro da pasta (ex.: pg_tblspc): a remoção não pode sair dela. */
function semLinks(dir, fsImpl = fs) {
    for (const e of fsImpl.readdirSync(dir)) {
        const p = path.join(dir, e);
        const st = fsImpl.lstatSync(p);
        if (st.isSymbolicLink()) throw recusa('LINK_NA_PASTA');
        if (st.isDirectory()) semLinks(p, fsImpl);
    }
}

function executarReal(env) {
    return (bin, args, {log, extras} = {}) => {
        let fd = null;
        try {
            // Saída em arquivo para pg_ctl start: o servidor herda as alças e um pipe prenderia esta chamada.
            if (log) fd = fs.openSync(log, 'a');
            const r = spawnSync(bin, args, {env:ambienteFilho(env, extras), stdio:['ignore', fd ?? 'pipe', fd ?? 'pipe'],
                encoding:'utf8', timeout:180000, windowsHide:true, shell:false});
            return {status:r.status, stdout:r.stdout ?? '', stderr:r.stderr ?? '', erro:r.error?.code ?? null};
        } finally { if (fd !== null) fs.closeSync(fd); }
    };
}

/** Só 127.0.0.1. Conectou ou não respondeu → ocupada (fail-closed); recusada → livre. */
function portaOcupadaReal(porta) {
    return new Promise(ok => {
        const s = net.createConnection({host:'127.0.0.1', port:porta});
        s.setTimeout(1500);
        s.once('connect', () => { s.destroy(); ok(true); });
        s.once('timeout', () => { s.destroy(); ok(true); });
        s.once('error', e => ok(e.code !== 'ECONNREFUSED'));
    });
}

const argsInitdb = (dados, cluster) => ['-D', dados, '-U', cluster, '-A', 'trust', '--encoding=UTF8', '--locale=C'];
const opcoesServidor = d => `-c listen_addresses=127.0.0.1 -p ${d.porta} -c cluster_name=${d.cluster}`;
const argsIniciar = (c) => ['-D', c.dados, '-l', path.join(c.pasta, 'servidor.log'), '-o', opcoesServidor(c), '-w', '-t', '60', 'start'];
const argsParar = c => ['-D', c.dados, '-m', 'fast', '-w', '-t', '60', 'stop'];
const CONF = d => `\n# ${FERRAMENTA}: cluster local e descartável\nlisten_addresses = '127.0.0.1'\nport = ${d.porta}\ncluster_name = '${d.cluster}'\n`;
const SQL_CONFERIR = `SELECT json_build_object('versao', current_setting('server_version_num')::int, 'papel', current_user,
 'endereco', host(inet_server_addr()), 'porta', inet_server_port(), 'cluster', current_setting('cluster_name'),
 'dados', current_setting('data_directory'), 'somenteLeitura', current_setting('transaction_read_only'),
 'bancos', ARRAY(SELECT datname::text FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') ORDER BY 1))`;
const argsPsql = c => ['-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-d', `host=127.0.0.1 port=${c.porta} user=${c.cluster} dbname=postgres connect_timeout=5 sslmode=disable application_name=${FERRAMENTA}`,
    '-c', 'BEGIN TRANSACTION READ ONLY', '-c', SQL_CONFERIR, '-c', 'COMMIT'];

/** Identidade do servidor: versão 18, papel, 127.0.0.1, porta, cluster_name, pasta de dados e bancos (só sistema ou o esperado). */
function conferirIdentidade(obtido, c, banco) {
    const o = obtido ?? {};
    const falhas = [];
    if (!(Number.isInteger(o.versao) && o.versao >= VERSAO_PG * 10000 && o.versao < (VERSAO_PG + 1) * 10000)) falhas.push('versao');
    if (o.papel !== c.cluster) falhas.push('papel');
    if (o.endereco !== '127.0.0.1') falhas.push('endereco');
    if (Number(o.porta) !== c.porta) falhas.push('porta');
    if (o.cluster !== c.cluster) falhas.push('cluster_name');
    if (typeof o.dados !== 'string' || !mesmoCaminho(o.dados, c.dados)) falhas.push('dados');
    if (o.somenteLeitura !== 'on') falhas.push('somenteLeitura');
    const bancos = Array.isArray(o.bancos) ? o.bancos : null;
    const aceitos = banco ? [[], [banco]] : [[]];
    if (!bancos || !aceitos.some(a => a.length === bancos.length && a.every((b, i) => b === bancos[i]))) falhas.push('bancos');
    if (falhas.length) throw recusa('IDENTIDADE_DIVERGENTE', falhas.join(','));
    return {versao:o.versao, papel:o.papel, endereco:o.endereco, porta:Number(o.porta), cluster:o.cluster, bancos};
}

function plano(r, env, raiz) {
    const git = conferirGitignore(raiz);
    let binarios;
    try { binarios = localizarBinarios(env).dir; } catch (e) { binarios = e.codigo; }
    const nomes = r.cluster ? [r.cluster] : Object.keys(CLUSTERS);
    const script = 'node scripts/cluster-descartavel-postgres.cjs';
    return {modo:'PLANO', executa:false, gitignore:git, binarios, versaoExigida:VERSAO_PG,
        clusters:nomes.map(n => {
            const d = definicao(n);
            const pasta = `.local-${d.prefixo}-pg-<guid>`;
            const c = {...d, pasta, dados:`${pasta}/dados`};
            return {cluster:n, porta:d.porta, papel:n, pasta, passos:[
                {passo:'criar', comando:`${script} criar --cluster ${n} --criar-autorizado`,
                    efeito:`mkdir ${pasta}; marca ${MARCA}; initdb ${argsInitdb(c.dados, n).join(' ')}; acrescenta listen_addresses/port/cluster_name ao postgresql.conf`},
                {passo:'iniciar', comando:`${script} iniciar --pasta ${pasta} --iniciar-autorizado`,
                    efeito:`porta livre em 127.0.0.1; pg_ctl -D ${c.dados} -l ${pasta}/servidor.log -o "${opcoesServidor(c)}" -w -t 60 start`},
                {passo:'conferir', comando:`${script} conferir --pasta ${pasta} [--banco ${n}_<nome>]`,
                    efeito:'psql -X -w em transação somente leitura: versão 18, papel, 127.0.0.1, porta, cluster_name, pasta de dados e bancos'},
                {passo:'parar', comando:`${script} parar --pasta ${pasta} --parar-autorizado`, efeito:`pg_ctl -D ${c.dados} -m fast -w -t 60 stop`},
                {passo:'remover', comando:`${script} remover --pasta ${pasta} --remover-autorizado`,
                    efeito:'só com marca coerente, sem postmaster.pid, pg_ctl status = parado e sem links; apaga só esta pasta'},
            ]};
        })};
}

async function criar(r, env, raiz, deps) {
    const d = definicao(r.cluster);
    const git = conferirGitignore(raiz);
    if (!git.ignorada) throw recusa('GITIGNORE_SEM_REGRA', '.local-*/');
    const bins = localizarBinarios(env, deps.fs);
    exigirVersao(bins, deps.executar);
    const guid = deps.guid();
    if (!/^[0-9a-f]{32}$/.test(guid)) throw recusa('GUID_INVALIDO');
    const nome = `.local-${d.prefixo}-pg-${guid}`;
    const pasta = path.join(raiz, nome);
    fs.mkdirSync(pasta); // sem recursive: falha se já existir
    fs.writeFileSync(path.join(pasta, MARCA), JSON.stringify({ferramenta:FERRAMENTA, versao:1, guid, cluster:d.cluster, porta:d.porta, pasta:nome,
        criadaEm:deps.agora(), aviso:'Pasta descartável; só scripts/cluster-descartavel-postgres.cjs remover a apaga.'}, null, 2), {flag:'wx'});
    const c = {...d, pasta, dados:path.join(pasta, 'dados')};
    const ini = deps.executar(bins.initdb, argsInitdb(c.dados, d.cluster), {log:path.join(pasta, 'initdb.log')});
    if (ini.status !== 0) throw recusa('INITDB_FALHOU', `pasta ${nome} preservada; remover pela marca`);
    fs.appendFileSync(path.join(c.dados, 'postgresql.conf'), CONF(d));
    return {resultado:'CRIADO', cluster:d.cluster, porta:d.porta, pasta:nome, caminho:pasta, binarios:bins.dir};
}

async function iniciar(r, env, raiz, deps) {
    const c = validarPasta(r.pasta, raiz, deps.fs);
    let versao;
    try { versao = fs.readFileSync(path.join(c.dados, 'PG_VERSION'), 'utf8').trim(); } catch { versao = null; }
    if (versao !== String(VERSAO_PG)) throw recusa('DADOS_NAO_SAO_PG18');
    if (existe(path.join(c.dados, 'postmaster.pid'), deps.fs)) throw recusa('SERVIDOR_JA_EM_EXECUCAO');
    const bins = localizarBinarios(env, deps.fs);
    exigirVersao(bins, deps.executar);
    if (await deps.portaOcupada(c.porta)) throw recusa('PORTA_OCUPADA', String(c.porta));
    const s = deps.executar(bins.pg_ctl, argsIniciar(c), {log:path.join(c.pasta, 'pg_ctl.log')});
    if (s.status !== 0) throw recusa('INICIO_FALHOU', 'ver pg_ctl.log e servidor.log na pasta');
    return {resultado:'INICIADO', cluster:c.cluster, porta:c.porta, pasta:c.nome, escuta:'127.0.0.1'};
}

async function conferir(r, env, raiz, deps) {
    const c = validarPasta(r.pasta, raiz, deps.fs);
    const banco = r.banco === null ? null : validarBanco(r.banco, c.cluster);
    const bins = localizarBinarios(env, deps.fs);
    exigirVersao(bins, deps.executar);
    // Arquivo de senhas inexistente: o psql nunca usa uma senha salva; com -w, pedido de senha = falha.
    const s = deps.executar(bins.psql, argsPsql(c), {extras:{PGPASSFILE:path.join(c.pasta, 'sem-senha.inexistente')}});
    if (s.status !== 0) throw recusa('CONFERENCIA_FALHOU', 'servidor parado, outra identidade ou pedido de senha');
    let obtido;
    try { obtido = JSON.parse(String(s.stdout).trim()); } catch { throw recusa('IDENTIDADE_DIVERGENTE', 'resposta'); }
    return {resultado:'CONFERE', pasta:c.nome, ...conferirIdentidade(obtido, c, banco)};
}

async function parar(r, env, raiz, deps) {
    const c = validarPasta(r.pasta, raiz, deps.fs);
    const bins = localizarBinarios(env, deps.fs);
    exigirVersao(bins, deps.executar);
    const s = deps.executar(bins.pg_ctl, argsParar(c), {log:path.join(c.pasta, 'pg_ctl.log')});
    if (s.status !== 0) throw recusa('PARADA_FALHOU', 'ver pg_ctl.log na pasta');
    if (existe(path.join(c.dados, 'postmaster.pid'), deps.fs)) throw recusa('PARADA_FALHOU', 'postmaster.pid ainda existe');
    return {resultado:'PARADO', cluster:c.cluster, pasta:c.nome};
}

async function remover(r, env, raiz, deps) {
    const c = validarPasta(r.pasta, raiz, deps.fs);
    if (existe(path.join(c.dados, 'postmaster.pid'), deps.fs)) throw recusa('SERVIDOR_EM_EXECUCAO');
    if (existe(path.join(c.dados, 'PG_VERSION'), deps.fs)) {
        const bins = localizarBinarios(env, deps.fs);
        const st = deps.executar(bins.pg_ctl, ['status', '-D', c.dados]);
        if (st.status !== 3) throw recusa('SERVIDOR_EM_EXECUCAO', 'pg_ctl status não confirma parada');
    }
    semLinks(c.pasta, deps.fs);
    fs.rmSync(c.pasta, {recursive:true, maxRetries:3});
    return {resultado:'REMOVIDO', cluster:c.cluster, pasta:c.nome};
}

const ACOES = {criar, iniciar, conferir, parar, remover};

async function principal(argv, env, opcoes = {}) {
    const raiz = opcoes.raiz ?? RAIZ;
    const deps = {executar:executarReal(env), portaOcupada:portaOcupadaReal, guid:() => randomUUID().replace(/-/g, ''),
        agora:() => new Date().toISOString(), fs, ...opcoes.deps};
    const r = lerArgumentos(argv);
    if (r.sub === 'plano') return plano(r, env, raiz);
    semConexaoHerdada(env);
    return ACOES[r.sub](r, env, raiz, deps);
}

if (require.main === module)
    principal(process.argv.slice(2), process.env).then(
        r => console.log(JSON.stringify(r, null, 2)),
        e => {
            console.error('CLUSTER_DESCARTAVEL_RECUSADO ' + String(e?.message ?? e).slice(0, 200));
            if (String(e?.codigo ?? '').startsWith('USO') || e?.codigo === 'FLAG_AUSENTE') console.error(USO);
            process.exitCode = 1;
        });

module.exports = {CLUSTERS, MARCA, FERRAMENTA, VAR_BIN, VERSAO_PG, BANCOS_DE_SISTEMA, SUBCOMANDOS, lerArgumentos, definicao, validarBanco,
    semConexaoHerdada, conferirGitignore, localizarBinarios, exigirVersao, ambienteFilho, validarPasta, semLinks, conferirIdentidade,
    argsInitdb, argsIniciar, argsParar, argsPsql, principal};
