/* eslint-disable @typescript-eslint/no-require-imports */
// B-5: blocos de entrega e execução da conferência somente leitura, executados DE VERDADE com bash num deploy temporário
// (só as pastas diferem das de produção; o comando é o real — plano offline ou recusa antes de conectar — ou um substituto
// que só imprime/devolve um código). Mesmas provas do gerador do B-4 (carregador conferido, destino físico, perda de linhas,
// colagem interativa, T/C herdados). Não toca banco, Asaas nem /opt.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto'), zlib = require('node:zlib');
const b = require('./bloco-shell-conferencia-b5-producao.cjs');
const b5 = require('./conferencia-b5-producao.cjs');
const root = path.resolve(__dirname, '..');
const lf = a => fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const ARQ = b.arquivos();
const {partes: PARTES} = b.distribuir(root);
const N = PARTES.length;
const PASTA = b.NOME_DESTINO;
const CURTOS = ['CONFERIR-B5', 'CONFERIR-B5-ESTADO'];
const OK = 'node -e "process.exitCode=0"';
const RODOU = 'echo "CONFERENCIA_RODOU pwd=$PWD"';

function deploy({pg = true, modulosReais = false} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-b5-'));
  if (modulosReais) fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'), 'junction');
  else if (pg) { fs.mkdirSync(path.join(d, 'node_modules/pg'), {recursive: true}); fs.writeFileSync(path.join(d, 'node_modules/pg/package.json'), '{"name":"pg"}'); fs.writeFileSync(path.join(d, 'node_modules/pg/index.js'), 'module.exports={Client:class{}};'); }
  // Arquivo do deploy com o MESMO caminho de um arquivo do pacote: nunca lido, sobrescrito nem removido.
  fs.mkdirSync(path.join(d, 'scripts'), {recursive: true}); fs.writeFileSync(path.join(d, 'scripts/migration-089-comum.cjs'), '// do deploy\r\n');
  fs.mkdirSync(path.join(d, 'data'), {recursive: true}); fs.writeFileSync(path.join(d, 'data/marcador.json'), '{}');
  fs.mkdirSync(path.join(d, 'tmp'));
  return d;
}
function limpar(d) {
  for (const j of ['node_modules', PASTA]) { try { if (fs.lstatSync(path.join(d, j)).isSymbolicLink()) fs.unlinkSync(path.join(d, j)); } catch { /* sem junção */ } }
  fs.rmSync(d, {recursive: true, force: true});
}
function sessao(d, conteudo, opcoes = {}) {
  const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : b.SERVICO;
  const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
  const env = {...process.env, TMPDIR: posix(path.join(d, 'tmp')), ...(opcoes.env ?? {})};
  for (const k of ['RENDER', 'DATABASE_URL', 'KIDMAIS_DEPLOY_ENV', 'HOMOLOGACAO_DATABASE_URL', 'BASH_ENV', 'ASAAS_API_KEY', 'T', 'C']) if (!(opcoes.env && k in opcoes.env)) delete env[k];
  if (servico === undefined) delete env.RENDER_SERVICE_ID; else env.RENDER_SERVICE_ID = servico;
  const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env}) : spawnSync('bash', [f], {encoding: 'utf8', env});
  fs.rmSync(f, {force: true});
  return {status: r.status, saida: (r.stdout || '') + (r.stderr || '')};
}
// comando: null = sem conferência; 'REAL' = o comando real do modo; outro texto = substituto.
const gerar = (d, modo, comando = null, alterarCorpo) => b.gerar({modo, rotulo: 'abcdef1', destino: posix(d) + '/' + PASTA, deploy: posix(d),
  comando: comando === 'REAL' ? undefined : comando, alterarCorpo});
