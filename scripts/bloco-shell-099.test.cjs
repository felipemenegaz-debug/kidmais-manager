/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 099 (produção) executados DE VERDADE com bash num destino temporário (só o destino difere do Render;
// o comando é o aplicador real — recusando antes de conectar, sem RENDER/DATABASE_URL — ou um substituto que só devolve
// um código). Inclui colagem interativa (bash -i). Não toca banco nem /opt/render.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-099.cjs'), {ETAPAS} = require('./migration-099-comum.cjs');
const root = path.resolve(__dirname, '..');
const lf = a => fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';

function destino({modulos = false} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-099-'));
  for (const a of b.arquivos('production')) { fs.mkdirSync(path.dirname(path.join(d, a)), {recursive: true}); fs.writeFileSync(path.join(d, a), lf(a)); }
  if (modulos) fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'), 'junction');
  return d;
}
function limpar(d) { try { fs.unlinkSync(path.join(d, 'node_modules')); } catch { /* sem junção */ } fs.rmSync(d, {recursive: true, force: true}); }
function sessao(d, conteudo, opcoes = {}) {
  const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : SERVICO;
  const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
  const env = {...process.env};
  for (const k of ['RENDER', 'DATABASE_URL', 'KIDMAIS_DEPLOY_ENV', 'KIDMAIS_REGISTRO_BACKUP']) delete env[k];
  if (servico === undefined) delete env.RENDER_SERVICE_ID; else env.RENDER_SERVICE_ID = servico;
  Object.assign(env, opcoes.env ?? {});
  const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env}) : spawnSync('bash', [f], {encoding: 'utf8', env});
  fs.rmSync(f, {force: true});
  return {status: r.status, saida: (r.stdout || '') + (r.stderr || '')};
}
const gerar = (d, modo, comando) => b.gerar({ambiente: 'production', modo, rotulo: '54598a9', destino: posix(d), comando});
const codigo = s => Number((/^CODIGO_SAIDA_BLOCO=(\d+)$/m.exec(s) || [])[1]);

test('arquivos conferidos: aplicador de produção, núcleo e os 4 SQL revisados; só produção', () => {
  assert.deepEqual(b.arquivos('production'), ['scripts/migration-099-production.cjs', 'scripts/migration-099-comum.cjs', ...ETAPAS.map(e => e[1])]);
  for (const [, a, h] of ETAPAS) assert.equal(sha(lf(a)), h, a);
  assert.deepEqual(Object.keys(b.AMBIENTES), ['production']); assert.equal(b.AMBIENTES.production.servico, SERVICO);
  assert.throws(() => b.gerar({ambiente: 'staging', modo: 'CONFERIR', rotulo: '54598a9'}), /AMBIENTE_DESCONHECIDO/);
  assert.throws(() => b.gerar({ambiente: 'production', modo: 'LIMPEZA', rotulo: '54598a9'}), /MODO_DESCONHECIDO/);
  assert.throws(() => b.gerar({ambiente: 'production', modo: 'CONFERIR', rotulo: 'abc; rm -rf /'}), /ROTULO_INVALIDO/);
});

test('blocos oficiais: ASCII, ≤ 32 KB, bind e guarda antes de tudo, corpo em subshell, comando por modo', () => {
  for (const [modo, flag] of [['CONFERIR', '--conferir-099'], ['APLICAR', '--aplicar-099-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"']]) {
    const x = b.gerar({ambiente: 'production', modo, rotulo: '54598a9'}), L = x.split('\n');
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/); assert.ok(Buffer.byteLength(x, 'utf8') <= 32 * 1024);
    const iGuarda = L.findIndex(l => l.startsWith(`if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]`));
    assert.ok(iGuarda > 0 && L.slice(0, iGuarda).every(l => l.startsWith('#') || l.startsWith('bind ')), 'nada antes da guarda');
    assert.equal(L[iGuarda - 1], "bind 'set enable-bracketed-paste off' 2>/dev/null"); assert.equal(L[iGuarda + 1], '(');
    assert.ok(L.includes(`NODE_PATH="$PWD/node_modules" node scripts/migration-099-production.cjs ${flag} || codigo=$?`), modo);
    for (const proibido of ['DATABASE_URL', 'postgres://', 'postgresql://', '_down.sql', 'migration-099-staging']) assert.ok(!x.includes(proibido), modo + ' ' + proibido);
    for (const a of b.arquivos('production')) assert.ok(L.includes(`arq ${a} ${sha(lf(a))}`), a);
  }
  assert.ok(!b.gerar({ambiente: 'production', modo: 'CONFERIR', rotulo: '54598a9'}).includes('KIDMAIS_REGISTRO_BACKUP'));
  assert.ok(b.gerar({ambiente: 'production', modo: 'APLICAR', rotulo: '54598a9'}).includes('ANTES do deploy do codigo'));
});

