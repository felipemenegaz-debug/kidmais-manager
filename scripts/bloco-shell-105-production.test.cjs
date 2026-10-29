/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 105 de PRODUÇÃO (plano MCP produção pré-requisitos, rev. 3, P1) executados DE VERDADE com bash num
// destino temporário (só o destino difere do Render; o comando do aplicador é o real — recusando antes de conectar, sem
// RENDER/DATABASE_URL — ou um substituto que só devolve um código). Inclui colagem interativa (bash -i). A colagem num
// PTY real (script.exe do MSYS2) fica no roteiro local da revisão, fora do CI. Não toca banco nem /opt/render.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-105.cjs'), {ETAPAS} = require('./migration-105-production-nucleo.cjs');
const root = path.resolve(__dirname, '..');
const lf = a => fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const PITR = () => `PITR ${new Date().toISOString().slice(0, 16)}Z painel Render`;

function destino({modulos = false} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-105-prod-'));
  for (const a of b.arquivos('production')) { fs.mkdirSync(path.dirname(path.join(d, a)), {recursive: true}); fs.writeFileSync(path.join(d, a), lf(a)); }
  if (modulos) fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'), 'junction');
  return d;
}
function limpar(d) { try { fs.unlinkSync(path.join(d, 'node_modules')); } catch { /* sem junção */ } fs.rmSync(d, {recursive: true, force: true}); }
function sessao(d, conteudo, opcoes = {}) {
  const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : SERVICO;
  const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
  const env = {...process.env};
  for (const k of ['RENDER', 'DATABASE_URL', 'KIDMAIS_DEPLOY_ENV', 'KIDMAIS_REGISTRO_BACKUP', 'DATABASE_SSL']) delete env[k];
  if (servico === undefined) delete env.RENDER_SERVICE_ID; else env.RENDER_SERVICE_ID = servico;
  Object.assign(env, opcoes.env ?? {});
  const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env}) : spawnSync('bash', [f], {encoding: 'utf8', env});
  fs.rmSync(f, {force: true});
  return {status: r.status, saida: (r.stdout || '') + (r.stderr || '')};
}
const gerar = (d, modo, comando) => b.gerar({ambiente: 'production', modo, rotulo: '18c976d4', destino: posix(d), comando});
const codigo = s => Number((/^CODIGO_SAIDA_BLOCO=(\d+)$/m.exec(s) || [])[1]);

test('arquivos de produção: aplicador, núcleo de produção, definições, núcleo de staging (leitura), 092–094 e os 5 SQL; sem conexao-staging', () => {
  assert.deepEqual(b.arquivos('production'), ['scripts/migration-105-production.cjs', 'scripts/migration-105-production-nucleo.cjs', 'scripts/migration-105-definicoes.cjs',
    'scripts/migration-105-comum.cjs', 'scripts/migration-092-094-comum.cjs', ...ETAPAS.map(e => e[1])]);
  assert.equal(ETAPAS.length, 5); for (const [, a, h] of ETAPAS) assert.equal(sha(lf(a)), h, a);
  assert.equal(b.AMBIENTES.production.servico, SERVICO); assert.equal(b.AMBIENTES.production.registro, 'data/mcp-105-producao');
  assert.ok(!b.arquivos('production').includes('scripts/conexao-staging.cjs'));
  assert.ok(!b.arquivos('staging').some(a => /production|definicoes/.test(a)), 'staging continua com os 4 SQL e o próprio núcleo');
});

