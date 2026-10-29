/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 100 (agenda com um salão, staging) executados DE VERDADE com bash num destino temporário (só o destino difere do
// Render; o comando do aplicador é o real — recusando antes de conectar, sem RENDER/DATABASE_URL — ou um substituto que só
// devolve um código). Inclui COLAGEM INTERATIVA (bash -i, bloco + linhas do operador), como no Web Shell: o shell do
// operador precisa sobreviver e ler o código. Não toca banco nem /opt/render.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-100.cjs'), {ETAPAS} = require('./migration-100-comum.cjs');
const root = path.resolve(__dirname, '..');
const lf = a => fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const SERVICO = 'srv-daif418ae00c73e8k2gg';

/** Destino com os arquivos implantados (LF) e, opcionalmente, node_modules do repositório (junção) para o aplicador real. */
function destino({modulos = false} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-100-'));
  for (const a of b.arquivos('staging')) { fs.mkdirSync(path.dirname(path.join(d, a)), {recursive: true}); fs.writeFileSync(path.join(d, a), lf(a)); }
  if (modulos) fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'), 'junction');
  return d;
}
function limpar(d) { try { fs.unlinkSync(path.join(d, 'node_modules')); } catch { /* sem junção */ } fs.rmSync(d, {recursive: true, force: true}); }
/** Executa um arquivo de sessão: `bash arquivo` ou, com interativo, `bash -i < arquivo` (colagem no terminal). */
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
const gerar = (d, modo, comando) => b.gerar({ambiente: 'staging', modo, rotulo: '455117e', destino: posix(d), comando});
const codigo = s => Number((/^CODIGO_SAIDA_BLOCO=(\d+)$/m.exec(s) || [])[1]);
const linhas = (s, re) => s.split(/\r?\n/).filter(l => re.test(l)).length;

test('arquivos conferidos: aplicador de staging, os dois núcleos (100 e 092–094), conexão de staging e os 4 SQL revisados da 100; só staging', () => {
  assert.deepEqual(b.arquivos('staging'), ['scripts/migration-100-staging.cjs', 'scripts/migration-100-comum.cjs', 'scripts/migration-092-094-comum.cjs',
    'scripts/migration-108-evidencias.cjs', 'scripts/migration-108-retrato.cjs', 'scripts/migration-107-definicoes.cjs', 'scripts/migration-108-inventario.cjs',
    'database/checks/20261029_108_retrato.sql', 'database/checks/20261029_108_retratos_esperados.json',
    'scripts/conexao-staging.cjs', ...ETAPAS.map(e => e[1]), 'database/checks/20261029_094_integridade_apos_108.sql']);
  assert.deepEqual(ETAPAS.map(e => e[0]), ['precheck 100', 'migration 100', 'postcheck 100', 'integridade 094 apos 100']);
  for (const [, a, h] of ETAPAS) assert.equal(sha(lf(a)), h, a);
  assert.equal(b.DESTINO, '/opt/render/project/src'); assert.equal(b.AMBIENTES.staging.servico, SERVICO);
  assert.deepEqual(Object.keys(b.AMBIENTES), ['staging'], 'produção fica fora deste aplicador');
  assert.throws(() => b.gerar({ambiente: 'production', modo: 'CONFERIR', rotulo: '455117e'}), /AMBIENTE_DESCONHECIDO/);
  assert.throws(() => b.gerar({ambiente: 'staging', modo: 'LIMPEZA', rotulo: '455117e'}), /MODO_DESCONHECIDO/);
  assert.throws(() => b.gerar({ambiente: 'staging', modo: 'CONFERIR', rotulo: 'abc; rm -rf /'}), /ROTULO_INVALIDO/);
});

test('blocos oficiais da 100: ASCII, ≤ 32 KB, bind e guarda antes de tudo, corpo em subshell, código impresso, comando por modo', () => {
  for (const modo of ['CONFERIR', 'APLICAR']) {
    const x = b.gerar({ambiente: 'staging', modo, rotulo: '455117e'});
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/); assert.ok(Buffer.byteLength(x, 'utf8') <= 32 * 1024, `${modo} ${Buffer.byteLength(x)}`);
    const L = x.split('\n'), iGuarda = L.findIndex(l => l.startsWith(`if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]`));
    assert.ok(iGuarda > 0 && L.slice(0, iGuarda).every(l => l.startsWith('#') || l.startsWith('bind ')), 'nada antes da guarda');
    assert.equal(L[iGuarda - 1], "bind 'set enable-bracketed-paste off' 2>/dev/null", 'bind antes da guarda');
    assert.equal(L[iGuarda + 1], '('); assert.ok(L.includes(')') && L.includes('echo "CODIGO_SAIDA_BLOCO=$?"') && L.at(-2) === 'fi');
    assert.match(x, /^cd '\/opt\/render\/project\/src' \|\| \{ echo "DESTINO_INACESSIVEL"; exit 4; \}$/m);
    assert.doesNotMatch(x, /DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\/|B64|base64|rollback|_down\.sql/);
    for (const a of b.arquivos('staging')) assert.ok(L.includes(`arq ${a} ${sha(lf(a))}`), a);
  }
  assert.match(b.gerar({ambiente: 'staging', modo: 'CONFERIR', rotulo: '455117e'}), /^NODE_PATH="\$PWD\/node_modules" node scripts\/migration-100-staging\.cjs --conferir-100 \|\| codigo=\$\?$/m);
  assert.match(b.gerar({ambiente: 'staging', modo: 'APLICAR', rotulo: '455117e'}),
    /^NODE_PATH="\$PWD\/node_modules" node scripts\/migration-100-staging\.cjs --aplicar-100-autorizado --backup "\$KIDMAIS_REGISTRO_BACKUP" \|\| codigo=\$\?$/m);
  assert.doesNotMatch(b.gerar({ambiente: 'staging', modo: 'CONFERIR', rotulo: '455117e'}), /KIDMAIS_REGISTRO_BACKUP/);
  for (const modo of ['CONFERIR', 'APLICAR']) {
    const x = b.gerar({ambiente: 'staging', modo, rotulo: '455117e'});
    assert.match(x, new RegExp('^# BLOCO-SHELL-100-STAGING-' + modo + ' ', 'm')); assert.doesNotMatch(x, /--conferir-092-094|--aplicar-092-094/);
  }
});

