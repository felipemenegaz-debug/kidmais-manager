/* eslint-disable @typescript-eslint/no-require-imports */
// B-4: blocos de entrega dos aplicadores do grupo A (092/093 do B-1 e 099 do B-2) ao Shell de produção, executados DE
// VERDADE com bash num deploy temporário (só as pastas diferem das de produção; o comando do aplicador é o real — plano
// offline ou recusa antes de conectar — ou um substituto que só imprime/devolve um código). Cobre a revisão de 26/10:
// P2-1 (destino físico, links/junções no destino e nas subpastas), P2-2 (carregador conferido: perder QUALQUER linha nunca
// dá código 0 sem execução nem executa conteúdo divergente) e o item 4 (registro do backup do E2 conferido). Não toca
// banco nem /opt.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash, randomUUID} = require('node:crypto'), zlib = require('node:zlib');
const b = require('./bloco-shell-entrega-grupo-a-producao.cjs');
const b1 = require('./bloco-shell-092-094.cjs'), b2 = require('./bloco-shell-099.cjs');
const root = path.resolve(__dirname, '..');
const lf = a => fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const ARQ = b.arquivos();
const {partes: PARTES, lista: LISTA} = b.distribuir(root);
const N = PARTES.length;
const PASTA = b.NOME_DESTINO;
const SQL_092 = 'database/migrations/20261022_092_precos_por_quantidade.sql';
const CURTOS = ['CONFERIR-092-093', 'APLICAR-092-093', 'CONFERIR-099', 'APLICAR-099'];
const OK = 'node -e "process.exitCode=0"';
const RODOU = 'echo "APLICADOR_RODOU pwd=$PWD backup=${B:-}"';

/** Deploy temporário: pg falso (ou o node_modules real por junção), arquivo do deploy com o MESMO caminho de um SQL do pacote. */
function deploy({pg = true, modulosReais = false} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-grupo-a-'));
  if (modulosReais) fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'), 'junction');
  else if (pg) { fs.mkdirSync(path.join(d, 'node_modules/pg'), {recursive: true}); fs.writeFileSync(path.join(d, 'node_modules/pg/package.json'), '{"name":"pg"}'); fs.writeFileSync(path.join(d, 'node_modules/pg/index.js'), 'module.exports={Client:class{}};'); }
  // Nunca lido, sobrescrito nem removido: os aplicadores leem os SQL da pasta própria.
  fs.mkdirSync(path.join(d, path.dirname(SQL_092)), {recursive: true}); fs.writeFileSync(path.join(d, SQL_092), '-- do deploy\r\n');
  fs.mkdirSync(path.join(d, 'data/agenda-precos-092-094-producao'), {recursive: true}); fs.writeFileSync(path.join(d, 'data/agenda-precos-092-094-producao/migration-092-093.json'), '{}');
  fs.mkdirSync(path.join(d, 'tmp'));
  return d;
}
/** Registro do backup do E2 no formato da ferramenta P1 (scripts/backup-lancamento-production.cjs), com dump de verdade. */
function backup(d, {registro = {}, dump = 'PGDMP conteudo do dump de teste', nome} = {}) {
  const id = nome ?? `backup-${randomUUID()}`, pasta = path.join(d, b.PASTA_BACKUP);
  fs.mkdirSync(pasta, {recursive: true});
  if (dump !== null) fs.writeFileSync(path.join(pasta, id + '.dump'), dump);
  const agora = new Date().toISOString();
  const r = {servico: b.SERVICO, banco: b.BANCO, arquivo: id + '.dump', sha256: sha(dump ?? ''), criadoEm: agora, pitrConferidoEm: agora,
    manifestoSha256: 'x'.repeat(64), arquivoIntegralmenteLido: true, restauracaoRealComprovada: false, ...registro};
  fs.writeFileSync(path.join(pasta, id + '.json'), typeof registro === 'string' ? registro : JSON.stringify(r, null, 2));
  return id + '.json';
}
function limpar(d) {
  for (const j of ['node_modules', PASTA]) { try { if (fs.lstatSync(path.join(d, j)).isSymbolicLink()) fs.unlinkSync(path.join(d, j)); } catch { /* sem junção */ } }
  fs.rmSync(d, {recursive: true, force: true});
}
function sessao(d, conteudo, opcoes = {}) {
  const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : b.SERVICO;
  const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
  const env = {...process.env, TMPDIR: posix(path.join(d, 'tmp'))};
  for (const k of ['RENDER', 'DATABASE_URL', 'KIDMAIS_DEPLOY_ENV', 'KIDMAIS_REGISTRO_BACKUP', 'HOMOLOGACAO_DATABASE_URL', 'BASH_ENV']) delete env[k];
  if (opcoes.registro !== undefined) env.KIDMAIS_REGISTRO_BACKUP = opcoes.registro;
  Object.assign(env, opcoes.env ?? {});
  if (servico === undefined) delete env.RENDER_SERVICE_ID; else env.RENDER_SERVICE_ID = servico;
  const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env}) : spawnSync('bash', [f], {encoding: 'utf8', env});
  fs.rmSync(f, {force: true});
  return {status: r.status, saida: (r.stdout || '') + (r.stderr || '')};
}
// comando: null = sem aplicador; 'REAL' = o comando real do modo; outro texto = substituto.
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
const intactoDoDeploy = d => fs.readFileSync(path.join(d, SQL_092), 'utf8') === '-- do deploy\r\n'
  && fs.readFileSync(path.join(d, 'data/agenda-precos-092-094-producao/migration-092-093.json'), 'utf8') === '{}';
const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Corpo embutido num bloco (decodificado do heredoc CORPO) e o sha fixado no carregador; null no que faltar (P3-R8-2: quem
 * chama transforma a ausência em asserção, em vez de TypeError/erro de descompressão). */
function embutido(bloco) {
  const L = bloco.split('\n'), i = L.indexOf(b.LINHA_TEMPORARIO), j = i < 0 ? -1 : L.indexOf('CORPO', i + 1);
  let texto = null; try { if (j > i) texto = zlib.gunzipSync(Buffer.from(L.slice(i + 1, j).join(''), 'base64')).toString('utf8'); } catch { /* texto null */ }
  return {texto, sha: (/= "([0-9a-f]{64})" \]; then/.exec(bloco) ?? [])[1] ?? null};
}
/** Conteúdo de uma isca, ou null se ela sumiu (a remoção vira asserção, não ENOENT). */
const conteudo = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
/** P3-R7-1: erro ao montar a fixture (forma do bloco inesperada) não é falha de comportamento — sai com rótulo próprio. */
function preparacao(rotulo, f) {
  try { return f(); } catch (e) { throw new Error('PREPARACAO_FIXTURE ' + rotulo + ': ' + String(e?.message ?? e).slice(0, 200)); }
}

test('arquivos: exatamente os que os blocos de produção do B-1 e do B-2 conferem (28, com as dependências da 107/108 do B-1); partes; todo bloco ≤ 36 KB; modos e destinos inválidos', () => {
  assert.deepEqual(ARQ, [...b1.arquivos('production'), ...b2.arquivos('production')]);
  assert.equal(ARQ.length, 28); assert.equal(new Set(ARQ).size, 28);
  assert.ok(!ARQ.some(a => /staging|_100_|_098_|_091_|rollback|_down\.sql/.test(a) && !a.includes('094_integridade_apos_100')), ARQ.join(' '));
  assert.ok(ARQ.every(a => /^(scripts|database)\/[A-Za-z0-9_./-]+$/.test(a) && !a.split('/').includes('..')));
  assert.deepEqual(PARTES.flatMap(p => p.itens.map(x => x.arquivo)), ARQ);
  assert.deepEqual(b.modos(root), [...PARTES.map((_, i) => `PARTE-${i + 1}`), ...CURTOS, 'LIMPEZA']);
  for (const modo of b.modos(root)) { const x = b.gerar({modo, rotulo: 'abcdef1'}); assert.ok(Buffer.byteLength(x) <= 36000, modo + ' ' + Buffer.byteLength(x)); }
  for (const modo of ['X', `PARTE-${N + 1}`, 'PARTE-0', 'CONFERIR', 'APLICAR', 'APLICAR-094', 'CONFERIR-094', 'CONFERIR-092-094', 'APLICAR-091']) assert.throws(() => b.gerar({modo, rotulo: 'abcdef1'}), /MODO_DESCONHECIDO/, modo);
  assert.throws(() => b.gerar({modo: 'LIMPEZA', rotulo: 'abc; rm -rf /'}), /ROTULO_INVALIDO/);
  // P2-1: o destino é um único nome `.kidmais-…` diretamente sob o deploy, depois de normalizar.
  const P = '/opt/render/project/src';
  for (const destino of [P, P + '/', P + '/data/x', P + '/data', '/tmp/fora', P + '/.kidmais-x/..', P + '/.kidmais-x/../..', P + '/.kidmais-x/../data/.kidmais-y',
    P + '/sub/.kidmais-x', P + '/.kidmais-a/b', P + '/./.kidmais-a', P + '/nome-sem-ponto', P + '/.kidmais-A', P + '/../src/.kidmais-a', P + '/.kidmais-a;rm']) {
    assert.throws(() => b.gerar({modo: 'LIMPEZA', rotulo: 'abcdef1', destino}), /DESTINO_INVALIDO/, destino);
  }
  assert.throws(() => b.gerar({modo: 'LIMPEZA', rotulo: 'abcdef1', deploy: P + '/../x', destino: P + '/../x/.kidmais-a'}), /DESTINO_INVALIDO/);
  assert.deepEqual(b.caminhos(P + '/', P + '//.kidmais-entrega-grupo-a-producao/'), {deploy: P, destino: b.DESTINO, nome: PASTA});
});

