/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell do B-14 (§3.11, §11 item 4): executados DE VERDADE com bash num deploy temporário FORA do clone (só as
// pastas diferem das do Render). A árvore entregue roda a entrada a partir da própria pasta, com pg e zod do node_modules
// do "deploy" (junção para o do clone): FILA e CONFERIR terminam em ASAAS_DESLIGADO (1) — prova de que a árvore carrega
// todos os módulos sem o checkout. Inclui uma colagem em PTY REAL (script do util-linux: MSYS2 no Windows, nativo no Linux),
// com bracketed paste, dos maiores blocos. Não toca banco, rede nem /opt.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process'), { createHash } = require('node:crypto');
const b = require('./bloco-shell-recuperacao-b14.cjs');
const { arvore } = require('./arvore-recuperacao-b14.cjs');
const root = path.resolve(__dirname, '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const posix = (p) => p.replace(/\\/g, '/');
const CAND = 'c'.repeat(40);
const A = arvore(root);
const NODE = process.version.slice(1);

/** Deploy temporário: node_modules (junção ao do clone) e lib/ com o conteúdo LF da árvore (equivalência total). */
function deploy() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-b14-'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'), 'junction');
    for (const x of A.arquivos.filter((y) => y.arquivo.startsWith('lib/'))) {
        fs.mkdirSync(path.dirname(path.join(d, x.arquivo)), { recursive: true });
        fs.writeFileSync(path.join(d, x.arquivo), x.conteudo);
    }
    fs.mkdirSync(path.join(d, 'tmp'));
    return d;
}
const limpar = (d) => { fs.rmSync(path.join(d, 'node_modules'), { force: true, recursive: false }); fs.rmSync(d, { recursive: true, force: true }); };
const opcoes = (d, extra = {}) => ({ ambiente: 'production', candidata: CAND, deploy: posix(d), evidencias: posix(path.join(d, 'data/b14')), runtimeNode: NODE, ...extra });
const gerar = (d, bloco, extra) => b.gerar({ ...opcoes(d, extra), bloco });
function sessao(d, conteudo, o = {}) {
    const servico = Object.hasOwn(o, 'servico') ? o.servico : b.AMBIENTES.production.servico;
    const f = d + `-sessao-${Math.random().toString(36).slice(2, 8)}.sh`;
    fs.writeFileSync(f, conteudo);
    const env = { ...process.env, TMPDIR: posix(path.join(d, 'tmp')) };
    for (const k of Object.keys(env)) if (/^(RENDER|DATABASE_|KIDMAIS_|PG|ASAAS_|CREDITOS_)/.test(k)) delete env[k];
    Object.assign(env, o.env ?? {});
    if (servico !== undefined) env.RENDER_SERVICE_ID = servico;
    const r = o.interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], { input: fs.readFileSync(f), encoding: 'utf8', env, maxBuffer: 1 << 24 })
        : spawnSync('bash', [f], { encoding: 'utf8', env, maxBuffer: 1 << 24 });
    fs.rmSync(f, { force: true });
    return { status: r.status, saida: (r.stdout || '') + (r.stderr || '') };
}
const codigo = (s) => [...s.matchAll(/^CODIGO_SAIDA_BLOCO=(\d+)$/gm)].map((x) => Number(x[1])).at(-1);
const destino = (d) => path.join(d, '.kidmais-recuperacao-b14', A.shaArvore.slice(0, 16));
const nPartes = b.partes(A).length;
function entregar(d, exceto = []) {
    for (let k = 1; k <= nPartes; k++) {
        if (exceto.includes(k)) continue;
        const r = sessao(d, gerar(d, `ENTREGA-${k}`));
        assert.equal(codigo(r.saida), 0, `ENTREGA-${k}\n${r.saida.slice(-600)}`);
        assert.match(r.saida, new RegExp(`PARTE_OK ${k}/${nPartes}`));
    }
}
const ENV_JANELA = { KIDMAIS_B14_MIGRACOES: '089,090,091,092,093,094,095,096,097,099,100', KIDMAIS_B14_DESDE: '2026-10-28T10:00:00Z', KIDMAIS_B14_ATE: '2026-10-28T11:00:00Z' };