test('shell de outro serviço (ou sem RENDER_SERVICE_ID): nada do corpo executado, nenhum código impresso', () => {
  for (const servico of ['srv-dak77m2d0e5s73b8rkkg', undefined]) {
    const d = destino();
    try { const r = sessao(d, gerar(d, 'APLICAR', 'echo APLICADOR_RODOU'), {servico});
      assert.equal(r.status, 0); assert.match(r.saida, /^SHELL_ERRADO_NAO_E_STAGING/m);
      assert.doesNotMatch(r.saida, /CODIGO_SAIDA_BLOCO|APLICADOR_RODOU|ARQUIVOS_CONFERIDOS/);
    } finally { limpar(d); }
  }
});

test('arquivo implantado divergente ou ausente: código 4 antes de rodar o aplicador', () => {
  for (const alterar of ['scripts/conexao-staging.cjs', 'scripts/migration-100-comum.cjs', 'scripts/migration-092-094-comum.cjs', ETAPAS[1][1], ETAPAS[2][1], ETAPAS[3][1]]) {
    for (const modo of ['remover', 'alterar']) {
      const d = destino();
      try { if (modo === 'remover') fs.rmSync(path.join(d, alterar)); else fs.appendFileSync(path.join(d, alterar), '\n-- alterado');
        const r = sessao(d, gerar(d, 'CONFERIR', 'echo APLICADOR_RODOU'));
        assert.equal(codigo(r.saida), 4, r.saida.slice(-300)); assert.match(r.saida, new RegExp('^ARQUIVO_DIVERGENTE_OU_AUSENTE ' + alterar.replace(/\./g, '\\.') + '$', 'm'));
        assert.doesNotMatch(r.saida, /APLICADOR_RODOU|=== REGISTRO/);
      } finally { limpar(d); }
    }
  }
});

test('arquivos conferidos: o código do aplicador (0/1/2/3) vira CODIGO_SAIDA_BLOCO e o registro é listado', () => {
  for (const esperado of [0, 1, 2, 3]) {
    const d = destino();
    try { const r = sessao(d, gerar(d, 'CONFERIR', `node -e "process.exitCode=${esperado}"`));
      assert.equal(codigo(r.saida), esperado, r.saida.slice(-300)); assert.match(r.saida, /^ARQUIVOS_CONFERIDOS$/m); assert.equal(linhas(r.saida, /^=== REGISTRO /), 1);
    } finally { limpar(d); }
  }
});

test('aplicador REAL pelo bloco: sem RENDER/DATABASE_URL recusa antes de conectar (código 1), em CONFERIR e APLICAR', () => {
  const d = destino({modulos: true});
  try {
    const r = sessao(d, gerar(d, 'CONFERIR'));
    assert.equal(codigo(r.saida), 1, r.saida.slice(-400)); assert.match(r.saida, /RECUSADO FORA_DO_RENDER/);
    const a = sessao(d, gerar(d, 'APLICAR'), {env: {KIDMAIS_REGISTRO_BACKUP: 'export 23/10 03:00Z'}});
    assert.equal(codigo(a.saida), 1, a.saida.slice(-400)); assert.match(a.saida, /RECUSADO FORA_DO_RENDER/);
    assert.equal(fs.existsSync(path.join(d, 'data')), false, 'nada gravado');
  } finally { limpar(d); }
});