test('carregador (P2-2): o bloco colado só tem guarda + carregador; o corpo vai codificado, com o sha fixado, e é o programa do modo', () => {
  for (const modo of b.modos(root)) {
    const x = b.gerar({modo, rotulo: 'abcdef1'});
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/); assert.equal(Buffer.byteLength(x, 'utf8'), x.length);
    const L = x.split('\n'), i = L.findIndex(l => l.startsWith('if [ "$RENDER_SERVICE_ID" != "srv-dak77m2d0e5s73b8rkkg" ]'));
    assert.ok(i > 0 && L.slice(0, i).every(l => l.startsWith('#') || l.startsWith('bind ')), modo);
    assert.equal(L[i - 1], "bind 'set enable-bracketed-paste off' 2>/dev/null"); assert.equal(L[i + 1], b.ABERTURA_CARREGADOR, 'P3-N1: subshell sem C/T do operador');
    assert.match(b.ABERTURA_CARREGADOR, /^\( \\command builtin unset -v C T \|\| \{ .*exit 4; \}$/, 'P2-R3-1/P2-R4-1: unset sem alias/função, com recusa');
    assert.equal(L[i + 3], b.LINHA_TEMPORARIO, 'P2-R4-1: temporário, trap e escrita do corpo numa linha só');
    assert.match(b.LINHA_TEMPORARIO, /^C="\$\(mktemp\)" && trap 'rm -f -- "\$C"' EXIT && \{ .*<<'CORPO' \|\| \{ .*exit 4; \}$/); assert.equal(L.at(-2), 'fi'); assert.equal(L.at(-3), ')');
    // Nada do programa em claro: só o carregador fala de CODIGO_SAIDA_BLOCO (=4) — o 0 só pode vir do corpo.
    assert.doesNotMatch(x, /NODE_PATH|node scripts\/|livre |inst |DATABASE_URL|postgres(ql)?:\/\//);
    assert.deepEqual([...x.matchAll(/CODIGO_SAIDA_BLOCO=(\S+)"/g)].map(m => m[1]), ['4', '4', '4'], modo + ': só 4 no carregador (abertura, mktemp, sha)');
    assert.match(x, /then env -u BASH_ENV -u ENV bash "\$C"; else echo "CORPO_DIVERGENTE/);
    const e = embutido(x);
    assert.ok(e.texto !== null, modo + ': heredoc CORPO decodificável logo depois de LINHA_TEMPORARIO');
    assert.ok(e.sha !== null, modo + ': carregador com a linha que confere o sha do corpo');
    assert.equal(e.texto, b.corpo({modo})); assert.equal(sha(e.texto), e.sha, modo);
    assert.ok(e.texto.startsWith('T=\nfim() { c=$?;') && e.texto.includes('\ntrap fim EXIT\n'), modo + ': P2-N1 T zerado antes do trap');
    assert.ok(e.texto.indexOf('SHELL_ERRADO_NAO_E_PRODUCAO') < e.texto.indexOf("cd '/opt/render/project/src'"), modo + ': corpo repete a guarda');
  }
  const NP = "^NODE_PATH='\\/opt\\/render\\/project\\/src\\/node_modules' node ";
  for (const [modo, cmd] of [['CONFERIR-092-093', 'scripts\\/migration-092-094-production\\.cjs --conferir-092-093'],
    ['APLICAR-092-093', 'scripts\\/migration-092-094-production\\.cjs --aplicar-092-093-autorizado --backup "\\$B"'],
    ['CONFERIR-099', 'scripts\\/migration-099-production\\.cjs --conferir-099'], ['APLICAR-099', 'scripts\\/migration-099-production\\.cjs --aplicar-099-autorizado --backup "\\$B"']]) {
    const c = b.corpo({modo});
    assert.match(c, new RegExp(NP + cmd + ' \\|\\| codigo=\\$\\?$', 'm'), modo);
    assert.ok(c.indexOf("cd '.kidmais-entrega-grupo-a-producao'") < c.indexOf('NODE_PATH='), modo);
    assert.doesNotMatch(c, /--aplicar-094|--aplicar-092-094-autorizado|migration-100|_down\.sql/);
    if (modo.startsWith('APLICAR')) assert.ok(c.indexOf('KIDMAIS_REGISTRO_BACKUP:-') < c.indexOf("cd '/opt/render/project/src'") && c.indexOf('node -e ') < c.indexOf("cd '/opt/render/project/src'"), modo + ': backup conferido antes de tocar arquivos');
    else assert.doesNotMatch(c, /KIDMAIS_REGISTRO_BACKUP/);
  }
});

test('guarda: shell de outro serviço (staging) ou sem RENDER_SERVICE_ID não executa nada; sem a linha da guarda, o corpo recusa sozinho', () => {
  for (const servico of ['srv-daif418ae00c73e8k2gg', undefined]) {
    const d = deploy();
    try {
      for (const modo of ['PARTE-1', ...CURTOS, 'LIMPEZA']) {
        const r = rodar(d, modo, RODOU, {servico, registro: 'x'}); assert.equal(r.status, 0); assert.match(r.saida, /^SHELL_ERRADO_NAO_E_PRODUCAO/m, modo);
        assert.doesNotMatch(r.saida, /CODIGO_SAIDA_BLOCO|APLICADOR_RODOU/);
        // Linha da guarda (e o `fi`) perdidas: o corpo conferido repete a guarda e para com 4.
        const L = gerar(d, modo, RODOU).split('\n').filter(l => !l.startsWith('if [ "$RENDER_SERVICE_ID"') && l !== 'fi');
        const s = sessao(d, L.join('\n'), {servico}); assert.equal(codigo(s.saida), 4, modo + s.saida.slice(-200)); assert.match(s.saida, /^SHELL_ERRADO_NAO_E_PRODUCAO: nada executado$/m);
        assert.doesNotMatch(s.saida, /APLICADOR_RODOU|TRANSPORTADO/);
      }
      assert.ok(!fs.existsSync(path.join(d, PASTA)));
    } finally { limpar(d); }
  }
});

test('item 4 — backup: registro do E2 ausente, mal nomeado, inexistente, dump ausente/vazio/alterado ou campos divergentes = 4 antes de criar a pasta', () => {
  const dia = 864e5, velho = new Date(Date.now() - dia - 6e4).toISOString(), futuro = new Date(Date.now() + 6e5).toISOString();
  const casos = [
    ['ausente', () => undefined, /^BACKUP_NAO_INFORMADO /m], ['vazio', () => '', /^BACKUP_NAO_INFORMADO /m], ['texto livre', () => 'dump-ok 26/10 PITR', /^BACKUP_NAO_INFORMADO /m],
    ['caminho', d => 'data/lancamento-venda-20261011/' + backup(d), /^BACKUP_NAO_INFORMADO /m], ['travessia', () => '../backup-00000000-0000-0000-0000-000000000000.json', /^BACKUP_NAO_INFORMADO /m],
    ['maiúsculas', () => 'backup-0000000A-0000-0000-0000-000000000000.json', /^BACKUP_NAO_INFORMADO /m],
    ['inexistente', () => `backup-${randomUUID()}.json`, /^BACKUP_NAO_ENCONTRADO /m], ['sem dump', d => backup(d, {dump: null}), /^BACKUP_NAO_ENCONTRADO /m],
    ['dump vazio', d => backup(d, {dump: ''}), /^BACKUP_NAO_ENCONTRADO /m],
    ['dump alterado', d => { const n = backup(d); fs.appendFileSync(path.join(d, b.PASTA_BACKUP, n.replace('.json', '.dump')), 'x'); return n; }, /^BACKUP_REGISTRO_RECUSADO sha256$/m],
    ['outro serviço', d => backup(d, {registro: {servico: 'srv-daif418ae00c73e8k2gg'}}), /^BACKUP_REGISTRO_RECUSADO servico$/m],
    ['outro banco', d => backup(d, {registro: {banco: 'kidmais_staging_1z91'}}), /^BACKUP_REGISTRO_RECUSADO banco$/m],
    ['outro arquivo', d => backup(d, {registro: {arquivo: 'backup-outro.dump'}}), /^BACKUP_REGISTRO_RECUSADO arquivo$/m],
    ['não lido por inteiro', d => backup(d, {registro: {arquivoIntegralmenteLido: false}}), /^BACKUP_REGISTRO_RECUSADO arquivoIntegralmenteLido$/m],
    ['criado há mais de 24 h', d => backup(d, {registro: {criadoEm: velho}}), /^BACKUP_REGISTRO_RECUSADO criadoEm$/m],
    ['PITR há mais de 24 h', d => backup(d, {registro: {pitrConferidoEm: velho}}), /^BACKUP_REGISTRO_RECUSADO pitrConferidoEm$/m],
    ['PITR no futuro', d => backup(d, {registro: {pitrConferidoEm: futuro}}), /^BACKUP_REGISTRO_RECUSADO pitrConferidoEm$/m],
    ['sem PITR', d => backup(d, {registro: {pitrConferidoEm: undefined}}), /^BACKUP_REGISTRO_RECUSADO pitrConferidoEm$/m],
    ['ilegível', d => backup(d, {registro: '{nao e json'}), /^BACKUP_REGISTRO_ILEGIVEL$/m]];
  for (const modo of ['APLICAR-092-093', 'APLICAR-099']) {
    for (const [rotulo, registro, erro] of casos) {
      const d = deploy();
      try {
        const r = rodar(d, modo, RODOU, {registro: registro(d)});
        assert.equal(codigo(r.saida), 4, `${modo} ${rotulo}: ` + r.saida.slice(-200)); assert.match(r.saida, erro, `${modo} ${rotulo}`);
        assert.doesNotMatch(r.saida, /APLICADOR_RODOU/); assert.ok(!fs.existsSync(path.join(d, PASTA)), rotulo + ': pasta não criada');
      } finally { limpar(d); }
    }
  }
  // Registro válido: confere, monta e passa ao aplicador o caminho RELATIVO do registro (cabe no formato dos aplicadores).
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const nome = backup(d), r = rodar(d, 'APLICAR-099', RODOU, {registro: nome});
    assert.equal(codigo(r.saida), 0, r.saida.slice(-300)); assert.match(r.saida, /^BACKUP_CONFERIDO criadoEm \S+ pitrConferidoEm \S+$/m);
    assert.match(r.saida, new RegExp(`^APLICADOR_RODOU pwd=.*${re(PASTA)} backup=data/lancamento-venda-20261011/${re(nome)}$`, 'm'));
    assert.ok(`data/lancamento-venda-20261011/${nome}`.length <= 120);
  } finally { limpar(d); }
});

test('sem o pg implantado: curtos = 4 antes de montar (as partes não dependem do pg)', () => {
  const d = deploy({pg: false});
  try {
    const p = sessao(d, todasAsPartes(d)); assert.deepEqual(codigos(p.saida), Array(N).fill(0));
    for (const modo of CURTOS) {
      const r = rodar(d, modo, OK, {registro: backup(d)}); assert.equal(codigo(r.saida), 4, modo); assert.match(r.saida, /DEPENDENCIA_AUSENTE node_modules\/pg/); assert.deepEqual(presentes(d), []);
    }
  } finally { limpar(d); }
});

test('montagem só com TODAS as partes: sem partes ou faltando uma, o curto diz qual colar e não monta nada', () => {
  const d = deploy();
  try {
    const r0 = rodar(d, 'CONFERIR-099', OK); assert.equal(codigo(r0.saida), 4); assert.match(r0.saida, /^MONTAGEM_RECUSADA/m);
    assert.equal(linhas(r0.saida, /^PARTE_AUSENTE_OU_DIVERGENTE /), ARQ.length); assert.deepEqual(presentes(d), []);
    sessao(d, Array.from({length: N}, (_, i) => i === 1 ? '' : gerar(d, `PARTE-${i + 1}`)).join(''));
    const r1 = rodar(d, 'CONFERIR-092-093', OK); assert.equal(codigo(r1.saida), 4);
    assert.equal(linhas(r1.saida, /^PARTE_AUSENTE_OU_DIVERGENTE .* \(colar a PARTE-2\)$/), PARTES[1].itens.length);
    assert.equal(linhas(r1.saida, /^PARTE_AUSENTE_OU_DIVERGENTE /), PARTES[1].itens.length); assert.deepEqual(presentes(d), []);
  } finally { limpar(d); }
});

test('fluxo do E3: partes (repetir = JA_PRESENTE) → CONFERIR-092-093 monta 28 → APLICAR-092-093 → CONFERIR-099 → APLICAR-099 → LIMPEZA; deploy e disco intactos', () => {
  const d = deploy();
  try {
    const nada = rodar(d, 'LIMPEZA'); assert.equal(codigo(nada.saida), 0); assert.match(nada.saida, /^NADA_A_LIMPAR$/m); assert.ok(!fs.existsSync(path.join(d, PASTA)));
    const p = sessao(d, todasAsPartes(d)); assert.deepEqual(codigos(p.saida), Array(N).fill(0), p.saida.slice(-300));
    assert.equal(linhas(p.saida, /^TRANSPORTADO /), ARQ.length); assert.equal(partesPresentes(d), new Set(LISTA.map(x => x.sha)).size);
    const p2 = rodar(d, `PARTE-${N}`); assert.equal(codigo(p2.saida), 0); assert.equal(linhas(p2.saida, /^JA_PRESENTE /), PARTES[N - 1].itens.length);
    const r = rodar(d, 'CONFERIR-092-093', RODOU); assert.equal(codigo(r.saida), 0, r.saida.slice(-400)); assert.match(r.saida, new RegExp(`ARQUIVOS_OK ${ARQ.length}`));
    assert.match(r.saida, new RegExp('^APLICADOR_RODOU pwd=.*' + re(PASTA) + ' backup=$', 'm'), 'o aplicador roda da pasta própria');
    for (const a of ARQ) assert.equal(fs.readFileSync(path.join(d, PASTA, a), 'utf8'), lf(a), a);
    const nome = backup(d);
    for (const [modo, opcoes] of [['APLICAR-092-093', {registro: nome}], ['CONFERIR-099', {}], ['APLICAR-099', {registro: nome}]]) {
      const x = rodar(d, modo, RODOU, opcoes); assert.equal(codigo(x.saida), 0, modo + x.saida.slice(-300)); assert.equal(linhas(x.saida, /^JA_PRESENTE /), ARQ.length, modo);
      assert.match(x.saida, /^APLICADOR_RODOU /m); assert.match(x.saida, /^=== REGISTRO \(data\//m);
    }
    assert.equal(temporarios(d), 0); assert.ok(intactoDoDeploy(d));
    const l = rodar(d, 'LIMPEZA'); assert.equal(codigo(l.saida), 0, l.saida.slice(-300)); assert.equal(linhas(l.saida, /^REMOVIDO /), ARQ.length + new Set(LISTA.map(x => x.sha)).size);
    assert.match(l.saida, /^PASTA_REMOVIDA$/m); assert.ok(!fs.existsSync(path.join(d, PASTA))); assert.ok(intactoDoDeploy(d), 'deploy e disco persistente intocados');
    assert.ok(fs.existsSync(path.join(d, b.PASTA_BACKUP, nome)), 'backup intocado');
  } finally { limpar(d); }
});

test('pacote montado é completo e executável DA PASTA PRÓPRIA: planos offline reais do B-1 e do B-2; conferências e APLICAR reais fora do Render = 1 (resultado estruturado)', () => {
  const d = deploy({modulosReais: true});
  try {
    sessao(d, todasAsPartes(d));
    const NP = `NODE_PATH='${posix(d)}/node_modules'`;
    // O deploy tem um SQL da 092 com o mesmo caminho e outro conteúdo: se o aplicador lesse o deploy, o plano recusaria.
    const r = rodar(d, 'CONFERIR-092-093', `${NP} node scripts/migration-092-094-production.cjs > p1.json && ${NP} node scripts/migration-099-production.cjs > p2.json`
      + ` && node -e "for (const f of ['./p1.json','./p2.json']) { const p = require(f); if (p.resultado !== 'PLANO' || p.conecta !== false) process.exit(9); } console.log('PLANOS_OK')" && rm -f p1.json p2.json`);
    assert.equal(codigo(r.saida), 0, r.saida.slice(-500)); assert.match(r.saida, /^PLANOS_OK$/m);
    for (const modo of ['CONFERIR-092-093', 'CONFERIR-099']) {
      const x = rodar(d, modo, 'REAL'); assert.equal(codigo(x.saida), 1, modo + x.saida.slice(-300)); assert.match(x.saida, /^RECUSADO FORA_DO_RENDER$/m);
    }
    for (const modo of ['APLICAR-092-093', 'APLICAR-099']) {
      const a = rodar(d, modo, 'REAL', {registro: backup(d)}); assert.equal(codigo(a.saida), 1, a.saida.slice(-300)); assert.match(a.saida, /^RECUSADO FORA_DO_RENDER$/m);
    }
    assert.ok(intactoDoDeploy(d)); assert.equal(fs.readdirSync(path.join(d, 'data')).sort().join(','), 'agenda-precos-092-094-producao,lancamento-venda-20261011', 'nenhum marcador novo');
  } finally { limpar(d); }
});

test('P2-1: pasta própria como junção para o deploy, para fora ou para data/ = 4 LINK_RECUSADO em parte, curto e LIMPEZA; nada removido nem gravado fora', () => {
  for (const alvo of ['.', 'data', 'fora']) {
    const d = deploy();
    try {
      if (alvo === 'fora') fs.mkdirSync(path.join(d, 'fora'));
      // Conteúdo "com o sha certo" no alvo do link: a LIMPEZA antiga o removeria (o sha prova conteúdo, não lugar).
      const isca = path.join(d, alvo, 'scripts/migration-099-comum.cjs'); fs.mkdirSync(path.dirname(isca), {recursive: true}); fs.writeFileSync(isca, lf('scripts/migration-099-comum.cjs'));
      fs.symlinkSync(path.join(d, alvo), path.join(d, PASTA), 'junction');
      for (const [modo, opcoes] of [['PARTE-1', {}], ['CONFERIR-099', {}], ['APLICAR-099', {registro: backup(d)}], ['LIMPEZA', {}]]) {
        const r = rodar(d, modo, RODOU, opcoes);
        assert.equal(codigo(r.saida), 4, `${alvo} ${modo}: ` + r.saida.slice(-200)); assert.match(r.saida, new RegExp(`^LINK_RECUSADO ${re(PASTA)}$`, 'm'), `${alvo} ${modo}`);
        assert.doesNotMatch(r.saida, /APLICADOR_RODOU|REMOVIDO|TRANSPORTADO|ESCRITO/);
      }
      assert.ok(fs.existsSync(isca), alvo + ': isca preservada'); assert.ok(intactoDoDeploy(d));
      assert.ok(!fs.existsSync(path.join(d, alvo, '.partes')), alvo + ': nada gravado no alvo');
    } finally { limpar(d); }
  }
});

test('P2-1: subpasta ou .partes redirecionadas por junção dentro da pasta própria = 4 LINK_RECUSADO antes de montar, transportar ou limpar', () => {
  for (const sub of ['scripts', 'database/checks', '.partes']) {
    const d = deploy();
    try {
      if (sub !== '.partes') sessao(d, todasAsPartes(d));
      const alvo = path.join(d, 'redirecionado'); fs.mkdirSync(alvo);
      const isca = path.join(alvo, 'isca.txt'); fs.writeFileSync(isca, 'do deploy');
      const ponto = path.join(d, PASTA, sub); fs.mkdirSync(path.dirname(ponto), {recursive: true}); fs.rmSync(ponto, {recursive: true, force: true});
      fs.symlinkSync(alvo, ponto, 'junction');
      for (const [modo, opcoes] of [['PARTE-1', {}], ['CONFERIR-092-093', {}], ['APLICAR-092-093', {registro: backup(d)}], ['LIMPEZA', {}]]) {
        const r = rodar(d, modo, RODOU, opcoes);
        assert.equal(codigo(r.saida), 4, `${sub} ${modo}: ` + r.saida.slice(-200)); assert.match(r.saida, /^LINK_RECUSADO \.\//m, `${sub} ${modo}`);
        assert.doesNotMatch(r.saida, /APLICADOR_RODOU|REMOVIDO|TRANSPORTADO|ESCRITO/);
      }
      assert.deepEqual(fs.readdirSync(alvo), ['isca.txt'], sub + ': nada gravado no alvo redirecionado');
      fs.unlinkSync(ponto);
    } finally { limpar(d); }
  }
});

test('P2-1: lugar físico divergente que não é link (ex.: ponto de montagem) = 4 DESTINO_FORA_DO_LUGAR antes de gravar ou limpar', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    // Simula o que um link não revela: dentro da pasta própria, `pwd -P` aponta para outro lugar.
    const falso = 'pwd() { if [ "${1:-}" = "-P" ] && [ "$(builtin pwd)" != "$DEPLOY_REAL" ]; then echo /montagem/outro-lugar; else builtin pwd "$@"; fi; }\nexport -f pwd\n'
      + `export DEPLOY_REAL='${posix(d)}'\n`;
    for (const [modo, opcoes] of [['PARTE-1', {}], ['CONFERIR-099', {}], ['APLICAR-099', {registro: backup(d)}], ['LIMPEZA', {}]]) {
      const r = sessao(d, falso + gerar(d, modo, RODOU), opcoes);
      assert.equal(codigo(r.saida), 4, modo + r.saida.slice(-200)); assert.match(r.saida, /^DESTINO_FORA_DO_LUGAR \/montagem\/outro-lugar$/m, modo);
      assert.doesNotMatch(r.saida, /APLICADOR_RODOU|REMOVIDO|TRANSPORTADO|ESCRITO/);
    }
    assert.equal(presentes(d).length, 0); assert.equal(partesPresentes(d), new Set(LISTA.map(x => x.sha)).size, 'nada removido');
  } finally { limpar(d); }
});

test('arquivo presente e diferente na pasta própria: código 4 sem montar os demais; LIMPEZA preserva o divergente', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const alvo = path.join(d, PASTA, 'scripts/migration-099-comum.cjs'); fs.mkdirSync(path.dirname(alvo), {recursive: true}); fs.writeFileSync(alvo, '// outro\n');
    const r = rodar(d, 'CONFERIR-099', RODOU); assert.equal(codigo(r.saida), 4); assert.doesNotMatch(r.saida, /APLICADOR_RODOU/);
    assert.match(r.saida, /JA_EXISTE_DIFERENTE scripts\/migration-099-comum\.cjs/); assert.deepEqual(presentes(d), ['scripts/migration-099-comum.cjs']);
    // Defesa em profundidade (P2-2): mesmo um corpo sem as linhas `livre`, o `inst` reconfere o sha antes de JA_PRESENTE.
    const sem = rodar(d, 'CONFERIR-099', RODOU, {}, t => t.split('\n').filter(l => !l.startsWith('livre scripts/')).join('\n'));
    assert.equal(codigo(sem.saida), 4, sem.saida.slice(-200)); assert.match(sem.saida, /^JA_EXISTE_DIFERENTE scripts\/migration-099-comum\.cjs$/m); assert.doesNotMatch(sem.saida, /APLICADOR_RODOU/);
    const l = rodar(d, 'LIMPEZA'); assert.match(l.saida, /DIVERGENTE_PRESERVADO scripts\/migration-099-comum\.cjs/); assert.match(l.saida, /^PASTA_MANTIDA/m); assert.ok(fs.existsSync(alvo));
  } finally { limpar(d); }
});

test('parte já presente e adulterada: colar a parte = 4 PARTE_EXISTE_DIFERENTE; o curto acusa e não monta', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const x = PARTES[0].itens[0]; fs.writeFileSync(path.join(d, PASTA, '.partes', x.sha), 'adulterado');
    const p = rodar(d, 'PARTE-1'); assert.equal(codigo(p.saida), 4); assert.match(p.saida, new RegExp('^PARTE_EXISTE_DIFERENTE ' + x.sha + '$', 'm'));
    const r = rodar(d, 'CONFERIR-092-093', OK); assert.equal(codigo(r.saida), 4);
    assert.match(r.saida, new RegExp('^PARTE_AUSENTE_OU_DIVERGENTE ' + re(x.arquivo) + ' \\(colar a PARTE-1\\)$', 'm')); assert.deepEqual(presentes(d), []);
  } finally { limpar(d); }
});

test('defesas internas da parte (corpo íntegro mas carga ruim): base64/gzip corrompido ou conteúdo VÁLIDO trocado = 4 CONTEUDO_DIVERGENTE, nada gravado', () => {
  const alvo = PARTES[0].itens[0];
  const outro = zlib.gzipSync(Buffer.from('-- outro conteudo valido\n'), {level: 9}).toString('base64').match(/.{1,76}/g);
  for (const alterar of [t => { const L = t.split('\n'), i = L.findIndex(x => x.startsWith(`prep ${alvo.sha} `)) + 1; L[i] = L[i].replace(/^./, c => c === 'A' ? 'B' : 'A'); return L.join('\n'); },
    t => { const L = t.split('\n'), i = L.findIndex(x => x.startsWith(`prep ${alvo.sha} `)), j = L.indexOf('B64', i); L.splice(i + 1, j - i - 1, ...outro); return L.join('\n'); }]) {
    const d = deploy();
    try {
      const r = rodar(d, 'PARTE-1', null, {}, alterar); assert.equal(codigo(r.saida), 4, r.saida.slice(-300));
      assert.match(r.saida, new RegExp('^CONTEUDO_DIVERGENTE ' + re(alvo.arquivo) + '$', 'm')); assert.equal(partesPresentes(d), 0);
    } finally { limpar(d); }
  }
});

test('parte grava só depois de conferir TODOS os itens: item seguinte já presente e divergente = 4 sem gravar nem o primeiro', () => {
  const d = deploy();
  try {
    const [primeiro, segundo] = PARTES[0].itens;
    fs.mkdirSync(path.join(d, PASTA, '.partes'), {recursive: true}); fs.writeFileSync(path.join(d, PASTA, '.partes', segundo.sha), 'adulterado');
    const r = rodar(d, 'PARTE-1'); assert.equal(codigo(r.saida), 4, r.saida.slice(-300));
    assert.match(r.saida, new RegExp('^PARTE_EXISTE_DIFERENTE ' + segundo.sha + '$', 'm'));
    assert.ok(!fs.existsSync(path.join(d, PASTA, '.partes', primeiro.sha)), 'o primeiro item não foi gravado');
    assert.doesNotMatch(r.saida, /^TRANSPORTADO /m); assert.equal(partesPresentes(d), 1);
  } finally { limpar(d); }
});

/** Remove a linha i (não comentário) do bloco e roda; devolve a saída. */
function semLinha(d, bloco, i, opcoes) { const L = bloco.split('\n'); L.splice(i, 1); return sessao(d, L.join('\n'), opcoes).saida; }
test('P2-2: perder QUALQUER linha de um curto (APLICAR-099, arquivo divergente presente) nunca dá 0 sem executar nem executa com o divergente', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const nome = backup(d), alvo = path.join(d, PASTA, 'scripts/migration-099-comum.cjs');
    fs.mkdirSync(path.dirname(alvo), {recursive: true}); fs.writeFileSync(alvo, '// divergente\n');
    const bloco = gerar(d, 'APLICAR-099', RODOU), L = bloco.split('\n');
    const intacto = sessao(d, bloco, {registro: nome}).saida;
    assert.equal(codigo(intacto), 4); assert.match(intacto, /^JA_EXISTE_DIFERENTE scripts\/migration-099-comum\.cjs$/m); assert.doesNotMatch(intacto, /APLICADOR_RODOU/);
    let testadas = 0;
    for (let i = 0; i < L.length; i++) {
      if (L[i].startsWith('#') || L[i] === '') continue;
      const s = semLinha(d, bloco, i, {registro: nome}); testadas++;
      assert.doesNotMatch(s, /APLICADOR_RODOU/, `linha ${i} (${L[i].slice(0, 40)}): executou com o divergente`);
      assert.ok(!codigos(s).includes(0), `linha ${i} (${L[i].slice(0, 40)}): código 0 sem execução`);
      assert.equal(fs.readFileSync(alvo, 'utf8'), '// divergente\n');
    }
    assert.ok(testadas > 20, String(testadas));
  } finally { limpar(d); }
});

