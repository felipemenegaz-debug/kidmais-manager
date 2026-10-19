/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell de produção (19/10/2026): executados DE VERDADE com bash num deploy temporário (só as pastas diferem das
// de produção; o comando do aplicador é omitido, trocado por um substituto que só devolve um código, ou roda o plano
// offline do próprio aplicador a partir da pasta própria). Inclui colagem interativa (bash -i). Não toca banco nem /opt.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-migracoes-producao-20261019.cjs');
const root = path.resolve(__dirname, '..');
const lf = a => fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const ARQ = b.arquivos(root);
const PASTA = '.kidmais-migracoes-producao-20261019';

function deploy({pg = true} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-mig-prod-'));
  if (pg) { fs.mkdirSync(path.join(d, 'node_modules/pg'), {recursive: true}); fs.writeFileSync(path.join(d, 'node_modules/pg/package.json'), '{"name":"pg"}'); fs.writeFileSync(path.join(d, 'node_modules/pg/index.js'), 'module.exports={Client:class{}};'); }
  // Arquivo do deploy com o MESMO caminho relativo de um SQL do pacote: nunca é lido, sobrescrito nem removido.
  fs.mkdirSync(path.join(d, 'database/checks'), {recursive: true}); fs.writeFileSync(path.join(d, 'database/checks/20261018_084_postcheck.sql'), '-- do deploy\r\n');
  fs.mkdirSync(path.join(d, 'data/lancamento-venda-20261011'), {recursive: true}); fs.writeFileSync(path.join(d, 'data/lancamento-venda-20261011/backup-teste.json'), '{}');
  fs.mkdirSync(path.join(d, 'tmp'));
  return d;
}
function sessao(d, conteudo, opcoes = {}) {
  const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : b.SERVICO;
  const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
  const env = {...process.env, TMPDIR: posix(path.join(d, 'tmp'))};
  delete env.KIDMAIS_REGISTRO_BACKUP; if (opcoes.registro !== undefined) env.KIDMAIS_REGISTRO_BACKUP = opcoes.registro;
  if (servico === undefined) delete env.RENDER_SERVICE_ID; else env.RENDER_SERVICE_ID = servico;
  const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env}) : spawnSync('bash', [f], {encoding: 'utf8', env});
  fs.rmSync(f, {force: true});
  return {status: r.status, saida: (r.stdout || '') + (r.stderr || '')};
}
const gerar = (d, modo, comando = null) => b.gerar({modo, rotulo: 'abcdef1', destino: posix(path.join(d, PASTA)), deploy: posix(d), comando,
  pastaBackup: posix(path.join(d, 'data/lancamento-venda-20261011'))});
const rodar = (d, modo, comando, opcoes) => sessao(d, gerar(d, modo, comando), opcoes);
const codigo = s => Number((/^CODIGO_SAIDA_BLOCO=(\d+)$/m.exec(s) || [])[1]);
const linhas = (s, re) => s.split(/\r?\n/).filter(l => re.test(l)).length;
const presentes = d => ARQ.filter(a => fs.existsSync(path.join(d, PASTA, a)));
const registroOk = d => posix(path.join(d, 'data/lancamento-venda-20261011/backup-teste.json'));
const temporarios = d => fs.readdirSync(path.join(d, 'tmp')).length;
const intactoDoDeploy = d => fs.readFileSync(path.join(d, 'database/checks/20261018_084_postcheck.sql'), 'utf8') === '-- do deploy\r\n';

test('arquivos: aplicador, 2 manifestos, aplicador e trava do lançamento e os 38 SQL, sem repetição', () => {
  assert.equal(ARQ.length, 43); assert.equal(new Set(ARQ).size, 43);
  assert.deepEqual(ARQ.slice(0, 5), ['scripts/migrations-producao-20261019.cjs', 'docs/MIGRATIONS_PRODUCTION_20261019.json', 'scripts/migrations-lancamento-production.cjs',
    'scripts/diagnostico-lancamento-production.cjs', 'docs/MIGRATIONS_PRODUCTION_LANCAMENTO_20261011.json']);
  assert.equal(b.DESTINO, '/opt/render/project/src/.kidmais-migracoes-producao-20261019'); assert.equal(b.SERVICO, 'srv-dak77m2d0e5s73b8rkkg');
  assert.throws(() => b.gerar({modo: 'X', rotulo: 'abcdef1'}), /MODO_DESCONHECIDO/);
  assert.throws(() => b.gerar({modo: 'CONFERIR', rotulo: 'abc; rm -rf /'}), /ROTULO_INVALIDO/);
});

