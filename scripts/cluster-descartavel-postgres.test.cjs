/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do ciclo de vida do cluster descartável: pastas temporárias e binários falsos.
// Nenhum caso invoca initdb/pg_ctl/psql reais, abre socket ou conecta a banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const t = require('./cluster-descartavel-postgres.cjs');

const ARQUIVO = path.join(__dirname, 'cluster-descartavel-postgres.cjs');
const RAIZ_REAL = path.resolve(__dirname, '..');
const fonte = fs.readFileSync(ARQUIVO, 'utf8');
const EXT = process.platform === 'win32' ? '.exe' : '';
const GUID = 'a'.repeat(32);
const recusaDe = fn => { try { fn(); } catch (e) { return e.codigo ?? e.message; } return 'ACEITO'; };
const recusaAsync = async p => { try { await p; } catch (e) { return e.codigo ?? e.message; } return 'ACEITO'; };

/** Raiz temporária com .gitignore e pasta de binários falsos (arquivos vazios; nunca executados). */
function ambiente({gitignore = '.local-*/\n'} = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kidmais-cluster-teste-'));
    const raiz = path.join(base, 'repo');
    const bin = path.join(base, 'bin');
    fs.mkdirSync(raiz); fs.mkdirSync(bin);
    if (gitignore !== null) fs.writeFileSync(path.join(raiz, '.gitignore'), gitignore);
    for (const n of ['initdb', 'pg_ctl', 'psql']) fs.writeFileSync(path.join(bin, n + EXT), '');
    return {base, raiz, bin, env:{[t.VAR_BIN]:bin, PATH:''}, limpar:() => fs.rmSync(base, {recursive:true, force:true})};
}

/** Executor falso: registra chamadas; --version responde a versão dada; initdb cria uma pasta de dados mínima. */
function falso({versao = '18.0', status = {}, psql = null} = {}) {
    const chamadas = [];
    const executar = (bin, args, opcoes = {}) => {
        const nome = path.basename(bin, EXT);
        chamadas.push({nome, args, opcoes});
        if (args[0] === '--version') return {status:0, stdout:`${nome} (PostgreSQL) ${versao}\n`, stderr:''};
        if (nome === 'initdb' && (status.initdb ?? 0) === 0) {
            const dados = args[args.indexOf('-D') + 1];
            fs.mkdirSync(dados);
            fs.writeFileSync(path.join(dados, 'PG_VERSION'), '18\n');
            fs.writeFileSync(path.join(dados, 'postgresql.conf'), '# padrão\n');
        }
        if (nome === 'psql') return {status:status.psql ?? 0, stdout:psql ?? '', stderr:''};
        if (nome === 'pg_ctl' && args[0] === 'status') return {status:'pgStatus' in status ? status.pgStatus : 3, stdout:'', stderr:''};
        return {status:status[nome] ?? 0, stdout:'', stderr:''};
    };
    return {chamadas, deps:{executar, portaOcupada:async () => status.porta ?? false, guid:() => GUID, agora:() => '2026-10-10T00:00:00.000Z'}};
}

/** Cria uma pasta como o próprio criar faria (marca coerente), sem binários. */
function pastaMarcada(raiz, {cluster = 'kidmais_concorrencia', guid = GUID, marca = {}} = {}) {
    const d = t.definicao(cluster);
    const nome = `.local-${d.prefixo}-pg-${guid}`;
    const pasta = path.join(raiz, nome);
    fs.mkdirSync(pasta);
    fs.writeFileSync(path.join(pasta, t.MARCA), JSON.stringify({ferramenta:t.FERRAMENTA, versao:1, guid, cluster, porta:d.porta, pasta:nome, ...marca}));
    return {nome, pasta};
}