test('P2-2: perder QUALQUER linha de um curto íntegro: ou executa (0 com APLICADOR_RODOU) ou não executa e não imprime 0; a linha de execução perdida não dá 0', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const nome = backup(d), bloco = gerar(d, 'APLICAR-092-093', RODOU), L = bloco.split('\n');
    for (let i = 0; i < L.length; i++) {
      if (L[i].startsWith('#') || L[i] === '') continue;
      const s = semLinha(d, bloco, i, {registro: nome}), rodou = /^APLICADOR_RODOU /m.test(s);
      if (codigos(s).includes(0)) assert.ok(rodou, `linha ${i} (${L[i].slice(0, 40)}): 0 sem executar`);
      if (rodou) assert.match(s, /^ARQUIVOS_OK 28$/m, `linha ${i}: executou sem a montagem conferida`);
    }
    // As duas sondas da revisão: sem a linha de execução do carregador, nada roda e não há código 0.
    const exec = L.findIndex(l => l.startsWith('if [ "$(sha256sum "$C"'));
    const s = semLinha(d, bloco, exec, {registro: nome}); assert.doesNotMatch(s, /APLICADOR_RODOU/); assert.deepEqual(codigos(s), []);
  } finally { limpar(d); }
});

test('P2-2: perder linhas de uma PARTE (amostra do corpo + todo o carregador): nunca 0 sem PARTE_k_OK, nunca parte gravada com conteúdo errado', () => {
  const d = deploy();
  try {
    const bloco = gerar(d, `PARTE-${N}`), L = bloco.split('\n'), ini = L.findIndex(l => l === b.ABERTURA_CARREGADOR);
    const corpoIni = L.indexOf(b.LINHA_TEMPORARIO), corpoFim = L.indexOf('CORPO', corpoIni + 1);
    for (let i = ini - 1; i < L.length; i++) {
      if (L[i] === '' || (i > corpoIni && i < corpoFim && (i - corpoIni) % 7 !== 1)) continue;
      fs.rmSync(path.join(d, PASTA), {recursive: true, force: true});
      const s = semLinha(d, bloco, i, {});
      if (codigos(s).includes(0)) assert.match(s, new RegExp(`^PARTE_${N}_DE_${N}_OK `, 'm'), `linha ${i}: 0 sem a parte`);
      for (const x of PARTES[N - 1].itens) {
        const f = path.join(d, PASTA, '.partes', x.sha);
        if (fs.existsSync(f)) assert.equal(sha(fs.readFileSync(f)), x.sha, `linha ${i}: parte gravada errada`);
      }
    }
  } finally { limpar(d); }
});