test('shell de outro serviço (ou sem RENDER_SERVICE_ID): nada do corpo executado', () => {
  for (const servico of ['srv-daif418ae00c73e8k2gg', undefined]) {
    const d = destino();
    try { const r = sessao(d, gerar(d, 'APLICAR', 'echo APLICADOR_RODOU'), {servico});
      assert.equal(r.status, 0); assert.match(r.saida, /^SHELL_ERRADO_NAO_E_PRODUCAO/m); assert.doesNotMatch(r.saida, /CODIGO_SAIDA_BLOCO|APLICADOR_RODOU|ARQUIVOS_CONFERIDOS/);
    } finally { limpar(d); }
  }
});

test('arquivo divergente ou ausente (inclusive o check vínculo/versão): código 4 antes do aplicador', () => {
  for (const alterar of ['scripts/migration-099-comum.cjs', ETAPAS[1][1], ETAPAS[2][1]]) for (const modo of ['remover', 'alterar']) {
    const d = destino();
    try { if (modo === 'remover') fs.rmSync(path.join(d, alterar)); else fs.appendFileSync(path.join(d, alterar), '\n-- alterado');
      const r = sessao(d, gerar(d, 'CONFERIR', 'echo APLICADOR_RODOU'));
      assert.equal(codigo(r.saida), 4, r.saida.slice(-300)); assert.ok(r.saida.includes('ARQUIVO_DIVERGENTE_OU_AUSENTE ' + alterar), alterar);
      assert.doesNotMatch(r.saida, /APLICADOR_RODOU/);
    } finally { limpar(d); }
  }
});

test('código do aplicador (0/1/2/3) vira CODIGO_SAIDA_BLOCO; aplicador REAL recusa fora do Render (código 1); APLICAR exige backup', () => {
  for (const esperado of [0, 1, 2, 3]) {
    const d = destino();
    try { assert.equal(codigo(sessao(d, gerar(d, 'CONFERIR', `node -e "process.exitCode=${esperado}"`)).saida), esperado); } finally { limpar(d); }
  }
  const d = destino({modulos: true});
  try {
    const r = sessao(d, gerar(d, 'CONFERIR'));
    assert.equal(codigo(r.saida), 1, r.saida.slice(-400)); assert.match(r.saida, /RECUSADO FORA_DO_RENDER/);
    const a = sessao(d, gerar(d, 'APLICAR'), {env: {KIDMAIS_REGISTRO_BACKUP: 'dump 2026-11-01T03:00Z'}});
    assert.equal(codigo(a.saida), 1, a.saida.slice(-400)); assert.match(a.saida, /RECUSADO FORA_DO_RENDER/);
    assert.equal(fs.existsSync(path.join(d, 'data')), false, 'nada gravado');
  } finally { limpar(d); }
  for (const env of [{}, {KIDMAIS_REGISTRO_BACKUP: 'x;rm -rf /'}, {KIDMAIS_REGISTRO_BACKUP: 'curto'}]) {
    const e = destino();
    try { const r = sessao(e, gerar(e, 'APLICAR', 'echo APLICADOR_RODOU'), {env});
      assert.equal(codigo(r.saida), 4); assert.match(r.saida, /^BACKUP_NAO_INFORMADO /m); assert.doesNotMatch(r.saida, /APLICADOR_RODOU/);
    } finally { limpar(e); }
  }
});

test('colagem interativa (bash -i): o shell do operador sobrevive e lê o código, sem herdar opções, umask, cwd ou variáveis', () => {
  const POS = ['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"', 'echo "VAR_HERDADA=${codigo-ausente}/${B-ausente}"', 'cat arquivo-que-nao-existe-no-teste', 'echo SHELL_DO_OPERADOR_VIVO'].join('\n') + '\n';
  for (const [modo, comando, env, esperado] of [['CONFERIR', 'node -e "process.exitCode=0"', {}, 0], ['APLICAR', 'node -e "process.exitCode=2"', {KIDMAIS_REGISTRO_BACKUP: 'dump 2026-11-01T03:00Z'}, 2],
    ['APLICAR', 'echo X', {}, 4]]) {
    const d = destino();
    try {
      const inicio = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n', {interativo: true, env}).saida;
      const r = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n' + gerar(d, modo, comando) + POS, {interativo: true, env});
      assert.equal(codigo(r.saida), esperado, modo + r.saida.slice(-300)); assert.match(r.saida, /^SHELL_DO_OPERADOR_VIVO$/m);
      const antes = /^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(inicio), pos = /^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
      assert.ok(antes && pos); assert.equal(pos[1], antes[1]); assert.equal(pos[2], antes[2]); assert.equal(pos[3].trim(), antes[3].trim());
      assert.match(r.saida, /^VAR_HERDADA=ausente\/ausente$/m);
    } finally { limpar(d); }
  }
});