test('árvore mínima: fecho de execução, LF, lista fechada de externos, SHA256SUMS e hash estáveis', () => {
    const outra = arvore(root);
    assert.equal(outra.shaArvore, A.shaArvore, 'determinística');
    assert.equal(A.sha256sums.split('\n').filter(Boolean).length, A.arquivos.length);
    for (const x of A.arquivos) { assert.ok(!x.conteudo.includes(13), `sem CR ${x.arquivo}`); assert.equal(sha(x.conteudo), x.sha); }
    const nomes = A.arquivos.map((x) => x.arquivo);
    for (const f of ['scripts/recuperacao-pagamentos-producao.cjs', 'scripts/assinatura-reconciliar.cjs', 'lib/assinatura/recuperacao-modos.ts',
        'lib/assinatura/recuperacao-execucao.ts', 'lib/creditos/pagamento.ts', 'lib/creditos/fila.ts'.replace('fila', 'ledger'), 'package.json'])
        assert.ok(nomes.includes(f), f);
    // Reexportação carrega o módulo (`export { ROTA_AJUDA } from './rota.ts'` em lib/suporte/canais.ts).
    assert.ok(nomes.includes('lib/suporte/rota.ts'), 'reexportação entra no fecho');
    const { especificadores } = require('./arvore-recuperacao-b14.cjs');
    assert.deepEqual(especificadores("export { a } from './x.ts';\nexport * from './y.ts';\nexport * as z from './w.ts';\nexport type { T } from './t.ts';\nimport type { U } from './u.ts';\nimport { v } from './v.ts';\nawait import('./d.ts');\n"),
        ['./x.ts', './y.ts', './w.ts', './v.ts', './d.ts']);
    // Revisão do incremento 5 (P3): contraexemplo do Astra — comentário depois de `import type` não engole o import seguinte.
    assert.deepEqual(especificadores("import type { U } from './u.ts'; // nota\nimport { v } from './v.ts';\n"), ['./v.ts']);
    assert.deepEqual(especificadores("import type { U } from './u.ts' /* ; */\nimport './efeito.ts'\nimport { type W, w } from './w.ts';\nexport type * from './t.ts';\n"),
        ['./efeito.ts', './w.ts']);
    assert.deepEqual(especificadores("// import { a } from './comentario.ts';\nconst s = \"require('./string.ts')\";\nconst k = require(`./tpl.cjs`);\nimport q = require('./q.ts');\n"),
        ['./tpl.cjs', './q.ts']);
    assert.deepEqual(especificadores("const p = require('pg');\nconst m = await import('node:fs');\n", 'x.cjs'), ['pg', 'node:fs']);
    // require.main / require.resolve não carregam módulo: admitidos; import.meta.url também.
    assert.deepEqual(especificadores("if (require.main === module) {}\nconst u = import.meta.url;\nconst c = require.cache;\nconst v = obj[k];\nconst w = mapa['chave'];\n", 'x.cjs'), []);
    // Dinâmico não literal: recusa (o fecho não seria determinável).
    for (const t of ["const n = './a.ts'; await import(n);", "await import('./' + nome);", "require(`./${x}.cjs`);", "require(alvo);",
        // P3-R1-3 (revisão da rodada 1): carregadores indiretos.
        "const r = require; r('./x.cjs');", "module.require('./x.cjs');", "const { createRequire } = require('node:module'); createRequire(__filename)('./x.cjs');",
        "import { createRequire as c } from 'node:module';", "import.meta.resolve('./x.ts');", "carregar(require);", "Module._load('./x.cjs');", "process.dlopen(m, f);",
        // Aprovação com ressalvas do incremento 5 (P3): colchetes e require.call/apply/bind (as três provas do Astra e vizinhas).
        "module['require']('./x.cjs');", "require('node:module')['createRequire'](__filename)('./x.cjs');", "require.call(null, './x.cjs');",
        "require.apply(null, ['./x.cjs']);", "const r = require.bind(null); r('./x.cjs');", "require['call'](null, './x.cjs');", "module[chave]('./x.cjs');",
        "globalThis[k]('./x.cjs');", "import.meta[k]('./x.ts');"])
        assert.throws(() => especificadores(t), /DEPENDENCIA_NAO_DETERMINAVEL/, t);
    // Só de tipo: não entra (lib/db/contracts é importado só como tipo).
    assert.ok(!nomes.some((n) => n.startsWith('lib/db/contracts')), 'import type não carrega módulo');
    assert.ok(!nomes.some((n) => /\.test\.|\.postgres\./.test(n)), 'sem testes');
});