test('colagem truncada (25/50/90/99,9 %) de uma parte ou do APLICAR-099: nada gravado nem executado', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d).replace(gerar(d, 'PARTE-2'), ''));
    const semParte2 = new Set(LISTA.filter(y => y.parte !== 2).map(y => y.sha)).size, nome = backup(d);
    for (const modo of ['PARTE-2', 'APLICAR-099']) {
      const x = gerar(d, modo, RODOU);
      for (const fr of [0.25, 0.5, 0.9, 0.999]) {
        const r = sessao(d, x.slice(0, Math.floor(x.length * fr)), {registro: nome});
        assert.equal(codigos(r.saida).length, 0, `${modo} ${fr}`); assert.doesNotMatch(r.saida, /APLICADOR_RODOU/); assert.deepEqual(presentes(d), []);
        assert.equal(partesPresentes(d), semParte2, `${modo} ${fr}: nenhuma parte nova`);
      }
    }
  } finally { limpar(d); }
});

test('colagem interativa (bash -i): shell do operador sobrevive, sem opções/umask/cwd/trap herdados; códigos 0/1/2/3/4 legíveis', () => {
  const POS = ['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"', 'trap -p EXIT', 'cat arquivo-que-nao-existe-no-teste', 'echo SHELL_DO_OPERADOR_VIVO'].join('\n') + '\n';
  for (const [rotulo, modo, comando, comBackup, esperado] of [['conferido', 'CONFERIR-092-093', OK, false, 0], ['recusa antes de conectar', 'CONFERIR-099', 'node -e "process.exitCode=1"', false, 1],
    ['falha', 'APLICAR-092-093', 'node -e "process.exitCode=2"', true, 2], ['recusaria', 'CONFERIR-099', 'node -e "process.exitCode=3"', false, 3],
    ['sem backup', 'APLICAR-099', OK, false, 4]]) {
    const d = deploy();
    try {
      const op = {interativo: true, ...(comBackup ? {registro: backup(d)} : {})};
      const inicio = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n', op).saida;
      const r = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n' + todasAsPartes(d) + gerar(d, modo, comando) + POS, op);
      assert.deepEqual(codigos(r.saida), [...Array(N).fill(0), esperado], rotulo + ': ' + r.saida.slice(-400)); assert.match(r.saida, /^SHELL_DO_OPERADOR_VIVO$/m, rotulo);
      const a = /^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(inicio), p = /^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
      assert.ok(a && p, rotulo); assert.equal(p[1], a[1]); assert.equal(p[2], a[2]); assert.equal(p[3].trim(), a[3].trim());
      assert.doesNotMatch(r.saida, /trap -- .*EXIT/); assert.equal(temporarios(d), 0, rotulo);
    } finally { limpar(d); }
  }
});