const todasAsPartes = d => Array.from({length: N}, (_, i) => gerar(d, `PARTE-${i + 1}`)).join('');
const rodar = (d, modo, comando, opcoes, alterarCorpo) => sessao(d, gerar(d, modo, comando, alterarCorpo), opcoes);
const codigos = s => [...s.matchAll(/^CODIGO_SAIDA_BLOCO=(\d+)$/gm)].map(x => Number(x[1]));
const codigo = s => codigos(s).at(-1);
const linhas = (s, re) => s.split(/\r?\n/).filter(l => re.test(l)).length;
const presentes = d => ARQ.filter(a => fs.existsSync(path.join(d, PASTA, a)));
const partesPresentes = d => { try { return fs.readdirSync(path.join(d, PASTA, '.partes')).length; } catch { return 0; } };
const temporarios = d => fs.readdirSync(path.join(d, 'tmp')).length;
const intactoDoDeploy = d => fs.readFileSync(path.join(d, 'scripts/migration-089-comum.cjs'), 'utf8') === '// do deploy\r\n' && fs.readFileSync(path.join(d, 'data/marcador.json'), 'utf8') === '{}';
const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function embutido(bloco) {
  const L = bloco.split('\n'), i = L.indexOf("{ base64 -d | gzip -dc > \"$C\"; } 2>/dev/null <<'CORPO'"), j = L.indexOf('CORPO', i + 1);
  return {texto: zlib.gunzipSync(Buffer.from(L.slice(i + 1, j).join(''), 'base64')).toString('utf8'), sha: /= "([0-9a-f]{64})" \]; then/.exec(bloco)[1]};
}