test('blocos oficiais de produção: ASCII, ≤ 32 KB, bind e guarda antes de tudo, subshell, comando de produção, PITR no formato, código 5 explicado', () => {
  for (const modo of ['CONFERIR', 'APLICAR']) {
    const x = b.gerar({ambiente: 'production', modo, rotulo: '18c976d4'});
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/); assert.ok(Buffer.byteLength(x, 'utf8') <= 32 * 1024);
    const L = x.split('\n'), iGuarda = L.findIndex(l => l.startsWith(`if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]`));
    assert.ok(iGuarda > 0 && L.slice(0, iGuarda).every(l => l.startsWith('#') || l.startsWith('bind ')));
    assert.equal(L[iGuarda + 1], '('); assert.match(x, /SHELL_ERRADO_NAO_E_PRODUCTION/);
    assert.match(x, new RegExp(`^NODE_PATH="\\$PWD/node_modules" node scripts/migration-105-production\\.cjs ${b.COMANDOS[modo].replace(/[$"]/g, '\\$&')} \\|\\| codigo=\\$\\?$`, 'm'));
    assert.match(x, /\(0\/1\/2\/3\/5 aplicador, 4 bloco\)/);
    assert.match(x, /^for f in sha256sum cut node tr; do /m);
    if (modo === 'APLICAR') assert.ok(x.includes('&& [ "$(printf "%s" "$B" | tr -d "\\r\\n")" = "$B" ] ||'), 'linha única exigida');
    assert.doesNotMatch(x, /DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\/|base64|rollback|_down\.sql|migration-105-staging|conexao-staging/);
    for (const a of b.arquivos('production')) assert.ok(L.includes(`arq ${a} ${sha(lf(a))}`), a);
  }
  const aplicar = b.gerar({ambiente: 'production', modo: 'APLICAR', rotulo: '18c976d4'});
  assert.match(aplicar, /EM PRODUCAO/); assert.match(aplicar, /painel do Render que o PITR cobre este instante/); assert.match(aplicar, /Codigo 5/);
  assert.match(aplicar, /NAO liga o canal/);
  const conferir = b.gerar({ambiente: 'production', modo: 'CONFERIR', rotulo: '18c976d4'});
  assert.doesNotMatch(conferir, /KIDMAIS_REGISTRO_BACKUP/); assert.match(conferir, /DIVERGENTE \/ PARCIAL \/ FALHA_DE_CONFERENCIA \(3\)/);
});

test('shell de staging ou sem RENDER_SERVICE_ID: nada do corpo de produção executado', () => {
  for (const servico of ['srv-daif418ae00c73e8k2gg', undefined]) {
    const d = destino();
    try { const r = sessao(d, gerar(d, 'APLICAR', 'echo APLICADOR_RODOU'), {servico, env: {KIDMAIS_REGISTRO_BACKUP: PITR()}});
      assert.equal(r.status, 0); assert.match(r.saida, /^SHELL_ERRADO_NAO_E_PRODUCTION/m); assert.doesNotMatch(r.saida, /CODIGO_SAIDA_BLOCO|APLICADOR_RODOU/);
    } finally { limpar(d); }
  }
});

test('arquivo de produção divergente ou ausente (inclusive definições e núcleo de produção): código 4 sem rodar o aplicador', () => {
  for (const alterar of b.arquivos('production')) {
    const d = destino();
    try { fs.appendFileSync(path.join(d, alterar), '\n// alterado');
      const r = sessao(d, gerar(d, 'CONFERIR', 'echo APLICADOR_RODOU'));
      assert.equal(codigo(r.saida), 4, alterar); assert.match(r.saida, new RegExp('^ARQUIVO_DIVERGENTE_OU_AUSENTE ' + alterar.replace(/\./g, '\\.') + '$', 'm'));
      assert.doesNotMatch(r.saida, /APLICADOR_RODOU/);
    } finally { limpar(d); }
  }
});

test('códigos do aplicador 0/1/2/3/5 viram CODIGO_SAIDA_BLOCO; o registro de produção é listado', () => {
  for (const esperado of [0, 1, 2, 3, 5]) {
    const d = destino();
    try { const r = sessao(d, gerar(d, 'APLICAR', `node -e "process.exitCode=${esperado}"`), {env: {KIDMAIS_REGISTRO_BACKUP: PITR()}});
      assert.equal(codigo(r.saida), esperado, r.saida.slice(-300)); assert.match(r.saida, /^=== REGISTRO \(data\/mcp-105-producao\) ===$/m);
    } finally { limpar(d); }
  }
});