test('o corpo roda num bash sem BASH_ENV/ENV: um arquivo de inicialização do shell do operador não entra no programa conferido', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const ini = path.join(d, 'injetado.sh'); fs.writeFileSync(ini, 'echo INJETADO_NO_CORPO\n');
    const f = d + '-ini.sh'; fs.writeFileSync(f, gerar(d, 'CONFERIR-099', OK));
    const env = {...process.env, RENDER_SERVICE_ID: b.SERVICO, BASH_ENV: posix(ini), ENV: posix(ini), TMPDIR: posix(path.join(d, 'tmp'))};
    // bash -i não lê BASH_ENV; um bash filho não interativo leria — só o corpo poderia imprimir a marca.
    const r = spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env}); fs.rmSync(f, {force: true});
    const s = (r.stdout || '') + (r.stderr || '');
    assert.equal(codigo(s), 0, s.slice(-300)); assert.doesNotMatch(s, /INJETADO_NO_CORPO/);
  } finally { limpar(d); }
});

const RM_FALSO = 'rm() { echo "rm falso: $*" >&2; return 1; }\nexport -f rm\n';
test('trap: falha do rm vira aviso TEMPORARIO_NAO_REMOVIDO e não muda o código (parte e APLICAR com 0/1/2/3 e sinal); LIMPEZA com rm falso = 4', () => {
  const d0 = deploy();
  try {
    const r = sessao(d0, RM_FALSO + gerar(d0, 'PARTE-1')); assert.equal(codigo(r.saida), 0, r.saida.slice(-300)); assert.equal(linhas(r.saida, /^TEMPORARIO_NAO_REMOVIDO /), 1);
  } finally { limpar(d0); }
  for (const [comando, esperado] of [[OK, 0], ['node -e "process.exitCode=1"', 1], ['node -e "process.exitCode=2"', 2],
    ['node -e "process.exitCode=3"', 3], ["bash -c 'kill -TERM $$'", 143]]) {
    const d = deploy();
    try {
      sessao(d, todasAsPartes(d));
      const r = sessao(d, RM_FALSO + gerar(d, 'APLICAR-099', comando), {registro: backup(d)});
      assert.equal(codigo(r.saida), esperado, comando + ': ' + r.saida.slice(-300)); assert.equal(linhas(r.saida, /^=== REGISTRO /), 1);
    } finally { limpar(d); }
  }
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d)); assert.equal(codigo(rodar(d, 'CONFERIR-092-093', OK).saida), 0);
    const l = sessao(d, RM_FALSO + gerar(d, 'LIMPEZA')); assert.equal(codigo(l.saida), 4); assert.match(l.saida, /^REMOCAO_FALHOU scripts\/migration-092-094-production\.cjs$/m);
    assert.equal(presentes(d).length, ARQ.length);
  } finally { limpar(d); }
});