test('APLICAR sem KIDMAIS_REGISTRO_BACKUP (ou com valor inseguro): código 4 sem rodar o aplicador', () => {
  for (const env of [{}, {KIDMAIS_REGISTRO_BACKUP: ''}, {KIDMAIS_REGISTRO_BACKUP: 'x;rm -rf /'}, {KIDMAIS_REGISTRO_BACKUP: 'curto'}]) {
    const d = destino();
    try { const r = sessao(d, gerar(d, 'APLICAR', 'echo APLICADOR_RODOU'), {env});
      assert.equal(codigo(r.saida), 4, JSON.stringify(env) + r.saida.slice(-300)); assert.match(r.saida, /^BACKUP_NAO_INFORMADO /m); assert.doesNotMatch(r.saida, /APLICADOR_RODOU/);
    } finally { limpar(d); }
  }
  const d = destino();
  try { const r = sessao(d, gerar(d, 'APLICAR', 'echo "APLICADOR_RODOU backup=$KIDMAIS_REGISTRO_BACKUP"'), {env: {KIDMAIS_REGISTRO_BACKUP: 'export 23/10 03:00Z id-9'}});
    assert.equal(codigo(r.saida), 0); assert.match(r.saida, /^APLICADOR_RODOU backup=export 23\/10 03:00Z id-9$/m);
  } finally { limpar(d); }
});

test('destino inacessível: código 4 com DESTINO_INACESSIVEL (nunca 1, que é do aplicador)', () => {
  const d = destino();
  try { const r = sessao(d, b.gerar({ambiente: 'staging', modo: 'CONFERIR', rotulo: '455117e', destino: posix(path.join(d, 'nao-existe')), comando: 'echo X'}));
    assert.equal(codigo(r.saida), 4, r.saida); assert.match(r.saida, /^DESTINO_INACESSIVEL$/m);
  } finally { limpar(d); }
});

test('colagem interativa (bash -i): o shell do operador sobrevive, sem errexit/umask/cd/variáveis herdados; código legível 0/1/2/3/4', () => {
  const POS = ['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"', 'echo "VAR_HERDADA=${codigo-ausente}/${B-ausente}"', 'cat arquivo-que-nao-existe-no-teste', 'echo SHELL_DO_OPERADOR_VIVO'].join('\n') + '\n';
  for (const [rotulo, modo, comando, prep, env, esperado] of [
    ['sucesso', 'CONFERIR', 'node -e "process.exitCode=0"', null, {}, 0], ['recusa do aplicador', 'CONFERIR', 'node -e "process.exitCode=1"', null, {}, 1],
    ['falha', 'APLICAR', 'node -e "process.exitCode=2"', null, {KIDMAIS_REGISTRO_BACKUP: 'export 23/10 03:00Z'}, 2],
    ['recusaria', 'CONFERIR', 'node -e "process.exitCode=3"', null, {}, 3], ['recusa do bloco', 'CONFERIR', 'echo X', d => fs.rmSync(path.join(d, ETAPAS[1][1])), {}, 4],
    ['sem backup', 'APLICAR', 'echo X', null, {}, 4]]) {
    const d = destino();
    try { if (prep) prep(d);
      const inicio = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n', {interativo: true, env}).saida;
      const r = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n' + gerar(d, modo, comando) + POS, {interativo: true, env});
      assert.equal(codigo(r.saida), esperado, rotulo + ': ' + r.saida.slice(-400));
      assert.match(r.saida, /^SHELL_DO_OPERADOR_VIVO$/m, rotulo + ': o shell não pode cair no erro seguinte');
      const antes = /^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(inicio), pos = /^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
      assert.ok(antes && pos, rotulo); assert.equal(pos[1], antes[1], rotulo + ': opções'); assert.equal(pos[2], antes[2], rotulo + ': umask'); assert.equal(pos[3].trim(), antes[3].trim(), rotulo + ': diretório');
      assert.match(r.saida, /^VAR_HERDADA=ausente\/ausente$/m, rotulo + ': variáveis do corpo não vazam');
    } finally { limpar(d); }
  }
});

test('colagem interativa: CONFERIR e depois APLICAR na mesma sessão — dois códigos legíveis, shell vivo', () => {
  const d = destino();
  try { const r = sessao(d, gerar(d, 'CONFERIR', 'node -e "process.exitCode=0"') + 'export KIDMAIS_REGISTRO_BACKUP="export 23/10 03:00Z"\n'
      + gerar(d, 'APLICAR', 'node -e "process.exitCode=0"') + 'echo DUAS_COLAGENS_OK\n', {interativo: true});
    assert.equal(linhas(r.saida, /^CODIGO_SAIDA_BLOCO=0$/), 2, r.saida.slice(-400)); assert.match(r.saida, /^DUAS_COLAGENS_OK$/m);
  } finally { limpar(d); }
});
