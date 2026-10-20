/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da janela S3+S4 de staging (20/10/2026): executados DE VERDADE com bash num deploy temporário (só as
// pastas diferem das do staging). O script transportado roda a partir da pasta própria; fora do Render ele recusa ANTES de
// qualquer leitura de banco, rede ou disco. O executor da rodada 3 e o script da janela são substituídos por falsos nos
// testes de S4-INICIAR/S4-ENCERRAR. Inclui colagem interativa (bash -i) e colagem truncada. Nenhum acesso a /opt.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-s3s4-staging-20261020.cjs');
const h = require('./homologacao-pagamento-renovacao-staging.cjs');
const j = require('./s3s4-staging-20261020.cjs');
const root = path.resolve(__dirname, '..');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const PASTA = '.kidmais-s3s4-staging-20261020';
const CAND = '321c9d50b0685fc97bd1293acc519c51f88f9688';
const CHAVE = '$aact_hmlg_SINTETICAnaoREAL0123456789abcdef';

/** Deploy temporário com cópias LF dos arquivos conferidos (como no checkout do Render) e a pasta da rodada 3. */
function deploy() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-s3s4-'));
    for (const a of j.DEPLOY_S4) {
        fs.mkdirSync(path.dirname(path.join(d, a)), {recursive:true});
        fs.writeFileSync(path.join(d, a), fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n'));
    }
    fs.mkdirSync(path.join(d, b.DIR_R3), {recursive:true}); fs.writeFileSync(path.join(d, b.DIR_R3, 'outro.json'), '{}');
    fs.mkdirSync(path.join(d, 'tmp'));
    fs.writeFileSync(path.join(d, 'falso-s3s4.cjs'), "require('fs').appendFileSync(process.env.FALSO_LOG, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exitCode = Number(process.env.FALSO_CODIGO || 0);\n");
    fs.writeFileSync(path.join(d, 'falso-s4.cjs'), "console.log('EXECUTOR_FALSO ' + process.argv.slice(2).join(' ')); require('fs').writeFileSync(process.env.FALSO_MARCA, 'x'); process.exitCode = Number(process.env.FALSO_S4_CODIGO || 0);\n");
    return d;
}
function sessao(d, conteudo, opcoes = {}) {
    const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : b.SERVICO;
    const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
    const env = {...process.env, TMPDIR:posix(path.join(d, 'tmp')), FALSO_LOG:path.join(d, 'falso.log'), FALSO_MARCA:path.join(d, 'marca-s4'), ...(opcoes.env ?? {})};
    for (const k of Object.keys(env)) if (/^(RENDER|DATABASE_|KIDMAIS_|PG|ASAAS_|EMAIL_|RESEND_)/.test(k)) delete env[k];
    Object.assign(env, {KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox', ASAAS_API_KEY:CHAVE});
    if (servico !== undefined) env.RENDER_SERVICE_ID = servico;
    const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input:fs.readFileSync(f), encoding:'utf8', env})
        : spawnSync('bash', [f], {encoding:'utf8', env});
    fs.rmSync(f, {force:true});
    return {status:r.status, saida:(r.stdout || '') + (r.stderr || '')};
}
const falsos = d => ({s3s4:`node '${posix(path.join(d, 'falso-s3s4.cjs'))}'`, s4:`node '${posix(path.join(d, 'falso-s4.cjs'))}'`});
const gerar = (d, modo, extra = {}) => b.gerar({modo, rotulo:'abcdef1', candidata:CAND, destino:posix(path.join(d, PASTA)), deploy:posix(d), espera:0, ...extra});
const rodar = (d, modo, extra, opcoes) => sessao(d, gerar(d, modo, extra), opcoes);
const codigo = s => [...s.matchAll(/^CODIGO_SAIDA_BLOCO=(\d+)$/gm)].map(x => Number(x[1])).at(-1);
const presentes = d => b.TRANSPORTADOS.filter(a => fs.existsSync(path.join(d, PASTA, a)));
const chamadas = d => (fs.existsSync(path.join(d, 'falso.log')) ? fs.readFileSync(path.join(d, 'falso.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const intactos = d => j.DEPLOY_S4.every(a => fs.readFileSync(path.join(d, a), 'utf8') === fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n'))
    && fs.readdirSync(path.join(d, b.DIR_R3)).includes('outro.json');
const limpar = d => fs.rmSync(d, {recursive:true, force:true});
/** Sonda do bash interativo: a expressão aritmética só aparece avaliada ("_2") se o shell EXECUTOU a linha. */
const BASH_INTERATIVO = /SONDA_INTERATIVO_2/.test((r => (r.stdout || '') + (r.stderr || ''))(
    spawnSync('bash', ['--norc', '--noprofile', '-i'], {input:'echo SONDA_INTERATIVO_$((1+1))\n', encoding:'utf8', timeout:20000})));

test('dez blocos oficiais: ≤ 32 KB, ASCII, bind e guarda do staging antes de tudo, subshell, código impresso, sem segredo', () => {
    assert.deepEqual(Object.keys(b.MODOS), ['PRE', 'ARQUIVAR', 'JANELA', 'S4-INICIAR', 'S4-ACOMPANHAR', 'S4-ENCERRAR', 'S3-ANTES', 'S3-DEPOIS', 'S4N-DEPOIS', 'POS']);
    for (const modo of Object.keys(b.MODOS)) {
        const x = b.gerar({modo, rotulo:'abcdef1', candidata:CAND});
        assert.ok(Buffer.byteLength(x) <= 32768, modo + ' ' + Buffer.byteLength(x));
        assert.match(x, /^[\x09\x0a\x20-\x7e]*$/);
        const L = x.split('\n'), i = L.findIndex(l => l.startsWith('if [ "$RENDER_SERVICE_ID" != "srv-daif418ae00c73e8k2gg" ]'));
        assert.ok(i > 0 && L.slice(0, i).every(l => l.startsWith('#') || l.startsWith('bind ')), modo);
        assert.equal(L[i - 1], "bind 'set enable-bracketed-paste off' 2>/dev/null");
        assert.equal(L[i + 1], '('); assert.ok(L.includes(')') && L.includes('echo "CODIGO_SAIDA_BLOCO=$?"') && L.at(-2) === 'fi');
        assert.match(x, /SHELL_ERRADO_NAO_E_STAGING/); assert.match(x, new RegExp('# Candidata \\(commit que o deploy de W1 deve por no ar\\): ' + CAND));
        assert.doesNotMatch(x, /ASAAS_API_KEY|\$aact_|RESEND_API_KEY|DATABASE_URL|access_token/);
        assert.equal(L.filter(l => /^conf scripts\/[a-z0-9-]+\.cjs [0-9a-f]{64}$/.test(l)).length, j.DEPLOY_S4.length, modo);
        assert.ok(L.indexOf('echo "DEPLOY_CONFERIDO 6"') < L.findIndex(l => l.startsWith('node ') || l.startsWith('nohup ')), 'deploy conferido antes de qualquer node');
        assert.doesNotMatch(x, /rm -rf -- '\/opt|\/opt\/render\/project\/src\/(scripts|lib|data)/, 'só a pasta própria e caminhos relativos do disco');
        const flag = (x.match(new RegExp(h.FLAG.replace(/-/g, '\\-'), 'g')) || []).length, encerrar = (x.match(new RegExp(h.FLAG_ENCERRAR.replace(/-/g, '\\-'), 'g')) || []).length;
        assert.equal(flag, modo === 'S4-INICIAR' ? 1 : 0, modo); assert.equal(encerrar, modo === 'S4-ENCERRAR' ? 1 : 0, modo);
    }
    const ini = b.gerar({modo:'S4-INICIAR', rotulo:'abcdef1', candidata:CAND});
    assert.ok(ini.indexOf('--janela --candidata=' + CAND) < ini.indexOf('nohup '), 'a JANELA roda antes do executor');
    assert.match(ini, /^set -o noclobber$/m); assert.match(ini, new RegExp(`^nohup node --experimental-strip-types scripts/homologacao-pagamento-renovacao-staging\\.cjs ${h.FLAG} > '${b.LOG_R3}' 2>&1 < /dev/null &$`, 'm'));
    assert.match(b.gerar({modo:'S3-ANTES', rotulo:'abcdef1', candidata:CAND}), new RegExp(`^node scripts/s3s4-staging-20261020\\.cjs --s3-antes --candidata=${CAND} ${j.CNPJ_S3R} \\|\\| codigo=\\$\\?$`, 'm'));
    assert.match(b.gerar({modo:'S4N-DEPOIS', rotulo:'abcdef1', candidata:CAND}), new RegExp(` --s4n-depois --candidata=${CAND} ${j.CNPJ_TESTE_S3} `));
    assert.match(b.gerar({modo:'PRE', rotulo:'abcdef1', candidata:CAND}), /^node scripts\/s3s4-staging-20261020\.cjs --pre \|\| codigo=\$\?$/m);
    assert.throws(() => b.gerar({modo:'X', rotulo:'abcdef1', candidata:CAND}), /MODO_DESCONHECIDO/);
    assert.throws(() => b.gerar({modo:'PRE', rotulo:'abc; rm -rf /', candidata:CAND}), /ROTULO_INVALIDO/);
    assert.throws(() => b.gerar({modo:'PRE', rotulo:'abcdef1', candidata:'321c9d5'}), /CANDIDATA_INVALIDA/);
    assert.equal(b.LOG_R3, 'data/homologacao-planos-cotacao-20261010/pagamento-renovacao-saida.log');
});

test('carga e deploy conferido: sha LF da árvore', () => {
    assert.deepEqual(b.carga(root).map(x => x.arquivo), [...b.TRANSPORTADOS]);
    for (const x of [...b.carga(root), ...b.conferidos(root)]) assert.equal(x.sha, sha(fs.readFileSync(path.join(root, x.arquivo), 'utf8').replace(/\r\n/g, '\n')), x.arquivo);
});

test('shell de outro serviço (produção) ou sem RENDER_SERVICE_ID não executa nada, em nenhum bloco', () => {
    for (const servico of ['srv-dak77m2d0e5s73b8rkkg', undefined]) {
        const d = deploy();
        try {
            for (const modo of Object.keys(b.MODOS)) {
                const s = rodar(d, modo, falsos(d), {servico});
                assert.match(s.saida, /SHELL_ERRADO_NAO_E_STAGING/); assert.equal(codigo(s.saida), undefined, modo);
            }
            assert.equal(fs.existsSync(path.join(d, PASTA)), false); assert.deepEqual(chamadas(d), []); assert.ok(intactos(d));
        } finally { limpar(d); }
    }
});

test('blocos com o script real: transportam e conferem; fora do Render o script recusa (1) sem segredo; --plano roda da pasta própria', () => {
    const d = deploy();
    try {
        for (const modo of ['PRE', 'JANELA', 'POS']) {
            const s = rodar(d, modo);
            assert.equal(codigo(s.saida), 1, s.saida); assert.match(s.saida, /DEPLOY_CONFERIDO 6/); assert.match(s.saida, /ARQUIVOS_OK 2/);
            assert.match(s.saida, /"motivo":"FORA_DO_RENDER"/); assert.ok(!s.saida.includes(CHAVE));
        }
        assert.deepEqual(presentes(d), [...b.TRANSPORTADOS]);
        for (const x of b.carga(root)) assert.equal(sha(fs.readFileSync(path.join(d, PASTA, x.arquivo))), x.sha, x.arquivo);
        const p = sessao(d, gerar(d, 'PRE').replace(/--pre \|\| codigo/, '--plano || codigo'));
        assert.equal(codigo(p.saida), 0, p.saida); assert.match(p.saida, /"resultado":"PLANO"/); assert.match(p.saida, /JA_PRESENTE scripts\/s3s4-staging-20261020\.cjs/);
        assert.equal(fs.readdirSync(path.join(d, 'tmp')).length, 0, 'temporário removido');
        assert.ok(intactos(d));
    } finally { limpar(d); }
});

test('recusas do bloco (código 4, nada roda): arquivo do deploy divergente, presente diferente, carga corrompida', () => {
    const d = deploy();
    try {
        fs.appendFileSync(path.join(d, j.DEPLOY_S4[0]), '// alterado\n');
        const s = rodar(d, 'PRE', falsos(d));
        assert.equal(codigo(s.saida), 4); assert.match(s.saida, new RegExp('DEPLOY_DIVERGENTE ' + j.DEPLOY_S4[0].replace(/\./g, '\\.')));
        assert.deepEqual(chamadas(d), []); assert.equal(fs.existsSync(path.join(d, PASTA)), false);
        fs.writeFileSync(path.join(d, j.DEPLOY_S4[0]), fs.readFileSync(path.join(root, j.DEPLOY_S4[0]), 'utf8').replace(/\r\n/g, '\n'));
        fs.mkdirSync(path.join(d, PASTA, 'scripts'), {recursive:true}); fs.writeFileSync(path.join(d, PASTA, b.TRANSPORTADOS[0]), '// outro\n');
        const x = rodar(d, 'JANELA', falsos(d));
        assert.equal(codigo(x.saida), 4); assert.match(x.saida, /JA_EXISTE_DIFERENTE scripts\/s3s4-staging-20261020\.cjs/);
        assert.equal(fs.readFileSync(path.join(d, PASTA, b.TRANSPORTADOS[0]), 'utf8'), '// outro\n'); assert.deepEqual(chamadas(d), []);
        fs.rmSync(path.join(d, PASTA), {recursive:true});
        const bloco = gerar(d, 'POS', falsos(d)), i = bloco.indexOf("<<'B64'\n") + 200;
        const c = sessao(d, bloco.slice(0, i) + (bloco[i] === 'A' ? 'B' : 'A') + bloco.slice(i + 1));
        assert.equal(codigo(c.saida), 4); assert.match(c.saida, /CONTEUDO_DIVERGENTE/); assert.deepEqual(presentes(d), []); assert.deepEqual(chamadas(d), []);
        assert.ok(intactos(d));
    } finally { limpar(d); }
});

test('S4-INICIAR: só inicia com a JANELA em 0; log no disco sem sobrescrever; argumentos exatos', () => {
    const d = deploy();
    try {
        const recusa = rodar(d, 'S4-INICIAR', falsos(d), {env:{FALSO_CODIGO:'2'}});
        assert.equal(codigo(recusa.saida), 2); assert.match(recusa.saida, /S4_NAO_INICIADO/);
        assert.equal(fs.existsSync(path.join(d, 'marca-s4')), false); assert.equal(fs.existsSync(path.join(d, b.LOG_R3)), false);
        assert.deepEqual(chamadas(d), [['--janela', '--candidata=' + CAND]]);
        fs.rmSync(path.join(d, 'falso.log'));
        const ok = rodar(d, 'S4-INICIAR', falsos(d));
        assert.equal(codigo(ok.saida), 0, ok.saida); assert.match(ok.saida, /S4_INICIADO PID=\d+/);
        for (let t = 0; t < 100 && !fs.existsSync(path.join(d, 'marca-s4')); t++) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
        assert.ok(fs.existsSync(path.join(d, 'marca-s4')), 'executor (falso) iniciado em segundo plano');
        assert.equal(fs.readFileSync(path.join(d, b.LOG_R3), 'utf8').trim(), 'EXECUTOR_FALSO ' + h.FLAG);
        assert.deepEqual(chamadas(d), [['--janela', '--candidata=' + CAND], ['--s4-acompanhar']]);
        fs.rmSync(path.join(d, 'marca-s4')); fs.writeFileSync(path.join(d, b.LOG_R3), 'tentativa anterior\n');
        const dup = rodar(d, 'S4-INICIAR', falsos(d));
        assert.equal(codigo(dup.saida), 4); assert.match(dup.saida, /LOG_R3_PRESENTE/);
        assert.equal(fs.readFileSync(path.join(d, b.LOG_R3), 'utf8'), 'tentativa anterior\n'); assert.equal(fs.existsSync(path.join(d, 'marca-s4')), false);
        assert.ok(intactos(d));
    } finally { limpar(d); }
});

test('S4-ENCERRAR: roda a recuperação do executor com a flag própria, guarda a saída no disco e devolve o código dele', () => {
    const d = deploy();
    try {
        const s = rodar(d, 'S4-ENCERRAR', falsos(d), {env:{FALSO_S4_CODIGO:'2'}});
        assert.equal(codigo(s.saida), 2, s.saida); assert.match(s.saida, new RegExp('EXECUTOR_FALSO ' + h.FLAG_ENCERRAR));
        assert.equal(fs.readFileSync(path.join(d, b.LOG_ENCERRAR), 'utf8').trim(), 'EXECUTOR_FALSO ' + h.FLAG_ENCERRAR);
        assert.deepEqual(chamadas(d), [['--s4-acompanhar']]);
        assert.ok(intactos(d));
    } finally { limpar(d); }
});

test('colagem interativa (bash -i) funciona; colagem truncada não executa nada',
    {skip:BASH_INTERATIVO ? false : 'bash interativo (bash -i com stdin em pipe) indisponível neste ambiente'}, () => {
        const d = deploy();
        try {
            const s = sessao(d, gerar(d, 'JANELA', falsos(d)), {interativo:true});
            assert.equal(codigo(s.saida), 0, s.saida); assert.deepEqual(presentes(d), [...b.TRANSPORTADOS]);
            fs.rmSync(path.join(d, PASTA), {recursive:true}); fs.rmSync(path.join(d, 'falso.log'));
            const bloco = gerar(d, 'S4-INICIAR', falsos(d));
            const t = sessao(d, bloco.slice(0, Math.floor(bloco.length / 2)), {interativo:true});
            assert.equal(codigo(t.saida), undefined); assert.equal(fs.existsSync(path.join(d, PASTA)), false);
            assert.deepEqual(chamadas(d), []); assert.equal(fs.existsSync(path.join(d, 'marca-s4')), false);
            assert.ok(intactos(d));
        } finally { limpar(d); }
    });