/** Isca do operador: pasta com um arquivo; confere que sobreviveu intacta. */
function isca(d) {
  const p = path.join(d, 'isca-do-operador'); fs.mkdirSync(p, {recursive: true}); fs.writeFileSync(path.join(p, 'dado.txt'), 'DO OPERADOR');
  return {caminho: posix(p), intacta: () => fs.existsSync(path.join(p, 'dado.txt')) && fs.readFileSync(path.join(p, 'dado.txt'), 'utf8') === 'DO OPERADOR'};
}

test('P2-N1: T exportado no Shell apontando para uma isca — em TODOS os modos (e numa PARTE que para antes do mktemp) a isca sobrevive', () => {
  const d = deploy();
  try {
    const I = isca(d), env = {T: I.caminho};
    const nome = backup(d);
    // Antes das partes: curtos recusam (montagem/backup) e a LIMPEZA não tem o que limpar — sem tocar na isca.
    for (const [modo, opcoes] of [['CONFERIR-092-093', {}], ['CONFERIR-099', {}], ['APLICAR-092-093', {}], ['APLICAR-099', {registro: nome}], ['LIMPEZA', {}]]) {
      const r = rodar(d, modo, RODOU, {...opcoes, env}); assert.ok([0, 4].includes(codigo(r.saida)), modo + r.saida.slice(-300));
      assert.ok(I.intacta(), 'R-ISCA-T antes das partes: ' + modo);
    }
    // PARTE que para antes do mktemp: destino ocupado por um ARQUIVO = DESTINO_NAO_E_PASTA.
    fs.writeFileSync(path.join(d, PASTA), 'arquivo no lugar da pasta');
    const recusa = rodar(d, 'PARTE-1', null, {env}); assert.equal(codigo(recusa.saida), 4); assert.match(recusa.saida, /^DESTINO_NAO_E_PASTA /m);
    assert.ok(I.intacta(), 'R-ISCA-T parte recusada antes do mktemp'); fs.rmSync(path.join(d, PASTA));
    // Partes e curtos de verdade, com o T herdado: a isca nunca é o temporário removido.
    for (let k = 1; k <= N; k++) { const p = rodar(d, `PARTE-${k}`, null, {env}); assert.equal(codigo(p.saida), 0, p.saida.slice(-300)); assert.ok(I.intacta(), 'R-ISCA-T PARTE-' + k); }
    assert.equal(temporarios(d), 0, 'o temporário da própria parte foi removido');
    for (const [modo, opcoes] of [['CONFERIR-092-093', {}], ['APLICAR-092-093', {registro: nome}], ['CONFERIR-099', {}], ['APLICAR-099', {registro: nome}]]) {
      const r = rodar(d, modo, RODOU, {...opcoes, env}); assert.equal(codigo(r.saida), 0, modo + r.saida.slice(-300)); assert.ok(I.intacta(), 'R-ISCA-T ' + modo);
    }
    const l = rodar(d, 'LIMPEZA', null, {env}); assert.equal(codigo(l.saida), 0, l.saida.slice(-300)); assert.ok(I.intacta(), 'R-ISCA-T LIMPEZA');
    assert.ok(intactoDoDeploy(d));
    // Defesa em profundidade: o CORPO executado diretamente (sem o "( unset C T" do carregador) com T herdado no ambiente.
    for (const modo of ['CONFERIR-099', 'LIMPEZA', 'PARTE-1']) {
      const programa = b.corpo({modo, destino: posix(d) + '/' + PASTA, deploy: posix(d), comando: modo === 'CONFERIR-099' ? RODOU : null});
      const r = sessao(d, programa, {env}); assert.ok([0, 4].includes(codigo(r.saida)), modo + r.saida.slice(-300));
      assert.ok(I.intacta(), 'R-ISCA-T corpo direto ' + modo);
    }
  } finally { limpar(d); }
});

test('P3-N1: linha do mktemp perdida com C do shell do operador (não exportada ou exportada) apontando para um arquivo-isca: isca intacta, nada executado', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const L = gerar(d, 'CONFERIR-099', RODOU).trimEnd().split('\n'), i = L.findIndex(l => l.startsWith('C="$(mktemp)"'));
    assert.ok(i > 0); assert.ok(L.includes(b.ABERTURA_CARREGADOR), 'abertura limpa C e T');
    const semMktemp = [...L.slice(0, i), ...L.slice(i + 1)].join('\n') + '\n';
    const arquivo = posix(path.join(d, 'arquivo-do-operador.txt'));
    for (const [rotulo, pre, env] of [['não exportada', `C='${arquivo}'\n`, {}], ['exportada', '', {C: arquivo}]]) {
      fs.writeFileSync(arquivo, 'ARQUIVO DO OPERADOR');
      const r = sessao(d, pre + semMktemp, {env});
      assert.ok(fs.existsSync(arquivo) && fs.readFileSync(arquivo, 'utf8') === 'ARQUIVO DO OPERADOR', 'R-ISCA-C ' + rotulo + ': ' + r.saida.slice(-300));
      assert.doesNotMatch(r.saida, /^APLICADOR_RODOU /m, rotulo); assert.ok(!codigos(r.saida).includes(0), rotulo);
    }
  } finally { limpar(d); }
});