test('arquivos: agregador, trava do B-1, os 9 núcleos de estado (nunca a 098) e os 4 módulos da 107/108; partes; blocos ≤ 36 KB; modos e destinos inválidos', () => {
  assert.deepEqual(ARQ, ['scripts/conferencia-b5-producao.cjs', 'scripts/migration-092-094-production.cjs', ...b5.MIGRACOES.map(m => m[1].replace('./', 'scripts/')),
    'scripts/migration-108-evidencias.cjs', 'scripts/migration-108-retrato.cjs', 'scripts/migration-108-inventario.cjs', 'scripts/migration-107-definicoes.cjs']);
  assert.equal(ARQ.length, 15); assert.ok(!ARQ.some(a => /098|staging|database\//.test(a)));
  assert.deepEqual(PARTES.flatMap(p => p.itens.map(x => x.arquivo)), ARQ);
  assert.deepEqual(b.modos(root), [...PARTES.map((_, i) => `PARTE-${i + 1}`), ...CURTOS, 'LIMPEZA']);
  for (const modo of b.modos(root)) assert.ok(Buffer.byteLength(b.gerar({modo, rotulo: 'abcdef1'})) <= 36000, modo);
  for (const modo of ['X', `PARTE-${N + 1}`, 'APLICAR', 'APLICAR-B5', 'CONFERIR', 'CONFERIR-098']) assert.throws(() => b.gerar({modo, rotulo: 'abcdef1'}), /MODO_DESCONHECIDO/, modo);
  assert.throws(() => b.gerar({modo: 'LIMPEZA', rotulo: 'abc; rm'}), /ROTULO_INVALIDO/);
  const P = '/opt/render/project/src';
  for (const destino of [P, P + '/data/.kidmais-x', '/tmp/fora', P + '/.kidmais-x/..', P + '/sub/.kidmais-x', P + '/./.kidmais-a', P + '/nome-sem-ponto', P + '/.kidmais-A'])
    assert.throws(() => b.gerar({modo: 'LIMPEZA', rotulo: 'abcdef1', destino}), /DESTINO_INVALIDO/, destino);
});

test('carregador: guarda + carregador; corpo codificado com sha fixado, igual ao programa do modo; só o corpo imprime 0; comando de leitura certo', () => {
  for (const modo of b.modos(root)) {
    const x = b.gerar({modo, rotulo: 'abcdef1'});
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/);
    const L = x.split('\n'), i = L.findIndex(l => l.startsWith('if [ "$RENDER_SERVICE_ID" != "srv-dak77m2d0e5s73b8rkkg" ]'));
    assert.ok(i > 0 && L.slice(0, i).every(l => l.startsWith('#') || l.startsWith('bind ')), modo);
    assert.equal(L[i + 1], b.ABERTURA_CARREGADOR); assert.equal(L.at(-2), 'fi'); assert.equal(L.at(-3), ')');
    assert.doesNotMatch(x, /NODE_PATH|node scripts\/|DATABASE_URL|ASAAS|postgres(ql)?:\/\//);
    assert.deepEqual([...x.matchAll(/CODIGO_SAIDA_BLOCO=(\S+)"/g)].map(m => m[1]), ['4', '4', '4'], modo);
    const e = embutido(x);
    assert.equal(e.texto, b.corpo({modo})); assert.equal(sha(e.texto), e.sha);
    assert.ok(e.texto.startsWith('T=\nfim() { c=$?;') && e.texto.includes('\ntrap fim EXIT\n'), modo);
    assert.ok(e.texto.indexOf('SHELL_ERRADO_NAO_E_PRODUCAO') < e.texto.indexOf("cd '/opt/render/project/src'"));
    assert.doesNotMatch(e.texto, /KIDMAIS_REGISTRO_BACKUP|--aplicar|data\/lancamento/);
  }
  assert.match(b.corpo({modo: 'CONFERIR-B5'}), /^NODE_PATH='\/opt\/render\/project\/src\/node_modules' node scripts\/conferencia-b5-producao\.cjs --conferir-b5 \|\| codigo=\$\?$/m);
  assert.match(b.corpo({modo: 'CONFERIR-B5-ESTADO'}), /^NODE_PATH='\/opt\/render\/project\/src\/node_modules' node scripts\/conferencia-b5-producao\.cjs --conferir-b5-estado \|\| codigo=\$\?$/m);
  assert.ok(b.corpo({modo: 'CONFERIR-B5'}).indexOf("cd '.kidmais-conferencia-b5-producao'") < b.corpo({modo: 'CONFERIR-B5'}).indexOf('NODE_PATH='));
});

test('guarda: outro serviço ou sem RENDER_SERVICE_ID não executa nada; sem a linha da guarda, o corpo recusa sozinho', () => {
  for (const servico of ['srv-daif418ae00c73e8k2gg', undefined]) {
    const d = deploy();
    try {
      for (const modo of ['PARTE-1', ...CURTOS, 'LIMPEZA']) {
        const r = rodar(d, modo, RODOU, {servico}); assert.match(r.saida, /^SHELL_ERRADO_NAO_E_PRODUCAO/m, modo); assert.doesNotMatch(r.saida, /CODIGO_SAIDA_BLOCO|CONFERENCIA_RODOU/);
        const L = gerar(d, modo, RODOU).split('\n').filter(l => !l.startsWith('if [ "$RENDER_SERVICE_ID"') && l !== 'fi');
        const s = sessao(d, L.join('\n'), {servico}); assert.equal(codigo(s.saida), 4, modo); assert.doesNotMatch(s.saida, /CONFERENCIA_RODOU|TRANSPORTADO/);
      }
      assert.ok(!fs.existsSync(path.join(d, PASTA)));
    } finally { limpar(d); }
  }
});

test('sem o pg: curtos = 4 antes de montar; montagem só com TODAS as partes, dizendo qual colar', () => {
  const d = deploy({pg: false});
  try {
    const r0 = rodar(d, 'CONFERIR-B5', OK); assert.equal(codigo(r0.saida), 4); assert.match(r0.saida, /DEPENDENCIA_AUSENTE node_modules\/pg/);
  } finally { limpar(d); }
  const d2 = deploy();
  try {
    const r = rodar(d2, 'CONFERIR-B5-ESTADO', RODOU); assert.equal(codigo(r.saida), 4); assert.match(r.saida, /^MONTAGEM_RECUSADA/m); assert.doesNotMatch(r.saida, /CONFERENCIA_RODOU/);
    sessao(d2, Array.from({length: N}, (_, i) => i === 2 ? '' : gerar(d2, `PARTE-${i + 1}`)).join(''));
    const r1 = rodar(d2, 'CONFERIR-B5', RODOU); assert.equal(codigo(r1.saida), 4);
    assert.equal(linhas(r1.saida, /^PARTE_AUSENTE_OU_DIVERGENTE .* \(colar a PARTE-3\)$/), PARTES[2].itens.length); assert.deepEqual(presentes(d2), []);
  } finally { limpar(d2); }
});

test('fluxo: partes (repetir = JA_PRESENTE) → CONFERIR-B5 monta 11 e roda da pasta própria → CONFERIR-B5-ESTADO → LIMPEZA; deploy intacto', () => {
  const d = deploy();
  try {
    const nada = rodar(d, 'LIMPEZA'); assert.equal(codigo(nada.saida), 0); assert.match(nada.saida, /^NADA_A_LIMPAR$/m);
    const p = sessao(d, todasAsPartes(d)); assert.deepEqual(codigos(p.saida), Array(N).fill(0), p.saida.slice(-300)); assert.equal(linhas(p.saida, /^TRANSPORTADO /), ARQ.length);
    assert.equal(codigo(rodar(d, 'PARTE-1').saida), 0);
    const r = rodar(d, 'CONFERIR-B5', RODOU); assert.equal(codigo(r.saida), 0, r.saida.slice(-300)); assert.match(r.saida, /^ARQUIVOS_OK 15$/m);
    assert.match(r.saida, new RegExp('^CONFERENCIA_RODOU pwd=.*' + re(PASTA) + '$', 'm'));
    for (const a of ARQ) assert.equal(fs.readFileSync(path.join(d, PASTA, a), 'utf8'), lf(a), a);
    const e = rodar(d, 'CONFERIR-B5-ESTADO', 'node -e "process.exitCode=3"'); assert.equal(codigo(e.saida), 3, 'o código da conferência vira o do bloco');
    assert.equal(temporarios(d), 0); assert.ok(intactoDoDeploy(d));
    const l = rodar(d, 'LIMPEZA'); assert.equal(codigo(l.saida), 0); assert.match(l.saida, /^PASTA_REMOVIDA$/m); assert.ok(intactoDoDeploy(d));
  } finally { limpar(d); }
});

test('pacote montado completo e executável DA PASTA PRÓPRIA: os 9 núcleos carregam; plano offline real; conferências reais fora do Render = 1', () => {
  const d = deploy({modulosReais: true});
  try {
    sessao(d, todasAsPartes(d));
    const NP = `NODE_PATH='${posix(d)}/node_modules'`;
    const carregar = `${NP} node -e "const b5=require('./scripts/conferencia-b5-producao.cjs'); for (const [,m] of b5.MIGRACOES) { const n=require(m.replace('./','./scripts/')); if (typeof n.SQL_ESTADO!=='string') process.exit(9); } const p=b5.plano(); if (p.resultado!=='PLANO') process.exit(8); console.log('NUCLEOS_OK')"`;
    const r = rodar(d, 'CONFERIR-B5', carregar); assert.equal(codigo(r.saida), 0, r.saida.slice(-400)); assert.match(r.saida, /^NUCLEOS_OK$/m);
    for (const modo of CURTOS) { const x = rodar(d, modo, 'REAL'); assert.equal(codigo(x.saida), 1, modo + x.saida.slice(-300)); assert.match(x.saida, /^RECUSADO FORA_DO_RENDER$/m); }
    assert.ok(intactoDoDeploy(d));
  } finally { limpar(d); }
});

test('destino físico: pasta própria ou subpasta como junção = 4 LINK_RECUSADO, nada gravado nem removido fora; pwd -P divergente = 4', () => {
  for (const alvo of ['.', 'data']) {
    const d = deploy();
    try {
      const isca = path.join(d, alvo, 'scripts/conferencia-b5-producao.cjs'); fs.mkdirSync(path.dirname(isca), {recursive: true}); fs.writeFileSync(isca, lf('scripts/conferencia-b5-producao.cjs'));
      fs.symlinkSync(path.join(d, alvo), path.join(d, PASTA), 'junction');
      for (const modo of ['PARTE-1', 'CONFERIR-B5', 'LIMPEZA']) {
        const r = rodar(d, modo, RODOU); assert.equal(codigo(r.saida), 4, `${alvo} ${modo}`); assert.match(r.saida, new RegExp(`^LINK_RECUSADO ${re(PASTA)}$`, 'm'));
        assert.doesNotMatch(r.saida, /CONFERENCIA_RODOU|REMOVIDO|TRANSPORTADO/);
      }
      assert.ok(fs.existsSync(isca)); assert.ok(intactoDoDeploy(d));
    } finally { limpar(d); }
  }
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const alvo = path.join(d, 'redirecionado'); fs.mkdirSync(alvo);
    const ponto = path.join(d, PASTA, 'scripts'); fs.mkdirSync(ponto, {recursive: true}); fs.rmSync(ponto, {recursive: true, force: true}); fs.symlinkSync(alvo, ponto, 'junction');
    for (const modo of ['CONFERIR-B5-ESTADO', 'LIMPEZA']) { const r = rodar(d, modo, RODOU); assert.equal(codigo(r.saida), 4); assert.match(r.saida, /^LINK_RECUSADO \.\//m); }
    assert.deepEqual(fs.readdirSync(alvo), []); fs.unlinkSync(ponto);
    const falso = 'pwd() { if [ "${1:-}" = "-P" ] && [ "$(builtin pwd)" != "$DEPLOY_REAL" ]; then echo /montagem/outro; else builtin pwd "$@"; fi; }\nexport -f pwd\n' + `export DEPLOY_REAL='${posix(d)}'\n`;
    const r = sessao(d, falso + gerar(d, 'CONFERIR-B5', RODOU)); assert.equal(codigo(r.saida), 4); assert.match(r.saida, /^DESTINO_FORA_DO_LUGAR \/montagem\/outro$/m);
  } finally { limpar(d); }
});

test('integridade: divergente na pasta (com e sem as linhas livre), parte adulterada, carga corrompida ou trocada, parte só grava depois de conferir todos', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const alvo = path.join(d, PASTA, 'scripts/migration-099-comum.cjs'); fs.mkdirSync(path.dirname(alvo), {recursive: true}); fs.writeFileSync(alvo, '// outro\n');
    const r = rodar(d, 'CONFERIR-B5', RODOU); assert.equal(codigo(r.saida), 4); assert.match(r.saida, /JA_EXISTE_DIFERENTE scripts\/migration-099-comum\.cjs/); assert.doesNotMatch(r.saida, /CONFERENCIA_RODOU/);
    const sem = rodar(d, 'CONFERIR-B5', RODOU, {}, t => t.split('\n').filter(l => !l.startsWith('livre scripts/')).join('\n'));
    assert.equal(codigo(sem.saida), 4); assert.doesNotMatch(sem.saida, /CONFERENCIA_RODOU/);
    const l = rodar(d, 'LIMPEZA'); assert.match(l.saida, /DIVERGENTE_PRESERVADO scripts\/migration-099-comum\.cjs/); assert.ok(fs.existsSync(alvo));
  } finally { limpar(d); }
  const d2 = deploy();
  try {
    const [primeiro, segundo] = PARTES[0].itens;
    fs.mkdirSync(path.join(d2, PASTA, '.partes'), {recursive: true}); fs.writeFileSync(path.join(d2, PASTA, '.partes', segundo.sha), 'adulterado');
    const r = rodar(d2, 'PARTE-1'); assert.equal(codigo(r.saida), 4); assert.match(r.saida, new RegExp('^PARTE_EXISTE_DIFERENTE ' + segundo.sha + '$', 'm'));
    assert.ok(!fs.existsSync(path.join(d2, PASTA, '.partes', primeiro.sha)));
  } finally { limpar(d2); }
  const outro = zlib.gzipSync(Buffer.from('// outro conteudo valido\n'), {level: 9}).toString('base64').match(/.{1,76}/g), it = PARTES[0].itens[0];
  for (const alterar of [t => { const L = t.split('\n'), i = L.findIndex(x => x.startsWith(`prep ${it.sha} `)) + 1; L[i] = L[i].replace(/^./, c => c === 'A' ? 'B' : 'A'); return L.join('\n'); },
    t => { const L = t.split('\n'), i = L.findIndex(x => x.startsWith(`prep ${it.sha} `)), j = L.indexOf('B64', i); L.splice(i + 1, j - i - 1, ...outro); return L.join('\n'); }]) {
    const d3 = deploy();
    try { const r = rodar(d3, 'PARTE-1', null, {}, alterar); assert.equal(codigo(r.saida), 4); assert.match(r.saida, new RegExp('^CONTEUDO_DIVERGENTE ' + re(it.arquivo) + '$', 'm')); assert.equal(partesPresentes(d3), 0); }
    finally { limpar(d3); }
  }
});

function semLinha(d, bloco, i, opcoes) { const L = bloco.split('\n'); L.splice(i, 1); return sessao(d, L.join('\n'), opcoes).saida; }
test('perder QUALQUER linha de um curto (com arquivo divergente presente) nunca roda a conferência nem dá 0; de uma parte, nunca 0 sem a parte', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const alvo = path.join(d, PASTA, 'scripts/migration-091-comum.cjs'); fs.mkdirSync(path.dirname(alvo), {recursive: true}); fs.writeFileSync(alvo, '// divergente\n');
    const bloco = gerar(d, 'CONFERIR-B5', RODOU), L = bloco.split('\n');
    for (let i = 0; i < L.length; i++) {
      if (L[i].startsWith('#') || L[i] === '') continue;
      const s = semLinha(d, bloco, i, {});
      assert.doesNotMatch(s, /CONFERENCIA_RODOU/, `linha ${i}`); assert.ok(!codigos(s).includes(0), `linha ${i} (${L[i].slice(0, 40)})`);
    }
    const exec = L.findIndex(l => l.startsWith('if [ "$(sha256sum "$C"')); assert.deepEqual(codigos(semLinha(d, bloco, exec, {})), []);
  } finally { limpar(d); }
  const d2 = deploy();
  try {
    const bloco = gerar(d2, `PARTE-${N}`), L = bloco.split('\n'), ini = L.indexOf(b.ABERTURA_CARREGADOR);
    const ci = L.indexOf("{ base64 -d | gzip -dc > \"$C\"; } 2>/dev/null <<'CORPO'"), cf = L.indexOf('CORPO', ci + 1);
    for (let i = ini - 1; i < L.length; i++) {
      if (L[i] === '' || (i > ci && i < cf && (i - ci) % 9 !== 1)) continue;
      fs.rmSync(path.join(d2, PASTA), {recursive: true, force: true});
      const s = semLinha(d2, bloco, i, {});
      if (codigos(s).includes(0)) assert.match(s, new RegExp(`^PARTE_${N}_DE_${N}_OK `, 'm'), `linha ${i}`);
      for (const x of PARTES[N - 1].itens) { const f = path.join(d2, PASTA, '.partes', x.sha); if (fs.existsSync(f)) assert.equal(sha(fs.readFileSync(f)), x.sha); }
    }
  } finally { limpar(d2); }
});

test('colagem truncada não grava nem executa; colagem interativa: shell do operador intacto, códigos 0/1/2/3/4 legíveis', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d).replace(gerar(d, 'PARTE-2'), ''));
    const antes = partesPresentes(d);
    for (const modo of ['PARTE-2', 'CONFERIR-B5']) {
      const x = gerar(d, modo, RODOU);
      for (const fr of [0.25, 0.5, 0.9, 0.999]) {
        const r = sessao(d, x.slice(0, Math.floor(x.length * fr)));
        assert.equal(codigos(r.saida).length, 0, `${modo} ${fr}`); assert.doesNotMatch(r.saida, /CONFERENCIA_RODOU/); assert.equal(partesPresentes(d), antes);
      }
    }
  } finally { limpar(d); }
  const POS = ['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"', 'trap -p EXIT', 'echo SHELL_DO_OPERADOR_VIVO'].join('\n') + '\n';
  for (const esperado of [0, 1, 2, 3]) {
    const d2 = deploy();
    try {
      const inicio = sessao(d2, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n', {interativo: true}).saida;
      const r = sessao(d2, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n' + todasAsPartes(d2) + gerar(d2, 'CONFERIR-B5', `node -e "process.exitCode=${esperado}"`) + POS, {interativo: true});
      assert.deepEqual(codigos(r.saida), [...Array(N).fill(0), esperado], r.saida.slice(-300)); assert.match(r.saida, /^SHELL_DO_OPERADOR_VIVO$/m);
      const a = /^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(inicio), p = /^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
      assert.equal(p[1], a[1]); assert.equal(p[2], a[2]); assert.equal(p[3].trim(), a[3].trim()); assert.doesNotMatch(r.saida, /trap -- .*EXIT/);
      assert.equal(temporarios(d2), 0);
    } finally { limpar(d2); }
  }
});