test('blocos oficiais: ASCII, guarda de produção antes de tudo, subshell, código impresso, comando por modo, nada de segredo', () => {
  for (const modo of ['CONFERIR', 'APLICAR', 'LIMPEZA']) {
    const x = b.gerar({modo, rotulo: 'abcdef1'});
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/); assert.equal(Buffer.byteLength(x, 'utf8'), x.length);
    const L = x.split('\n'), i = L.findIndex(l => l.startsWith('if [ "$RENDER_SERVICE_ID" != "srv-dak77m2d0e5s73b8rkkg" ]'));
    assert.ok(i > 0 && L.slice(0, i).every(l => l.startsWith('#') || l.startsWith('bind ')), modo);
    assert.equal(L[i + 1], '('); assert.ok(L.includes(')') && L.includes('echo "CODIGO_SAIDA_BLOCO=$?"') && L.at(-2) === 'fi');
    assert.doesNotMatch(x, /DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\//);
    assert.match(x, /^mkdir -p '\/opt\/render\/project\/src\/\.kidmais-migracoes-producao-20261019' && cd /m);
  }
  assert.match(b.gerar({modo: 'CONFERIR', rotulo: 'abcdef1'}), /^NODE_PATH='\/opt\/render\/project\/src\/node_modules' node scripts\/migrations-producao-20261019\.cjs --conferir \|\| codigo=\$\?$/m);
  const ap = b.gerar({modo: 'APLICAR', rotulo: 'abcdef1'});
  assert.match(ap, /^NODE_PATH='\/opt\/render\/project\/src\/node_modules' node scripts\/migrations-producao-20261019\.cjs --aplicar-autorizado --backup "\$KIDMAIS_REGISTRO_BACKUP" \|\| codigo=\$\?$/m);
  assert.ok(ap.indexOf('KIDMAIS_REGISTRO_BACKUP:-') < ap.indexOf("cd '/opt/render/project/src'"), 'registro conferido antes de tocar arquivos');
  assert.doesNotMatch(b.gerar({modo: 'LIMPEZA', rotulo: 'abcdef1'}), /^NODE_PATH|^node |B64|KIDMAIS_REGISTRO_BACKUP/m);
});