test('P2-R3-1: C ou T SOMENTE LEITURA no shell (readonly / declare -rx; script e bash -i): recusa 4 antes de tudo — com ou sem a linha do mktemp, isca intacta, nada executado, sem 0', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const arquivo = posix(path.join(d, 'arquivo do operador.txt')), pasta = isca(d);
    for (const modo of ['CONFERIR-099', 'LIMPEZA']) {
      const L = gerar(d, modo, modo === 'LIMPEZA' ? null : RODOU).trimEnd().split('\n'), i = L.findIndex(l => l.startsWith('C="$(mktemp)"'));
      const inteiro = L.join('\n') + '\n', semMktemp = [...L.slice(0, i), ...L.slice(i + 1)].join('\n') + '\n';
      for (const [rotulo, pre] of [['readonly C', `readonly C='${arquivo}'\n`], ['declare -rx C', `declare -rx C='${arquivo}'\n`],
        ['readonly T', `readonly T='${pasta.caminho}'\n`], ['declare -rx T', `declare -rx T='${pasta.caminho}'\n`]])
        for (const [forma, bloco] of [['sem mktemp', semMktemp], ['inteiro', inteiro]])
          for (const interativo of [false, true]) {
            fs.writeFileSync(arquivo, 'ARQUIVO DO OPERADOR');
            const r = sessao(d, pre + bloco, {interativo}), nome = `${modo} ${rotulo} ${forma} ${interativo ? 'bash -i' : 'script'}`;
            assert.equal(conteudo(arquivo), 'ARQUIVO DO OPERADOR', 'R-READONLY isca: ' + nome + r.saida.slice(-300));
            assert.ok(pasta.intacta(), 'R-READONLY pasta-isca: ' + nome);
            assert.match(r.saida, /^VARIAVEIS_DO_CARREGADOR_NAO_LIMPAS /m, nome); assert.deepEqual(codigos(r.saida), [4], nome);
            assert.doesNotMatch(r.saida, /APLICADOR_RODOU|NADA_A_LIMPAR|REMOVIDO /, nome);
          }
    }
  } finally { limpar(d); }
});

test('P2-R4-1: aliases e funções do operador (builtin/command/unset) contornando a limpeza de C — perder a linha do temporário nunca escreve nem apaga o arquivo de C; bloco inteiro roda normal', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const arquivo = posix(path.join(d, 'arquivo do operador.txt'));
    const variantes = [
      ['alias builtin=true', "shopt -s expand_aliases\nalias builtin='true'\n"],
      ['alias command/unset=true', "shopt -s expand_aliases\nalias command='true'\nalias unset='true'\n"],
      ['função builtin', 'builtin() { return 0; }\n'],
      ['função command', 'command() { return 0; }\n'],
    ];
    for (const modo of ['CONFERIR-099', 'LIMPEZA']) {
      // P3-R5-1: a linha perdida é a que atribui o temporário, achada pelo conteúdo — um carregador em outro formato
      // (ex.: mktemp, trap e heredoc em linhas separadas) chega às asserções da isca em vez de cair na procura.
      const L = gerar(d, modo, modo === 'LIMPEZA' ? null : RODOU).trimEnd().split('\n'), i = L.findIndex(l => l.startsWith('C="$(mktemp)"'));
      assert.ok(i > 0, modo);
      const inteiro = L.join('\n') + '\n', semTemporario = [...L.slice(0, i), ...L.slice(i + 1)].join('\n') + '\n';
      for (const [rotulo, pre] of variantes)
        for (const interativo of [false, true]) {
          const nome = `${modo} ${rotulo} ${interativo ? 'bash -i' : 'script'}`;
          fs.writeFileSync(arquivo, 'ARQUIVO DO OPERADOR');
          const r = sessao(d, pre + `C='${arquivo}'\n` + semTemporario, {interativo});
          assert.equal(fs.existsSync(arquivo) && fs.readFileSync(arquivo, 'utf8'), 'ARQUIVO DO OPERADOR', 'R-ALIAS isca, sem a linha: ' + nome + r.saida.slice(-300));
          assert.doesNotMatch(r.saida, /APLICADOR_RODOU|NADA_A_LIMPAR|REMOVIDO /, nome); assert.ok(!codigos(r.saida).includes(0), nome);
          if (modo === 'LIMPEZA') continue;
          // Bloco inteiro com o mesmo shell: o temporário novo substitui C; roda normal e o arquivo do operador fica intacto.
          fs.writeFileSync(arquivo, 'ARQUIVO DO OPERADOR');
          const ok = sessao(d, pre + `C='${arquivo}'\n` + inteiro, {interativo});
          assert.equal(conteudo(arquivo), 'ARQUIVO DO OPERADOR', 'R-ALIAS isca, bloco inteiro: ' + nome);
          assert.match(ok.saida, /^APLICADOR_RODOU /m, nome + ok.saida.slice(-300)); assert.equal(codigo(ok.saida), 0, nome);
        }
    }
    assert.equal(temporarios(d), 0, 'nenhum temporário deixado');
  } finally { limpar(d); }
});

test('P3-R5-1: alias builtin/command/unset × C ou T SOMENTE LEITURA (script e bash -i, com e sem a linha do temporário): recusa 4 com o motivo, iscas intactas, nada executado', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const arquivo = posix(path.join(d, 'arquivo do operador.txt')), pasta = isca(d);
    for (const modo of ['CONFERIR-099', 'LIMPEZA']) {
      const L = gerar(d, modo, modo === 'LIMPEZA' ? null : RODOU).trimEnd().split('\n'), i = L.findIndex(l => l.startsWith('C="$(mktemp)"'));
      assert.ok(i > 0, modo);
      const inteiro = L.join('\n') + '\n', semTemporario = [...L.slice(0, i), ...L.slice(i + 1)].join('\n') + '\n';
      for (const [rotuloAlias, alias] of [['alias builtin=true', "alias builtin='true'\n"], ['alias command/unset=true', "alias command='true'\nalias unset='true'\n"]])
        for (const [rotulo, ro] of [['readonly C', `readonly C='${arquivo}'\n`], ['readonly T', `readonly T='${pasta.caminho}'\n`]])
          for (const [forma, bloco] of [['sem temporário', semTemporario], ['inteiro', inteiro]])
            for (const interativo of [false, true]) {
              const nome = `${modo} ${rotuloAlias} ${rotulo} ${forma} ${interativo ? 'bash -i' : 'script'}`;
              fs.writeFileSync(arquivo, 'ARQUIVO DO OPERADOR');
              const r = sessao(d, 'shopt -s expand_aliases\n' + alias + ro + bloco, {interativo});
              assert.equal(conteudo(arquivo), 'ARQUIVO DO OPERADOR', 'R-ALIAS-RO isca: ' + nome + r.saida.slice(-300));
              assert.ok(pasta.intacta(), 'R-ALIAS-RO pasta-isca: ' + nome);
              assert.match(r.saida, /^VARIAVEIS_DO_CARREGADOR_NAO_LIMPAS /m, nome + r.saida.slice(-300)); assert.deepEqual(codigos(r.saida), [4], nome);
              assert.doesNotMatch(r.saida, /APLICADOR_RODOU|NADA_A_LIMPAR|REMOVIDO /, nome);
            }
    }
    assert.equal(temporarios(d), 0, 'nenhum temporário deixado');
  } finally { limpar(d); }
});