test('variáveis do Shell do operador: T exportado nunca é removido; C/T somente leitura = 4 antes de tudo; BASH_ENV/ENV não entram no corpo', () => {
  const d = deploy();
  try {
    const isca = path.join(d, 'isca-T'); fs.mkdirSync(isca); fs.writeFileSync(path.join(isca, 'x'), 'x');
    for (const modo of ['PARTE-1', ...CURTOS, 'LIMPEZA']) {
      const r = rodar(d, modo, OK, {env: {T: posix(isca)}}); assert.ok(fs.existsSync(path.join(isca, 'x')), modo + ': isca de T preservada'); assert.ok(codigos(r.saida).length === 1, modo);
    }
    // Defesa em profundidade: o corpo sozinho (sem o unset do carregador) também zera T antes do trap.
    for (const modo of ['CONFERIR-B5', 'LIMPEZA']) {
      const f = d + '-corpo.sh'; fs.writeFileSync(f, b.corpo({modo, destino: posix(d) + '/' + PASTA, deploy: posix(d), comando: OK}));
      const env = {...process.env, RENDER_SERVICE_ID: b.SERVICO, T: posix(isca), TMPDIR: posix(path.join(d, 'tmp'))};
      spawnSync('bash', [f], {encoding: 'utf8', env}); fs.rmSync(f, {force: true});
      assert.ok(fs.existsSync(path.join(isca, 'x')), modo + ': corpo sozinho preserva o T herdado');
    }
    const ro = sessao(d, 'readonly C=/tmp/nada\n' + gerar(d, 'CONFERIR-B5', RODOU), {interativo: true});
    assert.equal(codigo(ro.saida), 4); assert.match(ro.saida, /^VARIAVEIS_DO_CARREGADOR_NAO_LIMPAS /m); assert.doesNotMatch(ro.saida, /CONFERENCIA_RODOU/);
    const ini = path.join(d, 'injetado.sh'); fs.writeFileSync(ini, 'echo INJETADO_NO_CORPO\n');
    sessao(d, todasAsPartes(d));
    const r = sessao(d, gerar(d, 'CONFERIR-B5-ESTADO', OK), {interativo: true, env: {BASH_ENV: posix(ini), ENV: posix(ini)}});
    assert.equal(codigo(r.saida), 0); assert.doesNotMatch(r.saida, /INJETADO_NO_CORPO/);
  } finally { limpar(d); }
});