test('blocos: ≤ 32 KB, ASCII, guarda antes de tudo, subshell, código impresso, sem segredo, escrita marcada', () => {
    for (const ambiente of ['staging', 'production']) {
        const lista = b.todos({ ambiente, candidata: CAND });
        assert.deepEqual(lista.map((x) => x.bloco), b.nomes(nPartes));
        for (const { bloco, texto } of lista) {
            assert.ok(Buffer.byteLength(texto) <= 32768, `${bloco} ${Buffer.byteLength(texto)}`);
            assert.match(texto, /^[\x09\x0a\x20-\x7e]*$/);
            const L = texto.split('\n'), i = L.findIndex((l) => l.startsWith(`if [ "$RENDER_SERVICE_ID" != "${b.AMBIENTES[ambiente].servico}" ]`));
            assert.ok(i > 0 && L.slice(0, i).every((l) => l.startsWith('#') || l.startsWith('bind ')), bloco);
            assert.equal(L[i + 1], '(');
            assert.ok(L.includes(')') && L.includes('echo "CODIGO_SAIDA_BLOCO=$?"') && L.at(-2) === 'fi');
            assert.doesNotMatch(texto, /DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\/|ASAAS_API_KEY|\$aact/);
            assert.doesNotMatch(texto, /\/opt\/render\/project\/src\/(scripts|lib)\/[a-z]/, 'nunca grava em scripts/ ou lib/ do deploy');
        }
        const t = Object.fromEntries(lista.map((x) => [x.bloco, x.texto]));
        assert.match(t.RECUPERAR, /^# ESCRITA EM PRODUCAO/m);
        assert.match(t['APLICAR-CASO'], /^# ESCRITA EM PRODUCAO/m);
        for (const op of Object.keys(b.OPERACOES)) {
            assert.match(t[op], new RegExp(`export KIDMAIS_B14_ALVO='${b.AMBIENTES[ambiente].alvo.replace(/\./g, '\\.')}'`), op);
            if (op !== 'FILA') assert.match(t[op], new RegExp(`--candidata=${CAND}`), op);
        }
        assert.doesNotMatch(t.FILA, /--migracoes|--candidata/);
        assert.match(t.CONFERIR, /JANELA_EXIGE_LIB_IDENTICA_AO_DEPLOY/);
        assert.doesNotMatch(t.CONFERIR, /CONFERIR_E0_SO_COM_CODIGO_ANTIGO/);
        assert.match(t['CONFERIR-E0'], /CONFERIR_E0_SO_COM_CODIGO_ANTIGO/);
        assert.doesNotMatch(t['CONFERIR-E0'], /JANELA_EXIGE_LIB_IDENTICA_AO_DEPLOY/, 'E0 admite o código antigo');
        assert.doesNotMatch(t.RECUPERAR, /CONFERIR_E0_SO_COM_CODIGO_ANTIGO/);
        assert.match(t.LIMPEZA, /LIMPEZA_SO_NO_ENCERRAMENTO/);
        assert.doesNotMatch(t.INVENTARIO, /JANELA_EXIGE_LIB_IDENTICA_AO_DEPLOY/, 'RESTORE admite o código antigo');
    }
    assert.throws(() => b.gerar({ ambiente: 'production', bloco: 'FILA', candidata: 'x' }), /CANDIDATA_INVALIDA/);
    assert.throws(() => b.gerar({ ambiente: 'qa', bloco: 'FILA', candidata: CAND }), /AMBIENTE_DESCONHECIDO/);
    assert.throws(() => b.gerar({ ambiente: 'production', bloco: 'ENTREGA-99', candidata: CAND }), /BLOCO_DESCONHECIDO/);
});

test('entrega em partes → conferência → a árvore roda FORA do checkout (FILA e CONFERIR carregam todos os módulos)', () => {
    const d = deploy();
    try {
        // Serviço errado: nada executado, nada gravado.
        const errado = sessao(d, gerar(d, 'ENTREGA-1'), { servico: 'srv-outro' });
        assert.match(errado.saida, /SHELL_ERRADO_NAO_E_PRODUCAO/);
        assert.equal(fs.existsSync(destino(d)), false);
        // Entrega parcial: a conferência recusa (arquivos faltando).
        entregar(d, [nPartes]);
        const parcial = sessao(d, gerar(d, 'ENTREGA-CONFERIR'));
        assert.equal(codigo(parcial.saida), 4, parcial.saida.slice(-400));
        assert.match(parcial.saida, /ARVORE_DIVERGENTE/);
        // Completa: ARVORE_OK, equivalência total com o lib/ do "deploy".
        entregar(d, Array.from({ length: nPartes - 1 }, (_, i) => i + 1));
        const ok = sessao(d, gerar(d, 'ENTREGA-CONFERIR'));
        assert.equal(codigo(ok.saida), 0, ok.saida.slice(-600));
        assert.match(ok.saida, new RegExp(`ARVORE_OK ${A.shaArvore} arquivos=${A.arquivos.length}`));
        const libs = A.arquivos.filter((x) => x.arquivo.startsWith('lib/')).length;
        assert.match(ok.saida, new RegExp(`EQUIVALENCIA_LIB iguais=${libs} diferentes=0 de ${libs}`));
        // Colar de novo uma parte: idempotente (JA_PRESENTE), código 0.
        const de_novo = sessao(d, gerar(d, 'ENTREGA-1'));
        assert.equal(codigo(de_novo.saida), 0);
        assert.match(de_novo.saida, /JA_PRESENTE /);

        // FILA a partir da árvore: sem configuração do Asaas a entrada recusa com ASAAS_DESLIGADO (1) — todos os módulos carregaram.
        const fila = sessao(d, gerar(d, 'FILA'), { env: { KIDMAIS_B14_URL_WEBHOOK: 'https://kidmais.example/api/integracoes/asaas/webhook' } });
        assert.equal(codigo(fila.saida), 1, fila.saida.slice(-800));
        assert.match(fila.saida, /"motivo": "ASAAS_DESLIGADO"/);
        assert.doesNotMatch(fila.saida, /ERR_MODULE_NOT_FOUND|Cannot find module/);
        assert.ok(fs.readdirSync(path.join(d, 'data/b14')).some((n) => n.startsWith('execucao-')), 'evidência gravada na pasta de evidências');
        // CONFERIR (JANELA): variáveis ausentes → 4; inválidas → 4; completas → a entrada roda (1, Asaas desligado).
        assert.match(sessao(d, gerar(d, 'CONFERIR')).saida, /VARIAVEL_AUSENTE KIDMAIS_B14_MIGRACOES/);
        const injecao = sessao(d, gerar(d, 'CONFERIR'), { env: { ...ENV_JANELA, KIDMAIS_B14_DESDE: '2026;touch PWNED' } });
        assert.equal(codigo(injecao.saida), 4);
        assert.match(injecao.saida, /VARIAVEL_INVALIDA KIDMAIS_B14_DESDE/);
        assert.equal(fs.existsSync(path.join(destino(d), 'PWNED')), false);
        const conf = sessao(d, gerar(d, 'CONFERIR'), { env: ENV_JANELA });
        assert.equal(codigo(conf.saida), 1, conf.saida.slice(-800));
        assert.match(conf.saida, /EQUIVALENCIA_LIB iguais=\d+ diferentes=0/);
        assert.match(conf.saida, /"motivo": "ASAAS_DESLIGADO"/);

        // lib/ do deploy diferente: JANELA recusa (4); RESTORE segue (o código antigo é admitido pela matriz).
        const umaLib = A.arquivos.find((x) => x.arquivo === 'lib/creditos/pagamento.ts');
        fs.appendFileSync(path.join(d, umaLib.arquivo), '\n// deploy diferente\n');
        const jan = sessao(d, gerar(d, 'CONFERIR'), { env: ENV_JANELA });
        assert.equal(codigo(jan.saida), 4);
        assert.match(jan.saida, /LIB_DIFERENTE_DO_DEPLOY lib\/creditos\/pagamento\.ts[\s\S]*JANELA_EXIGE_LIB_IDENTICA_AO_DEPLOY/);
        const inv = sessao(d, gerar(d, 'INVENTARIO'), { env: { KIDMAIS_B14_MIGRACOES: ENV_JANELA.KIDMAIS_B14_MIGRACOES, KIDMAIS_B14_DESDE: ENV_JANELA.KIDMAIS_B14_DESDE,
            KIDMAIS_B14_REINICIO: '2026-10-28T10:30:00Z', KIDMAIS_B14_DRENAGEM: 'drenagem-x.json' } });
        assert.equal(codigo(inv.saida), 1, inv.saida.slice(-500));
        // CONFERIR-E0 (P2): sem commit conhecido ou com a candidata no ar → 4; com o código antigo → a entrada roda e a
        // diferença de lib/ só é informada.
        for (const commit of [undefined, CAND]) {
            const r = sessao(d, gerar(d, 'CONFERIR-E0'), { env: { ...ENV_JANELA, ...(commit ? { RENDER_GIT_COMMIT: commit } : {}) } });
            assert.equal(codigo(r.saida), 4, r.saida.slice(-400));
            assert.match(r.saida, /CONFERIR_E0_SO_COM_CODIGO_ANTIGO/);
            assert.doesNotMatch(r.saida, /"motivo"/, 'nada executado');
        }
        const e0 = sessao(d, gerar(d, 'CONFERIR-E0'), { env: { ...ENV_JANELA, RENDER_GIT_COMMIT: '00d3019a' + '0'.repeat(32) } });
        assert.equal(codigo(e0.saida), 1, e0.saida.slice(-800));
        assert.match(e0.saida, /EQUIVALENCIA_LIB iguais=\d+ diferentes=1 /);
        assert.doesNotMatch(e0.saida, /LIB_DIFERENTE_DO_DEPLOY|JANELA_EXIGE/);
        assert.match(e0.saida, /"motivo": "ASAAS_DESLIGADO"/);
        fs.writeFileSync(path.join(d, umaLib.arquivo), umaLib.conteudo);

        // Runtime divergente: recusa antes de rodar.
        const rt = sessao(d, b.gerar({ ...opcoes(d, { runtimeNode: '22.0.0' }), bloco: 'FILA' }), { env: { KIDMAIS_B14_URL_WEBHOOK: 'https://k.example/w' } });
        assert.equal(codigo(rt.saida), 4);
        assert.match(rt.saida, /RUNTIME_NODE_DIVERGENTE/);
        // Árvore adulterada ou com arquivo a mais: recusa antes de rodar.
        const alvo = path.join(destino(d), 'lib/assinatura/recuperacao-modos.ts');
        const original = fs.readFileSync(alvo);
        fs.appendFileSync(alvo, '\n');
        assert.match(sessao(d, gerar(d, 'FILA'), { env: { KIDMAIS_B14_URL_WEBHOOK: 'https://k.example/w' } }).saida, /ARVORE_DIVERGENTE/);
        fs.writeFileSync(alvo, original);
        fs.writeFileSync(path.join(destino(d), 'scripts/extra.cjs'), '');
        assert.match(sessao(d, gerar(d, 'FILA'), { env: { KIDMAIS_B14_URL_WEBHOOK: 'https://k.example/w' } }).saida, /ARVORE_COM_ARQUIVO_A_MAIS_OU_A_MENOS/);
        fs.rmSync(path.join(destino(d), 'scripts/extra.cjs'));

        // LIMPEZA: remove a árvore e os arquivos de casos; demais evidências ficam.
        fs.writeFileSync(path.join(d, 'data/b14/casos-11111111-1111-4111-8111-111111111111.json'), '{}');
        fs.writeFileSync(path.join(d, 'data/b14/liberacao-x.json'), '{}');
        // Sem a confirmação do encerramento: nada removido.
        const cedo = sessao(d, gerar(d, 'LIMPEZA'));
        assert.equal(codigo(cedo.saida), 4);
        assert.match(cedo.saida, /LIMPEZA_SO_NO_ENCERRAMENTO/);
        assert.ok(fs.existsSync(path.join(d, 'data/b14/casos-11111111-1111-4111-8111-111111111111.json')) && fs.existsSync(destino(d)));
        assert.equal(codigo(sessao(d, gerar(d, 'LIMPEZA'), { env: { KIDMAIS_B14_ENCERRAMENTO: 'sim' } }).saida), 4, 'só SIM literal');
        const lim = sessao(d, gerar(d, 'LIMPEZA'), { env: { KIDMAIS_B14_ENCERRAMENTO: 'SIM' } });
        assert.equal(codigo(lim.saida), 0, lim.saida.slice(-400));
        assert.match(lim.saida, /ARVORE_REMOVIDA[\s\S]*CASOS_REMOVIDO casos-11111111/);
        assert.equal(fs.existsSync(path.join(d, '.kidmais-recuperacao-b14')), false);
        assert.deepEqual(fs.readdirSync(path.join(d, 'data/b14')).filter((n) => n.startsWith('casos-')), []);
        assert.ok(fs.existsSync(path.join(d, 'data/b14/liberacao-x.json')));
        assert.ok(fs.existsSync(path.join(d, 'lib/creditos/pagamento.ts')), 'lib/ do deploy intacto');
    }
    finally { limpar(d); }
});

test('colagem truncada em bash interativo: subshell não fecha, nada gravado, sem CODIGO_SAIDA_BLOCO', () => {
    const d = deploy();
    try {
        const bloco = gerar(d, 'ENTREGA-1');
        const r = sessao(d, bloco.slice(0, Math.floor(bloco.length / 2)), { interativo: true });
        assert.equal(codigo(r.saida), undefined);
        assert.equal(fs.existsSync(destino(d)), false);
    }
    finally { limpar(d); }
});

/** PTY real: `script` do util-linux (MSYS2 no Windows; nativo no Linux). Sem ele, pula com motivo. */
const SCRIPT = process.platform === 'win32' ? (fs.existsSync('C:\\msys64\\usr\\bin\\script.exe') ? 'C:\\msys64\\usr\\bin\\script.exe' : null)
    : (spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0 ? 'script' : null);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const semEscape = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/\x1b[=>]/g, '').replace(/\x07/g, '');
async function pty(d, blocos) {
    const env = process.platform === 'win32'
        // HB-5: o node da PTY é o mesmo que roda o teste (o bloco recusa runtime diferente de process.version).
        ? { PATH: `C:\\msys64\\usr\\bin;${path.dirname(process.execPath)}`, SYSTEMROOT: process.env.SYSTEMROOT, TERM: 'xterm-256color', HOME: posix(d), TMPDIR: posix(path.join(d, 'tmp')), MSYS: '', CHERE_INVOKING: '1' }
        : { PATH: process.env.PATH, TERM: 'xterm-256color', HOME: d, TMPDIR: path.join(d, 'tmp') };
    env.RENDER_SERVICE_ID = b.AMBIENTES.production.servico;
    const p = spawn(SCRIPT, ['-q', '-e', '-c', `${process.platform === 'win32' ? '/usr/bin/bash' : 'bash'} --norc --noprofile -i`, '/dev/null'], { env, cwd: d, windowsHide: true });
    let raw = '';
    p.stdout.on('data', (x) => { raw += x.toString('latin1'); });
    p.stderr.on('data', (x) => { raw += x.toString('latin1'); });
    const fim = new Promise((r) => p.on('close', r));
    const ate = async (re, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(semEscape(raw))) return true; await espera(100); } return false; };
    const bracketed = () => raw.lastIndexOf('\x1b[?2004h') > raw.lastIndexOf('\x1b[?2004l');
    await ate(/\$ ?$/m, 30000);
    const embrulhos = [];
    for (const [i, texto] of blocos.entries()) {
        await espera(300);
        const emb = bracketed();
        embrulhos.push(emb);
        const corpo = (emb ? '\x1b[200~' : '') + texto.replace(/\n/g, '\r') + (emb ? '\x1b[201~' : '');
        for (let k = 0; k < corpo.length; k += 4096) { p.stdin.write(corpo.slice(k, k + 4096)); await espera(15); }
        if (emb) { await espera(300); p.stdin.write('\r'); }
        await ate(new RegExp(`(?:CODIGO_SAIDA_BLOCO=\\d+[\\s\\S]*){${i + 1}}`));
    }
    p.stdin.write('echo SENTINELA_PTY_$((1+1)) opcoes=$-\r');
    await ate(/SENTINELA_PTY_2/, 20000);
    p.stdin.write('exit\r');
    const t = setTimeout(() => p.kill(), 15000);
    await fim;
    clearTimeout(t);
    const texto = semEscape(raw);
    return { codigos: [...texto.matchAll(/^CODIGO_SAIDA_BLOCO=(\d+)\r?$/gm)].map((x) => Number(x[1])), texto, embrulhos };
}