test('argumentos: plano é o padrão; cada subcomando mutável exige a própria flag; nada desconhecido ou repetido', () => {
    assert.equal(t.lerArgumentos([]).sub, 'plano');
    assert.equal(t.lerArgumentos(['--cluster', 'kidmais_navegador']).cluster, 'kidmais_navegador');
    assert.deepEqual(t.lerArgumentos(['criar', '--cluster', 'kidmais_concorrencia', '--criar-autorizado']),
        {sub:'criar', cluster:'kidmais_concorrencia', pasta:null, banco:null, autorizado:true});
    assert.equal(t.lerArgumentos(['conferir', '--pasta', 'x', '--banco', 'y']).banco, 'y');
    const casos = [
        [['criar', '--cluster', 'kidmais_concorrencia'], 'FLAG_AUSENTE'],
        [['iniciar', '--pasta', 'x'], 'FLAG_AUSENTE'],
        [['parar', '--pasta', 'x'], 'FLAG_AUSENTE'],
        [['remover', '--pasta', 'x'], 'FLAG_AUSENTE'],
        [['remover', '--pasta', 'x', '--criar-autorizado'], 'USO_OPCAO_DESCONHECIDA'],
        [['criar', '--cluster', 'kidmais_concorrencia', '--remover-autorizado'], 'USO_OPCAO_DESCONHECIDA'],
        [['plano', '--criar-autorizado'], 'USO_OPCAO_DESCONHECIDA'],
        [['conferir', '--pasta', 'x', '--conferir-autorizado'], 'USO_OPCAO_DESCONHECIDA'],
        [['criar', '--criar-autorizado'], 'USO_OPCAO_OBRIGATORIA'],
        [['iniciar', '--iniciar-autorizado'], 'USO_OPCAO_OBRIGATORIA'],
        [['criar', '--cluster', '--criar-autorizado'], 'USO_VALOR_AUSENTE'],
        [['criar', '--cluster', 'kidmais_concorrencia', '--criar-autorizado', '--criar-autorizado'], 'USO_OPCAO_REPETIDA'],
        [['iniciar', '--pasta', 'a', '--pasta', 'b', '--iniciar-autorizado'], 'USO_OPCAO_REPETIDA'],
        [['apagar'], 'USO_SUBCOMANDO_DESCONHECIDO'],
        [['drop', '--pasta', 'x'], 'USO_SUBCOMANDO_DESCONHECIDO'],
        [['iniciar', '--pasta=x', '--iniciar-autorizado'], 'USO_OPCAO_DESCONHECIDA'],
    ];
    for (const [argv, codigo] of casos) assert.equal(recusaDe(() => t.lerArgumentos(argv)), codigo, JSON.stringify(argv));
});

test('lista fechada: só kidmais_concorrencia:55480 e kidmais_navegador:55481; banco só no padrão do cluster', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(t.CLUSTERS).map(([k, v]) => [k, v.porta])), {kidmais_concorrencia:55480, kidmais_navegador:55481});
    for (const nome of ['postgres', 'kidmais', 'kidmais_concorrencia2', 'KIDMAIS_CONCORRENCIA', 'kidmais_navegador ', '__proto__', 'constructor', 'toString'])
        assert.equal(recusaDe(() => t.lerArgumentos(['criar', '--cluster', nome, '--criar-autorizado'])), 'CLUSTER_FORA_DA_LISTA', nome);
    assert.equal(t.validarBanco('kidmais_concorrencia_vagas_20261010', 'kidmais_concorrencia'), 'kidmais_concorrencia_vagas_20261010');
    assert.equal(t.validarBanco('kidmais_navegador_e2e', 'kidmais_navegador'), 'kidmais_navegador_e2e');
    for (const [banco, cluster] of [['kidmais_navegador_e2e', 'kidmais_concorrencia'], ['kidmais_concorrencia_x', 'kidmais_navegador'], ['postgres', 'kidmais_concorrencia'],
        ['kidmais_manager', 'kidmais_concorrencia'], ['kidmais_concorrencia_', 'kidmais_concorrencia'], ['kidmais_concorrencia_X', 'kidmais_concorrencia'],
        ['kidmais_concorrencia_x;drop', 'kidmais_concorrencia'], ['kidmais_concorrencia_' + 'a'.repeat(41), 'kidmais_concorrencia']])
        assert.equal(recusaDe(() => t.validarBanco(banco, cluster)), 'BANCO_FORA_DO_PADRAO', banco);
});

test('ambiente: DATABASE_URL/PG* herdadas recusadas; filhos recebem só o mínimo', () => {
    for (const nome of ['DATABASE_URL', 'PGHOST', 'PGPASSWORD', 'pgpassfile', 'PGSERVICE'])
        assert.match(recusaDe(() => t.semConexaoHerdada({[nome]:'x'})), /^CONEXAO_HERDADA/, nome);
    const filho = t.ambienteFilho({PATH:'p', SystemRoot:'s', DATABASE_URL:'x', PGHOST:'h', KIDMAIS_PG_BIN:'b', SEGREDO:'z'}, {PGPASSFILE:'nada'});
    assert.deepEqual(filho, {PATH:'p', SystemRoot:'s', PGPASSFILE:'nada'});
});