test('trap: rm falso vira aviso sem mudar o código (parte e curto, inclusive sinal); LIMPEZA com rm falso = 4', () => {
  const RM = 'rm() { echo "rm falso: $*" >&2; return 1; }\nexport -f rm\n';
  const d0 = deploy();
  try { const r = sessao(d0, RM + gerar(d0, 'PARTE-1')); assert.equal(codigo(r.saida), 0); assert.equal(linhas(r.saida, /^TEMPORARIO_NAO_REMOVIDO /), 1); } finally { limpar(d0); }
  for (const [comando, esperado] of [[OK, 0], ['node -e "process.exitCode=2"', 2], ['node -e "process.exitCode=3"', 3], ["bash -c 'kill -TERM $$'", 143]]) {
    const d = deploy();
    try { sessao(d, todasAsPartes(d)); const r = sessao(d, RM + gerar(d, 'CONFERIR-B5', comando)); assert.equal(codigo(r.saida), esperado, comando); } finally { limpar(d); }
  }
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d)); assert.equal(codigo(rodar(d, 'CONFERIR-B5', OK).saida), 0);
    const l = sessao(d, RM + gerar(d, 'LIMPEZA')); assert.equal(codigo(l.saida), 4); assert.match(l.saida, /^REMOCAO_FALHOU scripts\/conferencia-b5-producao\.cjs$/m);
  } finally { limpar(d); }
});