test('shell de outro serviço (staging) ou sem RENDER_SERVICE_ID não executa nada', () => {
  for (const servico of ['srv-daif418ae00c73e8k2gg', undefined]) {
    const d = deploy();
    try { const r = rodar(d, 'APLICAR', null, {servico, registro: registroOk(d)}); assert.equal(r.status, 0); assert.match(r.saida, /^SHELL_ERRADO_NAO_E_PRODUCAO/m);
      assert.doesNotMatch(r.saida, /CODIGO_SAIDA_BLOCO/); assert.ok(!fs.existsSync(path.join(d, PASTA)));
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

test('APLICAR sem registro de backup, fora da pasta do P1, com metacaractere ou inexistente: código 4 antes de gravar', () => {
  for (const [registro, erro] of [[undefined, /^REGISTRO_BACKUP_AUSENTE/m], ['/tmp/backup-a.json', /^REGISTRO_BACKUP_INVALIDO$/m],
    [null, /^REGISTRO_BACKUP_INVALIDO$/m], ['naoexiste', /^REGISTRO_BACKUP_NAO_ENCONTRADO$/m]]) {
    const d = deploy();
    try {
      const reg = registro === null ? posix(path.join(d, 'data/lancamento-venda-20261011/backup-$(id).json')) : registro === 'naoexiste' ? posix(path.join(d, 'data/lancamento-venda-20261011/backup-outro.json')) : registro;
      const r = rodar(d, 'APLICAR', 'node -e "process.exitCode=0"', {registro: reg});
      assert.equal(codigo(r.saida), 4, r.saida.slice(-300)); assert.match(r.saida, erro); assert.ok(!fs.existsSync(path.join(d, PASTA)));
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

test('sem o pg implantado: código 4 antes de gravar qualquer arquivo', () => {
  const d = deploy({pg: false});
  try { const r = rodar(d, 'CONFERIR'); assert.equal(codigo(r.saida), 4); assert.match(r.saida, /DEPENDENCIA_AUSENTE node_modules\/pg/); assert.deepEqual(presentes(d), []); }
  finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('grava os 43 arquivos na pasta própria; deploy intacto; repetir = JA_PRESENTE; limpeza remove os 43 e a pasta', () => {
  const d = deploy();
  try {
    const r = rodar(d, 'APLICAR', null, {registro: registroOk(d)}); assert.equal(codigo(r.saida), 0, r.saida.slice(-400)); assert.match(r.saida, /ARQUIVOS_OK 43/);
    for (const a of ARQ) assert.equal(fs.readFileSync(path.join(d, PASTA, a), 'utf8'), lf(a), a);
    assert.equal(temporarios(d), 0); assert.ok(intactoDoDeploy(d));
    const r2 = rodar(d, 'CONFERIR'); assert.equal(codigo(r2.saida), 0); assert.equal(linhas(r2.saida, /^JA_PRESENTE /), 43);
    const l = rodar(d, 'LIMPEZA'); assert.equal(codigo(l.saida), 0, l.saida.slice(-300)); assert.equal(linhas(l.saida, /^REMOVIDO /), 43);
    assert.match(l.saida, /^PASTA_REMOVIDA$/m); assert.ok(!fs.existsSync(path.join(d, PASTA))); assert.ok(intactoDoDeploy(d));
    assert.ok(fs.existsSync(path.join(d, 'data/lancamento-venda-20261011/backup-teste.json')), 'disco persistente intocado');
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('pacote completo e executável da pasta própria: o plano offline do aplicador confere manifesto e 38 hashes lá', () => {
  const d = deploy();
  try {
    const r = rodar(d, 'CONFERIR', `NODE_PATH='${posix(d)}/node_modules' node scripts/migrations-producao-20261019.cjs --plano > plano.json && node -e "const p=require('./plano.json');if(p.resultado!=='PLANO'||p.sequencia.length!==15)process.exit(9)" && rm -f plano.json`);
    assert.equal(codigo(r.saida), 0, r.saida.slice(-500));
    const r2 = rodar(d, 'CONFERIR', `NODE_PATH='${posix(d)}/node_modules' node scripts/migrations-producao-20261019.cjs --conferir`);
    assert.equal(codigo(r2.saida), 1, r2.saida.slice(-300)); assert.match(r2.saida, /RECUSADO FORA_DO_RENDER/);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('arquivo presente e diferente na pasta própria: código 4 sem gravar os demais; limpeza preserva o divergente', () => {
  const d = deploy();
  try {
    const alvo = path.join(d, PASTA, 'database/migrations/20261018_086_marketing_automacoes.sql'); fs.mkdirSync(path.dirname(alvo), {recursive: true}); fs.writeFileSync(alvo, '-- outro\n');
    const r = rodar(d, 'APLICAR', 'node -e "process.exitCode=0"', {registro: registroOk(d)}); assert.equal(codigo(r.saida), 4);
    assert.match(r.saida, /JA_EXISTE_DIFERENTE database\/migrations\/20261018_086_marketing_automacoes\.sql/);
    assert.deepEqual(presentes(d), ['database/migrations/20261018_086_marketing_automacoes.sql']);
    const l = rodar(d, 'LIMPEZA'); assert.match(l.saida, /DIVERGENTE_PRESERVADO database\/migrations\/20261018_086/); assert.match(l.saida, /^PASTA_MANTIDA/m); assert.ok(fs.existsSync(alvo));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('conteúdo corrompido (base64/gzip ou sha): código 4 CONTEUDO_DIVERGENTE antes de gravar qualquer arquivo', () => {
  for (const corromper of [l => l.replace(/^./, c => c === 'A' ? 'B' : 'A'), l => '!!!' + l.slice(3)]) {
    const d = deploy();
    try {
      const L = gerar(d, 'CONFERIR').split('\n'), i = L.findIndex(x => x.startsWith('prep 7 ')) + 1; L[i] = corromper(L[i]);
      const r = sessao(d, L.join('\n')); assert.equal(codigo(r.saida), 4, r.saida.slice(-300));
      assert.match(r.saida, new RegExp('^CONTEUDO_DIVERGENTE ' + ARQ[7].replace(/[.]/g, '\\.') + '$', 'm')); assert.deepEqual(presentes(d), []);
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

test('colagem interativa (bash -i): shell do operador sobrevive, sem opções/umask/cwd/trap herdados; códigos 0/1/2/3/4 legíveis', () => {
  const POS = ['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"', 'trap -p EXIT', 'cat arquivo-que-nao-existe-no-teste', 'echo SHELL_DO_OPERADOR_VIVO'].join('\n') + '\n';
  for (const [rotulo, modo, comando, opcoes, esperado] of [['conferido', 'CONFERIR', 'node -e "process.exitCode=0"', {}, 0], ['recusa antes de conectar', 'CONFERIR', 'node -e "process.exitCode=1"', {}, 1],
    ['falha', 'APLICAR', 'node -e "process.exitCode=2"', {registro: true}, 2], ['recusaria', 'CONFERIR', 'node -e "process.exitCode=3"', {}, 3], ['sem registro', 'APLICAR', 'node -e "process.exitCode=0"', {}, 4]]) {
    const d = deploy();
    try {
      const op = {interativo: true, ...(opcoes.registro ? {registro: registroOk(d)} : {})};
      const inicio = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n', op).saida;
      const r = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n' + gerar(d, modo, comando) + POS, op);
      assert.equal(codigo(r.saida), esperado, rotulo + ': ' + r.saida.slice(-400)); assert.match(r.saida, /^SHELL_DO_OPERADOR_VIVO$/m, rotulo);
      const a = /^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(inicio), p = /^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
      assert.ok(a && p, rotulo); assert.equal(p[1], a[1]); assert.equal(p[2], a[2]); assert.equal(p[3].trim(), a[3].trim());
      assert.doesNotMatch(r.saida, /trap -- .*EXIT/); assert.equal(temporarios(d), 0, rotulo);
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

test('duas colagens na mesma sessão (CONFERIR e depois APLICAR) e a LIMPEZA: sem vazamento, shell vivo', () => {
  const d = deploy();
  try {
    const r = sessao(d, gerar(d, 'CONFERIR', 'node -e "process.exitCode=0"') + gerar(d, 'APLICAR', 'node -e "process.exitCode=0"') + gerar(d, 'LIMPEZA') + 'echo TRES_COLAGENS_OK\n', {interativo: true, registro: registroOk(d)});
    assert.equal(linhas(r.saida, /^CODIGO_SAIDA_BLOCO=0$/), 3, r.saida.slice(-400)); assert.match(r.saida, /^TRES_COLAGENS_OK$/m);
    assert.equal(linhas(r.saida, /^JA_PRESENTE /), 43); assert.equal(linhas(r.saida, /^REMOVIDO /), 43); assert.equal(temporarios(d), 0); assert.ok(intactoDoDeploy(d));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

const RM_FALSO = 'rm() { echo "rm falso: $*" >&2; return 1; }\n';
test('trap: falha do rm vira aviso TEMPORARIO_NAO_REMOVIDO e não muda o código (0/1/2/3 e sinal); LIMPEZA com rm falso = 4', () => {
  for (const [comando, esperado] of [['node -e "process.exitCode=0"', 0], ['node -e "process.exitCode=1"', 1], ['node -e "process.exitCode=2"', 2],
    ['node -e "process.exitCode=3"', 3], ["bash -c 'kill -TERM $$'", 143]]) {
    const d = deploy();
    try {
      const r = sessao(d, RM_FALSO + gerar(d, 'APLICAR', comando), {registro: registroOk(d)});
      assert.equal(codigo(r.saida), esperado, comando + ': ' + r.saida.slice(-300)); assert.equal(linhas(r.saida, /^=== REGISTROS /), 1);
      assert.equal(linhas(r.saida, /^TEMPORARIO_NAO_REMOVIDO /), 1); assert.equal(temporarios(d), 1);
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
  const d = deploy();
  try {
    assert.equal(codigo(rodar(d, 'CONFERIR', 'node -e "process.exitCode=0"').saida), 0);
    const l = sessao(d, RM_FALSO + gerar(d, 'LIMPEZA')); assert.equal(codigo(l.saida), 4); assert.match(l.saida, /^REMOCAO_FALHOU scripts\/migrations-producao-20261019\.cjs$/m);
    assert.equal(presentes(d).length, 43);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('hashes do bloco = hashes revisados dos manifestos (scripts e SQL LF)', () => {
  const x = b.gerar({modo: 'LIMPEZA', rotulo: 'abcdef1'});
  for (const a of ARQ) assert.ok(x.includes(`limpar ${a} ${sha(lf(a))}`), a);
});