test('gitignore: exige .local-*/ sem reinclusão', () => {
    for (const [conteudo, ignorada] of [['.local-*/\n', true], ['\uFEFFnode_modules/\r\n.local-*/\r\n', true], ['.local-*\n', true], ['node_modules/\n', false],
        ['.local-*/\n!.local-concorrencia-pg-x/\n', false], [null, false]]) {
        const a = ambiente({gitignore:conteudo});
        try { assert.equal(t.conferirGitignore(a.raiz).ignorada, ignorada, String(conteudo)); } finally { a.limpar(); }
    }
    assert.equal(t.conferirGitignore(RAIZ_REAL).ignorada, true, 'o repositório real ignora .local-*/');
});

test('binários: KIDMAIS_PG_BIN absoluto e completo; versão diferente de 18 é recusada', () => {
    const a = ambiente();
    try {
        assert.equal(t.localizarBinarios(a.env).dir, a.bin);
        assert.equal(t.localizarBinarios({PATH:a.bin}).origem, 'PATH');
        assert.equal(recusaDe(() => t.localizarBinarios({[t.VAR_BIN]:'bin'})), 'BINARIOS_CAMINHO_RELATIVO');
        assert.equal(recusaDe(() => t.localizarBinarios({[t.VAR_BIN]:a.raiz})), 'BINARIOS_AUSENTES');
        assert.equal(recusaDe(() => t.localizarBinarios({PATH:''})), 'BINARIOS_AUSENTES');
        const bins = t.localizarBinarios(a.env);
        assert.doesNotThrow(() => t.exigirVersao(bins, falso().deps.executar));
        for (const v of ['17.6', '16.4', '19beta1', 'x'])
            assert.equal(recusaDe(() => t.exigirVersao(bins, falso({versao:v}).deps.executar)), 'VERSAO_RECUSADA', v);
    } finally { a.limpar(); }
});