test('hashes do corpo = conteúdo LF da árvore; CLI TODOS grava os blocos com sha e bytes e recusa pasta existente', () => {
  const x = b.corpo({modo: 'LIMPEZA'});
  for (const a of ARQ) { const h = sha(lf(a)); assert.ok(x.includes(`limpar ${a} ${h}`), a); assert.ok(x.includes(`limpar .partes/${h} ${h}`), a); }
  const saida = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b5-cli-')), 'blocos');
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'bloco-shell-conferencia-b5-producao.cjs'), 'TODOS', 'abcdef1', saida], {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr); const L = r.stdout.trim().split('\n'); assert.equal(L.length, N + 3);
    for (const l of L) { const [h, bytes, nome] = l.split(/\s+/); const c = fs.readFileSync(path.join(saida, nome)); assert.equal(sha(c), h); assert.equal(c.length, Number(bytes)); }
    const denovo = spawnSync(process.execPath, [path.join(__dirname, 'bloco-shell-conferencia-b5-producao.cjs'), 'TODOS', 'abcdef1', saida], {encoding: 'utf8'});
    assert.equal(denovo.status, 1); assert.match(denovo.stderr, /PASTA_DE_SAIDA_INVALIDA_OU_EXISTENTE/);
  } finally { fs.rmSync(path.dirname(saida), {recursive: true, force: true}); }
});