test('PTY real: colar a maior parte da entrega e a ENTREGA-CONFERIR com bracketed paste; shell do operador intacto', { skip: SCRIPT ? false : 'sem `script` (util-linux) para abrir uma PTY real' }, async () => {
    const d = deploy();
    try {
        const tamanhos = Array.from({ length: nPartes }, (_, i) => [i + 1, Buffer.byteLength(gerar(d, `ENTREGA-${i + 1}`))]);
        const maior = tamanhos.sort((x, y) => y[1] - x[1])[0][0];
        entregar(d, [maior]);
        const r = await pty(d, [gerar(d, `ENTREGA-${maior}`), gerar(d, 'ENTREGA-CONFERIR')]);
        assert.deepEqual(r.codigos, [0, 0], r.texto.slice(-1500));
        assert.match(r.texto, new RegExp(`PARTE_OK ${maior}/${nPartes}`));
        assert.match(r.texto, new RegExp(`ARVORE_OK ${A.shaArvore}`));
        // O shell do operador sobrevive com as opções originais (set -e/-u do corpo ficam no subshell).
        const opc = (r.texto.match(/SENTINELA_PTY_2 opcoes=(\S+)/) || [])[1] ?? '';
        // Revisão do incremento 5 (P3): nem -e nem -u herdados; e a PRIMEIRA colagem foi de fato embrulhada em bracketed paste.
        assert.ok(opc && !/[eu]/.test(opc), `opções do shell do operador: ${opc}`);
        assert.equal(r.embrulhos[0], true, 'a primeira colagem precisa sair com bracketed paste ativo');
    }
    finally { limpar(d); }
});