test('APLICAR de produção exige o PITR no formato: export, texto livre, vazio ou inseguro = código 4 sem rodar o aplicador', () => {
  for (const valor of [undefined, '', 'export 27/10 03:00Z id-9', 'PITR staging 27/10 21:00Z', 'PITR 2026-11-02 03:10 ref', 'PITR 2026-11-02T03:10Z x;rm -rf /',
    // Revisão do Astra (rodada 1, P3): uma linha válida dentro de um valor multilinha não passa; CR/LF = 4.
    'PITR 2026-11-02T03:10Z painel Render\nlixo', 'lixo\nPITR 2026-11-02T03:10Z painel Render', 'PITR 2026-11-02T03:10Z painel Render\n',
    'PITR 2026-11-02T03:10Z painel Render\r']) {
    const d = destino();
    try { const r = sessao(d, gerar(d, 'APLICAR', 'echo APLICADOR_RODOU'), {env: valor === undefined ? {} : {KIDMAIS_REGISTRO_BACKUP: valor}});
      assert.equal(codigo(r.saida), 4, String(valor)); assert.match(r.saida, /^BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP no formato PITR /m);
      assert.doesNotMatch(r.saida, /APLICADOR_RODOU/);
    } finally { limpar(d); }
  }
  const d = destino();
  try { const r = sessao(d, gerar(d, 'APLICAR', 'echo "APLICADOR_RODOU backup=$KIDMAIS_REGISTRO_BACKUP"'), {env: {KIDMAIS_REGISTRO_BACKUP: 'PITR 2026-11-02T03:10Z painel Render'}});
    assert.equal(codigo(r.saida), 0); assert.match(r.saida, /^APLICADOR_RODOU backup=PITR 2026-11-02T03:10Z painel Render$/m);
  } finally { limpar(d); }
});

test('aplicador REAL de produção pelo bloco: sem RENDER recusa antes de conectar (1); PITR antigo recusado pelo aplicador (1); nada gravado', () => {
  const d = destino({modulos: true});
  try {
    const r = sessao(d, gerar(d, 'CONFERIR'));
    assert.equal(codigo(r.saida), 1, r.saida.slice(-400)); assert.match(r.saida, /RECUSADO FORA_DO_RENDER/);
    const a = sessao(d, gerar(d, 'APLICAR'), {env: {KIDMAIS_REGISTRO_BACKUP: PITR()}});
    assert.equal(codigo(a.saida), 1, a.saida.slice(-400)); assert.match(a.saida, /RECUSADO FORA_DO_RENDER/);
    const velho = sessao(d, gerar(d, 'APLICAR'), {env: {KIDMAIS_REGISTRO_BACKUP: 'PITR 2026-01-01T00:00Z painel Render'}});
    assert.equal(codigo(velho.saida), 1); assert.match(velho.saida, /RECUSADO PITR_CONFERENCIA_ANTIGA/);
    assert.equal(fs.existsSync(path.join(d, 'data')), false, 'nada gravado');
  } finally { limpar(d); }
});

test('colagem interativa (bash -i): shell do operador vivo e intacto nos códigos 0/1/2/3/4/5', () => {
  const POS = ['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"', 'echo "VAR_HERDADA=${codigo-ausente}/${B-ausente}"', 'cat arquivo-que-nao-existe-no-teste', 'echo SHELL_DO_OPERADOR_VIVO'].join('\n') + '\n';
  for (const [rotulo, modo, comando, env, esperado] of [['sucesso', 'CONFERIR', 'node -e "process.exitCode=0"', {}, 0], ['recusa', 'CONFERIR', 'node -e "process.exitCode=1"', {}, 1],
    ['falha', 'APLICAR', 'node -e "process.exitCode=2"', {KIDMAIS_REGISTRO_BACKUP: PITR()}, 2], ['divergente', 'CONFERIR', 'node -e "process.exitCode=3"', {}, 3],
    ['sem PITR', 'APLICAR', 'echo X', {}, 4], ['marcador desatualizado', 'APLICAR', 'node -e "process.exitCode=5"', {KIDMAIS_REGISTRO_BACKUP: PITR()}, 5]]) {
    const d = destino();
    try {
      const inicio = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n', {interativo: true, env}).saida;
      const r = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n' + gerar(d, modo, comando) + POS, {interativo: true, env});
      assert.equal(codigo(r.saida), esperado, rotulo + ': ' + r.saida.slice(-400)); assert.match(r.saida, /^SHELL_DO_OPERADOR_VIVO$/m, rotulo);
      const antes = /^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(inicio), pos = /^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
      assert.ok(antes && pos, rotulo); assert.equal(pos[1], antes[1], rotulo); assert.equal(pos[2], antes[2], rotulo); assert.equal(pos[3].trim(), antes[3].trim(), rotulo);
      assert.match(r.saida, /^VAR_HERDADA=ausente\/ausente$/m, rotulo);
    } finally { limpar(d); }
  }
});
