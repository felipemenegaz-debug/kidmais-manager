/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell do reparo (20/10/2026): executados DE VERDADE com bash num deploy temporário (só as pastas diferem das de
// produção). O executor transportado roda a partir da pasta própria: no plano (sem conexão) e nos modos reais, que recusam
// antes de conectar por estarem fora do Render. Inclui colagem interativa (bash -i) e colagem truncada. Não toca banco nem /opt.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-reparo-bloqueios-producao-20261020.cjs');
const root = path.resolve(__dirname, '..');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const PASTA = '.kidmais-reparo-bloqueios-20261020';
const SENTINELA = '// arquivo do deploy: nunca lido, sobrescrito nem removido\r\n';

function deploy({pg = true} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-reparo-'));
  if (pg) {
    // pg "real" para o require do executor: aponta para o pacote do clone (só carregado; nenhuma conexão é aberta).
    fs.mkdirSync(path.join(d, 'node_modules/pg'), {recursive: true});
    fs.writeFileSync(path.join(d, 'node_modules/pg/package.json'), '{"name":"pg","main":"index.js"}');
    fs.writeFileSync(path.join(d, 'node_modules/pg/index.js'), `module.exports=require(${JSON.stringify(path.join(root, 'node_modules/pg'))});`);
  }
  fs.mkdirSync(path.join(d, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(d, 'scripts/migrations-lancamento-production.cjs'), SENTINELA);
  fs.mkdirSync(path.join(d, 'data/lancamento-venda-20261011'), {recursive: true});
  fs.writeFileSync(path.join(d, 'data/lancamento-venda-20261011/backup-teste.json'), '{}');
  fs.mkdirSync(path.join(d, 'tmp'));
  return d;
}
function sessao(d, conteudo, opcoes = {}) {
  const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : b.SERVICO;
  const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
  const env = {...process.env, TMPDIR: posix(path.join(d, 'tmp'))};
  for (const k of Object.keys(env)) if (/^(RENDER|DATABASE_|KIDMAIS_|PG)/.test(k)) delete env[k];
  if (opcoes.registro !== undefined) env.KIDMAIS_REGISTRO_BACKUP = opcoes.registro;
  if (servico !== undefined) env.RENDER_SERVICE_ID = servico;
  const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env})
    : spawnSync('bash', [f], {encoding: 'utf8', env});
  fs.rmSync(f, {force: true});
  return {status: r.status, saida: (r.stdout || '') + (r.stderr || '')};
}
const pastaBackup = d => posix(path.join(d, 'data/lancamento-venda-20261011'));
const gerar = (d, modo, comando) => b.gerar({modo, rotulo: 'abcdef1', destino: posix(path.join(d, PASTA)), deploy: posix(d), comando, pastaBackup: pastaBackup(d)});
const rodar = (d, modo, comando, opcoes) => sessao(d, gerar(d, modo, comando), opcoes);
const codigo = s => [...s.matchAll(/^CODIGO_SAIDA_BLOCO=(\d+)$/gm)].map(x => Number(x[1])).at(-1);
const presentes = d => b.ARQUIVOS.filter(a => fs.existsSync(path.join(d, PASTA, a)));
const registroOk = d => pastaBackup(d) + '/backup-teste.json';
const intactos = d => fs.readFileSync(path.join(d, 'scripts/migrations-lancamento-production.cjs'), 'utf8') === SENTINELA
  && fs.readdirSync(path.join(d, 'data/lancamento-venda-20261011')).join() === 'backup-teste.json';
const PLANO = `NODE_PATH='./node_modules' node ${b.EXECUTOR}`;