test('criar: pasta nova git-ignorada com marca antes do initdb; initdb local e trust; conf só em 127.0.0.1', async () => {
    const a = ambiente();
    try {
        const f = falso();
        const r = await t.principal(['criar', '--cluster', 'kidmais_navegador', '--criar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps});
        assert.equal(r.pasta, `.local-navegador-pg-${GUID}`);
        assert.deepEqual([r.cluster, r.porta], ['kidmais_navegador', 55481]);
        const marca = JSON.parse(fs.readFileSync(path.join(a.raiz, r.pasta, t.MARCA), 'utf8'));
        assert.deepEqual([marca.guid, marca.cluster, marca.porta, marca.pasta], [GUID, 'kidmais_navegador', 55481, r.pasta]);
        const initdb = f.chamadas.find(c => c.nome === 'initdb' && c.args[0] === '-D');
        assert.deepEqual(initdb.args, ['-D', path.join(a.raiz, r.pasta, 'dados'), '-U', 'kidmais_navegador', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
        const conf = fs.readFileSync(path.join(a.raiz, r.pasta, 'dados', 'postgresql.conf'), 'utf8');
        assert.match(conf, /listen_addresses = '127\.0\.0\.1'\nport = 55481\ncluster_name = 'kidmais_navegador'/);
        assert.doesNotThrow(() => t.validarPasta(r.pasta, a.raiz), 'a pasta criada é reconhecida pela marca');
        assert.match(await recusaAsync(t.principal(['criar', '--cluster', 'kidmais_navegador', '--criar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps})),
            /^EEXIST/, 'mesmo guid nunca reaproveita pasta');
    } finally { a.limpar(); }
});

test('criar: recusa sem regra no gitignore, com versão errada ou com conexão herdada, sem criar pasta', async () => {
    for (const [opcoes, env, codigo] of [[{gitignore:'node_modules/\n'}, {}, 'GITIGNORE_SEM_REGRA'], [{}, {}, 'VERSAO_RECUSADA'], [{}, {PGPORT:'5432'}, 'CONEXAO_HERDADA']]) {
        const a = ambiente(opcoes);
        try {
            const f = falso({versao:codigo === 'VERSAO_RECUSADA' ? '17.6' : '18.0'});
            assert.equal(await recusaAsync(t.principal(['criar', '--cluster', 'kidmais_concorrencia', '--criar-autorizado'], {...a.env, ...env}, {raiz:a.raiz, deps:f.deps})), codigo);
            assert.deepEqual(fs.readdirSync(a.raiz).filter(n => n.startsWith('.local-')), [], codigo);
            assert.equal(f.chamadas.filter(c => c.nome === 'initdb' && c.args[0] === '-D').length, 0);
        } finally { a.limpar(); }
    }
    const a = ambiente();
    try { // initdb falhou: a pasta parcial fica com a marca e pode ser removida
        const f = falso({status:{initdb:1}});
        assert.equal(await recusaAsync(t.principal(['criar', '--cluster', 'kidmais_concorrencia', '--criar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps})), 'INITDB_FALHOU');
        const r = await t.principal(['remover', '--pasta', `.local-concorrencia-pg-${GUID}`, '--remover-autorizado'], a.env, {raiz:a.raiz, deps:f.deps});
        assert.equal(r.resultado, 'REMOVIDO');
        assert.equal(f.chamadas.some(c => c.args[0] === 'status'), false, 'sem PG_VERSION não precisa de pg_ctl status');
    } finally { a.limpar(); }
});

test('iniciar: 127.0.0.1, porta e cluster_name da lista; recusa porta ocupada, servidor já ativo e dados que não são 18', async () => {
    const a = ambiente();
    try {
        const f = falso();
        const {pasta} = await t.principal(['criar', '--cluster', 'kidmais_concorrencia', '--criar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps});
        const r = await t.principal(['iniciar', '--pasta', pasta, '--iniciar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps});
        assert.equal(r.resultado, 'INICIADO');
        const start = f.chamadas.find(c => c.nome === 'pg_ctl' && c.args.at(-1) === 'start');
        assert.equal(start.args[start.args.indexOf('-o') + 1], '-c listen_addresses=127.0.0.1 -p 55480 -c cluster_name=kidmais_concorrencia');
        assert.ok(start.opcoes.log.endsWith('pg_ctl.log'), 'saída em arquivo, nunca em pipe');
        const ocupada = falso({status:{porta:true}});
        assert.equal(await recusaAsync(t.principal(['iniciar', '--pasta', pasta, '--iniciar-autorizado'], a.env, {raiz:a.raiz, deps:ocupada.deps})), 'PORTA_OCUPADA');
        assert.equal(ocupada.chamadas.some(c => c.args.at(-1) === 'start'), false);
        fs.writeFileSync(path.join(a.raiz, pasta, 'dados', 'postmaster.pid'), '1');
        assert.equal(await recusaAsync(t.principal(['iniciar', '--pasta', pasta, '--iniciar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps})), 'SERVIDOR_JA_EM_EXECUCAO');
        fs.rmSync(path.join(a.raiz, pasta, 'dados', 'postmaster.pid'));
        fs.writeFileSync(path.join(a.raiz, pasta, 'dados', 'PG_VERSION'), '17\n');
        assert.equal(await recusaAsync(t.principal(['iniciar', '--pasta', pasta, '--iniciar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps})), 'DADOS_NAO_SAO_PG18');
    } finally { a.limpar(); }
});

test('conferir: só leitura, sem senha salva; identidade completa e bancos só de sistema ou o esperado', async () => {
    const a = ambiente();
    try {
        const {nome, pasta} = pastaMarcada(a.raiz);
        const c = t.validarPasta(nome, a.raiz);
        const ok = {versao:180001, papel:'kidmais_concorrencia', endereco:'127.0.0.1', porta:55480, cluster:'kidmais_concorrencia',
            dados:path.join(pasta, 'dados'), somenteLeitura:'on', bancos:[]};
        const f = falso({psql:JSON.stringify(ok) + '\n'});
        const r = await t.principal(['conferir', '--pasta', nome], a.env, {raiz:a.raiz, deps:f.deps});
        assert.equal(r.resultado, 'CONFERE');
        const psql = f.chamadas.find(x => x.nome === 'psql' && x.args[0] === '-X');
        assert.ok(psql.args.includes('-w') && psql.args.includes('BEGIN TRANSACTION READ ONLY'));
        assert.match(psql.args[psql.args.indexOf('-d') + 1], /^host=127\.0\.0\.1 port=55480 user=kidmais_concorrencia dbname=postgres /);
        assert.ok(psql.opcoes.extras.PGPASSFILE.startsWith(pasta));
        const banco = 'kidmais_concorrencia_vagas_20261010';
        assert.deepEqual(t.conferirIdentidade({...ok, bancos:[banco]}, c, banco).bancos, [banco]);
        assert.deepEqual(t.conferirIdentidade(ok, c, banco).bancos, [], 'antes do executor: só sistema');
        for (const [div, campo] of [[{versao:170006}, 'versao'], [{versao:190000}, 'versao'], [{papel:'postgres'}, 'papel'], [{endereco:'::1'}, 'endereco'],
            [{porta:5432}, 'porta'], [{cluster:'kidmais_navegador'}, 'cluster_name'], [{dados:path.join(a.raiz, 'outra', 'dados')}, 'dados'],
            [{somenteLeitura:'off'}, 'somenteLeitura'], [{bancos:['kidmais_manager']}, 'bancos'], [{bancos:[banco, 'outro']}, 'bancos'], [{bancos:null}, 'bancos']])
            assert.equal(recusaDe(() => t.conferirIdentidade({...ok, ...div}, c, banco)), 'IDENTIDADE_DIVERGENTE', campo);
        assert.equal(recusaDe(() => t.conferirIdentidade({...ok, bancos:[banco]}, c, null)), 'IDENTIDADE_DIVERGENTE', 'sem --banco só sistema');
        assert.equal(await recusaAsync(t.principal(['conferir', '--pasta', nome], a.env, {raiz:a.raiz, deps:falso({status:{psql:2}}).deps})), 'CONFERENCIA_FALHOU');
        assert.equal(await recusaAsync(t.principal(['conferir', '--pasta', nome], a.env, {raiz:a.raiz, deps:falso({psql:'Password:'}).deps})), 'IDENTIDADE_DIVERGENTE');
        assert.equal(await recusaAsync(t.principal(['conferir', '--pasta', nome, '--banco', 'kidmais_navegador_x'], a.env, {raiz:a.raiz, deps:f.deps})), 'BANCO_FORA_DO_PADRAO');
    } finally { a.limpar(); }
});

test('pasta: recusa travessia, fora da raiz, nome fora do padrão, link, arquivo e marca ausente/divergente', () => {
    const a = ambiente();
    try {
        const {nome, pasta} = pastaMarcada(a.raiz);
        assert.equal(t.validarPasta(nome, a.raiz).cluster, 'kidmais_concorrencia');
        assert.equal(t.validarPasta(pasta, a.raiz).porta, 55480, 'caminho absoluto dentro da raiz');
        const fora = path.join(a.base, `.local-concorrencia-pg-${'b'.repeat(32)}`);
        fs.mkdirSync(fora);
        for (const [texto, codigo] of [
            [`../.local-concorrencia-pg-${'b'.repeat(32)}`, 'PASTA_FORA_DA_RAIZ'], [fora, 'PASTA_FORA_DA_RAIZ'], ['..', 'PASTA_FORA_DA_RAIZ'],
            [`${nome}/dados`, 'PASTA_FORA_DA_RAIZ'], [`${nome}/../../repo/${nome}/x`, 'PASTA_FORA_DA_RAIZ'], ['.', 'PASTA_FORA_DA_RAIZ'],
            ['.git', 'PASTA_NOME_INVALIDO'], ['node_modules', 'PASTA_NOME_INVALIDO'], ['.local-reenvio-pg-20261002', 'PASTA_NOME_INVALIDO'],
            [`.local-producao-pg-${GUID}`, 'PASTA_NOME_INVALIDO'], [`.local-concorrencia-pg-${GUID.toUpperCase()}`, 'PASTA_NOME_INVALIDO'],
            [`.local-concorrencia-pg-${'c'.repeat(32)}`, 'PASTA_INEXISTENTE'], ['', 'PASTA_AUSENTE']])
            assert.equal(recusaDe(() => t.validarPasta(texto, a.raiz)), codigo, texto);
        assert.equal(t.validarPasta(`${nome}/../${nome}`, a.raiz).nome, nome, '".." que volta para a mesma pasta é normalizado');

        const ligada = `.local-concorrencia-pg-${'d'.repeat(32)}`; // junção/link apontando para fora
        fs.symlinkSync(fora, path.join(a.raiz, ligada), 'junction');
        fs.writeFileSync(path.join(fora, t.MARCA), JSON.stringify({ferramenta:t.FERRAMENTA, versao:1, guid:'d'.repeat(32), cluster:'kidmais_concorrencia', porta:55480, pasta:ligada}));
        assert.equal(recusaDe(() => t.validarPasta(ligada, a.raiz)), 'PASTA_LINK_OU_ARQUIVO');
        const arquivo = `.local-concorrencia-pg-${'e'.repeat(32)}`;
        fs.writeFileSync(path.join(a.raiz, arquivo), '');
        assert.equal(recusaDe(() => t.validarPasta(arquivo, a.raiz)), 'PASTA_LINK_OU_ARQUIVO');

        const semMarca = `.local-concorrencia-pg-${'f'.repeat(32)}`;
        fs.mkdirSync(path.join(a.raiz, semMarca));
        assert.equal(recusaDe(() => t.validarPasta(semMarca, a.raiz)), 'MARCA_AUSENTE');
        fs.mkdirSync(path.join(a.raiz, semMarca, t.MARCA));
        assert.equal(recusaDe(() => t.validarPasta(semMarca, a.raiz)), 'MARCA_INVALIDA', 'marca que é pasta');
        const g = '1'.repeat(32);
        const {nome: quebrada} = pastaMarcada(a.raiz, {guid:g});
        fs.writeFileSync(path.join(a.raiz, quebrada, t.MARCA), '{não é json');
        assert.equal(recusaDe(() => t.validarPasta(quebrada, a.raiz)), 'MARCA_INVALIDA');
        for (const [i, marca] of [{guid:'2'.repeat(32)}, {cluster:'kidmais_navegador'}, {porta:55481}, {porta:'55480'}, {pasta:'outra'}, {ferramenta:'outra'}, {versao:2}].entries()) {
            const {nome: n} = pastaMarcada(a.raiz, {guid:String(i + 3).repeat(32), marca});
            assert.equal(recusaDe(() => t.validarPasta(n, a.raiz)), 'MARCA_DIVERGENTE', JSON.stringify(marca));
        }
        const nav = pastaMarcada(a.raiz, {cluster:'kidmais_navegador', guid:'0'.repeat(32), marca:{cluster:'kidmais_concorrencia', porta:55480}});
        assert.equal(recusaDe(() => t.validarPasta(nav.nome, a.raiz)), 'MARCA_DIVERGENTE', 'prefixo navegador com marca de concorrência');
    } finally { a.limpar(); }
});

test('remover: só pasta marcada, parada e sem links; tudo o mais fica intacto', async () => {
    const a = ambiente();
    try {
        const f = falso();
        const {pasta} = await t.principal(['criar', '--cluster', 'kidmais_concorrencia', '--criar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps});
        const dados = path.join(a.raiz, pasta, 'dados');
        const vizinho = path.join(a.raiz, 'arquivo-do-usuario.txt');
        fs.writeFileSync(vizinho, 'preservar');
        const rem = deps => t.principal(['remover', '--pasta', pasta, '--remover-autorizado'], a.env, {raiz:a.raiz, deps});

        fs.writeFileSync(path.join(dados, 'postmaster.pid'), '1');
        assert.equal(await recusaAsync(rem(f.deps)), 'SERVIDOR_EM_EXECUCAO', 'postmaster.pid presente');
        fs.rmSync(path.join(dados, 'postmaster.pid'));
        for (const s of [0, 4, null]) assert.equal(await recusaAsync(rem(falso({status:{pgStatus:s}}).deps)), 'SERVIDOR_EM_EXECUCAO', `pg_ctl status ${s}`);

        const externo = fs.mkdtempSync(path.join(a.base, 'externo-'));
        fs.writeFileSync(path.join(externo, 'nao-apagar.txt'), 'x');
        fs.mkdirSync(path.join(dados, 'pg_tblspc'));
        fs.symlinkSync(externo, path.join(dados, 'pg_tblspc', '16384'), 'junction');
        assert.equal(await recusaAsync(rem(f.deps)), 'LINK_NA_PASTA');
        assert.ok(fs.existsSync(path.join(externo, 'nao-apagar.txt')));
        fs.unlinkSync(path.join(dados, 'pg_tblspc', '16384'));

        assert.equal(await recusaAsync(t.principal(['remover', '--pasta', pasta, '--remover-autorizado'], {...a.env, DATABASE_URL:'x'}, {raiz:a.raiz, deps:f.deps})), 'CONEXAO_HERDADA');
        const r = await rem(f.deps);
        assert.equal(r.resultado, 'REMOVIDO');
        assert.equal(fs.existsSync(path.join(a.raiz, pasta)), false);
        assert.ok(fs.existsSync(vizinho) && fs.existsSync(path.join(a.raiz, '.gitignore')) && fs.existsSync(path.join(externo, 'nao-apagar.txt')));
        assert.equal(await recusaAsync(rem(f.deps)), 'PASTA_INEXISTENTE', 'segunda remoção é recusada');
    } finally { a.limpar(); }
});

test('parar: pg_ctl stop fast na pasta marcada; falha se postmaster.pid continuar', async () => {
    const a = ambiente();
    try {
        const f = falso();
        const {pasta} = await t.principal(['criar', '--cluster', 'kidmais_concorrencia', '--criar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps});
        assert.equal((await t.principal(['parar', '--pasta', pasta, '--parar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps})).resultado, 'PARADO');
        assert.deepEqual(f.chamadas.at(-1).args.slice(2), ['-m', 'fast', '-w', '-t', '60', 'stop']);
        fs.writeFileSync(path.join(a.raiz, pasta, 'dados', 'postmaster.pid'), '1');
        assert.equal(await recusaAsync(t.principal(['parar', '--pasta', pasta, '--parar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps})), 'PARADA_FALHOU');
        assert.equal(await recusaAsync(t.principal(['parar', '--pasta', '../fora', '--parar-autorizado'], a.env, {raiz:a.raiz, deps:f.deps})), 'PASTA_FORA_DA_RAIZ');
    } finally { a.limpar(); }
});

test('processo real: plano não executa nada nem cria pasta; subcomando sem flag é recusado', () => {
    const antes = fs.readdirSync(RAIZ_REAL).filter(n => n.startsWith('.local-')).sort();
    const rodar = args => spawnSync(process.execPath, [ARQUIVO, ...args], {encoding:'utf8', cwd:RAIZ_REAL,
        env:{SystemRoot:process.env.SystemRoot, PATH:'', [t.VAR_BIN]:path.join(os.tmpdir(), 'kidmais-sem-binarios')}, timeout:30000});
    let r = rodar(['plano']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual([j.modo, j.executa, j.gitignore.ignorada, j.clusters.length], ['PLANO', false, true, 2]);
    assert.equal(rodar([]).status, 0);
    for (const args of [['criar', '--cluster', 'kidmais_concorrencia'], ['remover', '--pasta', `.local-concorrencia-pg-${GUID}`], ['iniciar']]) {
        r = rodar(args);
        assert.equal(r.status, 1, args.join(' ')); assert.match(r.stderr, /^CLUSTER_DESCARTAVEL_RECUSADO /);
    }
    assert.deepEqual(fs.readdirSync(RAIZ_REAL).filter(n => n.startsWith('.local-')).sort(), antes);
});

test('fonte: sem arquivos de ambiente, sem nomes de bancos reais, sem SQL de escrita, sem shell, só 127.0.0.1', () => {
    for (const proibido of [/kidmais_manager|kidmais_staging|kidmais_production/i, /DROP\s|DELETE\s+FROM|TRUNCATE|CREATE\s+DATABASE|ALTER\s+SYSTEM/i,
        /['"`][^'"`\n]*\.env|dotenv|--env-file/, /onrender\.com|asaas\.com/i, /shell:\s*true/, /listen_addresses\s*=\s*'\*'|0\.0\.0\.0/, /recursive:\s*true,\s*force:\s*true/])
        assert.doesNotMatch(fonte, proibido, String(proibido));
    assert.equal(fonte.match(/fs\.rmSync\(/g).length, 1, 'uma única remoção, dentro de remover()');
    const corpo = fonte.slice(fonte.indexOf('async function remover('), fonte.indexOf('const ACOES'));
    const ordem = ['validarPasta(', 'postmaster.pid', "'status'", 'semLinks(', 'fs.rmSync('].map(x => corpo.indexOf(x));
    assert.ok(ordem.every((i, k) => i >= 0 && (k === 0 || i > ordem[k - 1])), JSON.stringify(ordem));
});