test('P3-R5-2: FUNÇÃO command (sintética, return 0) × C ou T somente leitura — residual delimitado: a recusa explícita não é garantida, mas iscas intactas e nada executado com C apontando para isca de conteúdo diferente do corpo; com T só leitura e bloco inteiro o corpo conferido pode rodar', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const arquivo = posix(path.join(d, 'arquivo do operador.txt')), pasta = isca(d), tmp = path.join(d, 'tmp');
    for (const modo of ['CONFERIR-099', 'LIMPEZA']) {
      const L = gerar(d, modo, modo === 'LIMPEZA' ? null : RODOU).trimEnd().split('\n'), i = L.findIndex(l => l.startsWith('C="$(mktemp)"'));
      const inteiro = L.join('\n') + '\n', semTemporario = [...L.slice(0, i), ...L.slice(i + 1)].join('\n') + '\n';
      for (const [rotulo, ro] of [['readonly C', `readonly C='${arquivo}'\n`], ['readonly T', `readonly T='${pasta.caminho}'\n`]])
        for (const [forma, bloco] of [['sem temporário', semTemporario], ['inteiro', inteiro]])
          for (const interativo of [false, true]) {
            const nome = `${modo} função command ${rotulo} ${forma} ${interativo ? 'bash -i' : 'script'}`;
            fs.writeFileSync(arquivo, 'ARQUIVO DO OPERADOR');
            const r = sessao(d, 'command() { return 0; }\n' + ro + bloco, {interativo});
            assert.equal(conteudo(arquivo), 'ARQUIVO DO OPERADOR', 'R-COMMAND-RO isca: ' + nome + r.saida.slice(-300));
            assert.ok(pasta.intacta(), 'R-COMMAND-RO pasta-isca: ' + nome);
            // Temporários deixados aqui (mktemp antes da atribuição recusada) são vazios: nada do corpo escrito neles.
            for (const t of fs.readdirSync(tmp)) { assert.equal(fs.statSync(path.join(tmp, t)).size, 0, 'temporário vazio: ' + nome); fs.rmSync(path.join(tmp, t)); }
            const executou = /^(APLICADOR_RODOU|NADA_A_LIMPAR|REMOVIDO) /m.test(r.saida);
            if (rotulo === 'readonly C' || forma === 'sem temporário') {
              assert.ok(!executou, 'nada executado: ' + nome + r.saida.slice(-300)); assert.ok(!codigos(r.saida).includes(0), 'sem 0: ' + nome);
            } else assert.ok([[0], [4]].some(c => JSON.stringify(c) === JSON.stringify(codigos(r.saida))), 'T só leitura, bloco inteiro: 4 ou o corpo conferido rodou (0 só vem dele): ' + nome + r.saida.slice(-300));
          }
    }
  } finally { limpar(d); }
});

test('P3-R6-1: controles de execução legítima — sem o umask o corpo conferido roda; C com exatamente o corpo (função command, C comum ou somente leitura, sem a linha do temporário) executa esse corpo e não altera C; fixture independente da forma do carregador', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    // P3-R7-1: a preparação só procura as duas linhas que remove; qualquer outra forma do carregador chega ao comportamento.
    const bloco = preparacao('bloco', () => gerar(d, 'CONFERIR-099', RODOU)), L = bloco.trimEnd().split('\n');
    // (a) A linha do umask não muda os bytes conferidos: perdê-la roda o corpo conferido normalmente.
    const u = preparacao('linha do umask', () => { const k = L.indexOf('umask 077'); assert.ok(k > 0, 'ausente'); return k; });
    const semUmask = [...L.slice(0, u), ...L.slice(u + 1)].join('\n') + '\n';
    for (const interativo of [false, true]) {
      const r = sessao(d, semUmask, {interativo}), nome = 'sem umask ' + (interativo ? 'bash -i' : 'script');
      assert.match(r.saida, /^APLICADOR_RODOU /m, nome + r.saida.slice(-300)); assert.deepEqual(codigos(r.saida), [0], nome);
    }
    // (b) O sha confere bytes, não a origem: C com exatamente o corpo executa esse corpo legítimo, sem tocar no arquivo.
    const i = preparacao('linha que cria C', () => { const k = L.findIndex(l => l.startsWith('C="$(mktemp)"')); assert.ok(k > 0, 'ausente'); return k; });
    const semTemporario = [...L.slice(0, i), ...L.slice(i + 1)].join('\n') + '\n';
    // O corpo exato vem da função que gerar() embute (b.corpo, mesmos argumentos), não da decodificação do heredoc: não
    // depende da forma da linha do temporário nem da linha do sha. Que o heredoc traz exatamente b.corpo e o sha dele está
    // provado no teste do carregador (P2-2), por modo.
    const arquivo = posix(path.join(d, 'corpo exato.sh'));
    const exato = preparacao('corpo exato', () => Buffer.from(b.corpo({modo: 'CONFERIR-099', destino: posix(d) + '/' + PASTA, deploy: posix(d), comando: RODOU}), 'utf8'));
    for (const [rotulo, atrib] of [['C comum', `C='${arquivo}'\n`], ['readonly C', `readonly C='${arquivo}'\n`]])
      for (const interativo of [false, true]) {
        const nome = `função command, ${rotulo}, corpo exato, sem temporário, ${interativo ? 'bash -i' : 'script'}`;
        fs.writeFileSync(arquivo, exato);
        const r = sessao(d, 'command() { return 0; }\n' + atrib + semTemporario, {interativo});
        assert.match(r.saida, /^APLICADOR_RODOU /m, nome + r.saida.slice(-300)); assert.deepEqual(codigos(r.saida), [0], nome);
        assert.ok(fs.existsSync(arquivo), 'C não removido: ' + nome); assert.ok(fs.readFileSync(arquivo).equals(exato), 'C com os mesmos bytes: ' + nome);
      }
    assert.equal(temporarios(d), 0, 'nenhum temporário deixado');
  } finally { limpar(d); }
});

test('P3-N2: comando que falha antes do aplicador (ex.: .partes ocupado por um arquivo) diz onde parou e sai 1 sem ARQUIVOS_OK', () => {
  const d = deploy();
  try {
    fs.mkdirSync(path.join(d, PASTA)); fs.writeFileSync(path.join(d, PASTA, '.partes'), 'arquivo, não pasta');
    const r = rodar(d, 'CONFERIR-099', RODOU); assert.equal(codigo(r.saida), 1, r.saida.slice(-300));
    assert.match(r.saida, /^BLOCO_PAROU_COMANDO_FALHOU \(linha \d+ do programa\)/m); assert.doesNotMatch(r.saida, /ARQUIVOS_OK|APLICADOR_RODOU/);
    // Caminhos normais nunca imprimem o motivo de parada.
    const ok = deploy();
    try {
      const p = sessao(ok, todasAsPartes(ok)); assert.doesNotMatch(p.saida, /BLOCO_PAROU/);
      const c = rodar(ok, 'CONFERIR-099', 'node -e "process.exitCode=2"'); assert.equal(codigo(c.saida), 2); assert.doesNotMatch(c.saida, /BLOCO_PAROU/);
      const l = rodar(ok, 'LIMPEZA'); assert.equal(codigo(l.saida), 0); assert.doesNotMatch(l.saida, /BLOCO_PAROU/);
    } finally { limpar(ok); }
  } finally { limpar(d); }
});

test('hashes do corpo = conteúdo LF da árvore e = os que os blocos de produção do B-1 e do B-2 conferem', () => {
  const x = b.corpo({modo: 'LIMPEZA'});
  const origem = [b1.gerar({ambiente: 'production', modo: 'CONFERIR', rotulo: 'abcdef1'}), b2.gerar({ambiente: 'production', modo: 'CONFERIR', rotulo: 'abcdef1'})].join('\n');
  for (const a of ARQ) {
    const h = sha(lf(a));
    assert.ok(x.includes(`limpar ${a} ${h}`), a); assert.ok(x.includes(`limpar .partes/${h} ${h}`), a);
    assert.ok(origem.includes(`arq ${a} ${h}`), a + ': o mesmo sha que o bloco de origem confere');
  }
  // O node -e embutido do backup é JavaScript válido (sintaxe) e só lê.
  assert.doesNotThrow(() => new Function(b.JS_BACKUP)); assert.doesNotMatch(b.JS_BACKUP, /writeFile|unlink|rm\(|exec|spawn|'/);
});

test('CLI: TODOS grava os blocos com sha e bytes e recusa pasta existente; modo inválido = RECUSADO código 1', () => {
  const saida = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grupo-a-cli-')), 'blocos');
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'bloco-shell-entrega-grupo-a-producao.cjs'), 'TODOS', 'abcdef1', saida], {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr); const L = r.stdout.trim().split('\n'); assert.equal(L.length, N + 5);
    for (const l of L) { const [h, bytes, nome] = l.split(/\s+/); const conteudo = fs.readFileSync(path.join(saida, nome)); assert.equal(sha(conteudo), h); assert.equal(conteudo.length, Number(bytes)); }
    const denovo = spawnSync(process.execPath, [path.join(__dirname, 'bloco-shell-entrega-grupo-a-producao.cjs'), 'TODOS', 'abcdef1', saida], {encoding: 'utf8'});
    assert.equal(denovo.status, 1); assert.match(denovo.stderr, /PASTA_DE_SAIDA_INVALIDA_OU_EXISTENTE/);
    const x = spawnSync(process.execPath, [path.join(__dirname, 'bloco-shell-entrega-grupo-a-producao.cjs'), 'APLICAR-094', 'abcdef1'], {encoding: 'utf8'});
    assert.equal(x.status, 1); assert.match(x.stderr, /RECUSADO MODO_DESCONHECIDO/);
  } finally { fs.rmSync(path.dirname(saida), {recursive: true, force: true}); }
});