test('quatro blocos oficiais: ≤ 32 KB, ASCII, guarda de produção antes de tudo, subshell, código impresso, sem segredo', () => {
  assert.deepEqual(b.MODOS, ['CONFERIR', 'APLICAR', 'RETOMAR', 'LIMPEZA']);
  for (const modo of b.MODOS) {
    const x = b.gerar({modo, rotulo: 'abcdef1'});
    assert.ok(Buffer.byteLength(x) <= 32768, modo + ' ' + Buffer.byteLength(x));
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/);
    const L = x.split('\n'), i = L.findIndex(l => l.startsWith('if [ "$RENDER_SERVICE_ID" != "srv-dak77m2d0e5s73b8rkkg" ]'));
    assert.ok(i > 0 && L.slice(0, i).every(l => l.startsWith('#') || l.startsWith('bind ')), modo);
    assert.equal(L[i + 1], '('); assert.ok(L.includes(')') && L.includes('echo "CODIGO_SAIDA_BLOCO=$?"') && L.at(-2) === 'fi');
    assert.doesNotMatch(x, /DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\//);
    assert.match(x, /Ctrl-C, nunca colar por cima/);
    assert.doesNotMatch(x, /\/opt\/render\/project\/src\/scripts|rm -rf -- '\/opt|\/data\/[a-z-]+\/[a-z]/, 'nunca toca scripts/ do deploy nem arquivos do disco');
  }
  assert.match(b.gerar({modo: 'CONFERIR', rotulo: 'abcdef1'}), /^NODE_PATH='\/opt\/render\/project\/src\/node_modules' node scripts\/reparo-bloqueios-producao-20261020\.cjs --conferir \|\| codigo=\$\?$/m);
  const ap = b.gerar({modo: 'APLICAR', rotulo: 'abcdef1'});
  assert.match(ap, /^NODE_PATH='\/opt\/render\/project\/src\/node_modules' node scripts\/reparo-bloqueios-producao-20261020\.cjs --aplicar-autorizado --backup "\$KIDMAIS_REGISTRO_BACKUP" \|\| codigo=\$\?$/m);
  assert.ok(ap.indexOf('KIDMAIS_REGISTRO_BACKUP:-') < ap.indexOf("cd '/opt/render/project/src'"), 'registro conferido antes de tocar arquivos');
  assert.match(b.gerar({modo: 'RETOMAR', rotulo: 'abcdef1'}), /--retomar-autorizado --backup "\$KIDMAIS_REGISTRO_BACKUP" \|\| codigo=\$\?$/m);
  assert.doesNotMatch(b.gerar({modo: 'LIMPEZA', rotulo: 'abcdef1'}), /^NODE_PATH|^node |B64|KIDMAIS_REGISTRO_BACKUP/m);
  assert.throws(() => b.gerar({modo: 'X', rotulo: 'abcdef1'}), /MODO_DESCONHECIDO/);
  assert.throws(() => b.gerar({modo: 'CONFERIR', rotulo: 'abc; rm -rf /'}), /ROTULO_INVALIDO/);
});

test('carga: 4 arquivos com o sha LF da árvore; SQL e aplicador/trava do lançamento com os sha fixados (manifesto de 19/10)', () => {
  const c = b.carga(root);
  assert.deepEqual(c.map(x => x.arquivo), [...b.ARQUIVOS]);
  for (const x of c) assert.equal(x.sha, sha(fs.readFileSync(path.join(root, x.arquivo), 'utf8').replace(/\r\n/g, '\n')));
  const manifesto = JSON.parse(fs.readFileSync(path.join(root, 'docs/MIGRATIONS_PRODUCTION_20261019.json'), 'utf8'));
  assert.equal(b.SHA_FIXOS['scripts/migrations-lancamento-production.cjs'], manifesto.lancamento.aplicadorSha256);
  assert.equal(b.SHA_FIXOS['scripts/diagnostico-lancamento-production.cjs'], manifesto.lancamento.diagnosticoSha256);
});

test('shell de outro serviço (staging) ou sem RENDER_SERVICE_ID não executa nada, em nenhum bloco', () => {
  for (const servico of ['srv-daif418ae00c73e8k2gg', undefined]) {
    const d = deploy();
    try {
      for (const modo of b.MODOS) {
        const s = rodar(d, modo, undefined, {servico, registro: registroOk(d)});
        assert.match(s.saida, /SHELL_ERRADO_NAO_E_PRODUCAO/); assert.equal(codigo(s.saida), undefined, modo);
      }
      assert.equal(fs.existsSync(path.join(d, PASTA)), false); assert.ok(intactos(d));
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

test('CONFERIR: transporta os 4 arquivos com sha conferido e roda o executor da pasta própria; repetir = JA_PRESENTE', () => {
  const d = deploy();
  try {
    const p = rodar(d, 'CONFERIR', PLANO);
    assert.equal(codigo(p.saida), 0, p.saida); assert.match(p.saida, /ARQUIVOS_OK 4/);
    assert.match(p.saida, /"resultado": "PLANO"/); assert.match(p.saida, /"sha256": "a36f8fe9/);
    assert.deepEqual(presentes(d), [...b.ARQUIVOS]);
    for (const x of b.carga(root)) assert.equal(sha(fs.readFileSync(path.join(d, PASTA, x.arquivo))), x.sha, x.arquivo);
    assert.equal(fs.readdirSync(path.join(d, 'tmp')).length, 0, 'temporário removido');
    // Comando oficial: o executor recusa ANTES de conectar fora do Render (código 1, nenhum arquivo novo no disco).
    const r = rodar(d, 'CONFERIR');
    assert.equal(codigo(r.saida), 1, r.saida); assert.match(r.saida, /RECUSADO FORA_DO_RENDER/);
    assert.equal((r.saida.match(/JA_PRESENTE/g) || []).length, 4);
    assert.match(r.saida, /=== REGISTROS/); assert.ok(intactos(d));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('APLICAR/RETOMAR: registro do backup exigido antes de tocar arquivos; comando oficial recusa fora do Render (código 1)', () => {
  const d = deploy();
  try {
    for (const modo of ['APLICAR', 'RETOMAR']) {
      for (const [registro, msg] of [[undefined, 'REGISTRO_BACKUP_AUSENTE'], ['/tmp/backup-x.json', 'REGISTRO_BACKUP_INVALIDO'],
        [pastaBackup(d) + '/backup-a;b.json', 'REGISTRO_BACKUP_INVALIDO'], [pastaBackup(d) + '/backup-nao-existe.json', 'REGISTRO_BACKUP_NAO_ENCONTRADO']]) {
        const s = rodar(d, modo, undefined, {registro});
        assert.equal(codigo(s.saida), 4, s.saida); assert.match(s.saida, new RegExp(msg)); assert.equal(fs.existsSync(path.join(d, PASTA)), false);
      }
      const s = rodar(d, modo, undefined, {registro: registroOk(d)});
      assert.equal(codigo(s.saida), 1, s.saida); assert.match(s.saida, /RECUSADO FORA_DO_RENDER/);
      assert.match(s.saida, /ARQUIVOS_OK 4/); fs.rmSync(path.join(d, PASTA), {recursive: true});
    }
    assert.ok(intactos(d));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('recusas do bloco (código 4, nada gravado): pg ausente, arquivo presente diferente, carga corrompida', () => {
  const d0 = deploy({pg: false});
  try { const s = rodar(d0, 'CONFERIR', PLANO); assert.equal(codigo(s.saida), 4); assert.match(s.saida, /DEPENDENCIA_AUSENTE/); assert.equal(fs.existsSync(path.join(d0, PASTA)), false); }
  finally { fs.rmSync(d0, {recursive: true, force: true}); }
  const d = deploy();
  try {
    fs.mkdirSync(path.join(d, PASTA, 'database/repairs'), {recursive: true});
    fs.writeFileSync(path.join(d, PASTA, b.ARQUIVOS[1]), '-- outro conteudo\n');
    const s = rodar(d, 'CONFERIR', PLANO);
    assert.equal(codigo(s.saida), 4); assert.match(s.saida, /JA_EXISTE_DIFERENTE database\/repairs/);
    assert.deepEqual(presentes(d), [b.ARQUIVOS[1]], 'nenhum outro arquivo gravado');
    assert.equal(fs.readFileSync(path.join(d, PASTA, b.ARQUIVOS[1]), 'utf8'), '-- outro conteudo\n');
    fs.rmSync(path.join(d, PASTA), {recursive: true});
    const bloco = gerar(d, 'CONFERIR', PLANO), i = bloco.indexOf("<<'B64'\n") + 200;
    const corrompido = bloco.slice(0, i) + (bloco[i] === 'A' ? 'B' : 'A') + bloco.slice(i + 1);
    const c = sessao(d, corrompido);
    assert.equal(codigo(c.saida), 4); assert.match(c.saida, /CONTEUDO_DIVERGENTE/); assert.deepEqual(presentes(d), []);
    assert.ok(intactos(d));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('colagem interativa (bash -i) funciona; colagem truncada não executa nada', () => {
  const d = deploy();
  try {
    const s = sessao(d, gerar(d, 'CONFERIR', PLANO), {interativo: true});
    assert.equal(codigo(s.saida), 0, s.saida); assert.deepEqual(presentes(d), [...b.ARQUIVOS]);
    fs.rmSync(path.join(d, PASTA), {recursive: true});
    const bloco = gerar(d, 'CONFERIR', PLANO);
    const t = sessao(d, bloco.slice(0, Math.floor(bloco.length / 2)), {interativo: true});
    assert.equal(codigo(t.saida), undefined); assert.equal(fs.existsSync(path.join(d, PASTA)), false);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('LIMPEZA: remove só arquivos com sha conferido, preserva divergente, nunca toca deploy nem disco; sem pasta = nada a limpar', () => {
  const d = deploy();
  try {
    const vazio = rodar(d, 'LIMPEZA');
    assert.equal(codigo(vazio.saida), 0); assert.match(vazio.saida, /PASTA_AUSENTE/);
    rodar(d, 'CONFERIR', PLANO);
    fs.writeFileSync(path.join(d, PASTA, b.ARQUIVOS[2]), '// alterado\n');
    const s = rodar(d, 'LIMPEZA');
    assert.equal(codigo(s.saida), 0); assert.match(s.saida, /DIVERGENTE_PRESERVADO scripts\/migrations-lancamento-production\.cjs/);
    assert.match(s.saida, /PASTA_MANTIDA/); assert.deepEqual(presentes(d), [b.ARQUIVOS[2]]);
    fs.rmSync(path.join(d, PASTA, b.ARQUIVOS[2]));
    const s2 = rodar(d, 'LIMPEZA');
    assert.match(s2.saida, /PASTA_REMOVIDA/); assert.equal(fs.existsSync(path.join(d, PASTA)), false);
    assert.ok(intactos(d));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});
