/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 107/108 (reparo da agenda + salões combinados) de PRODUÇÃO executados DE VERDADE com bash num destino temporário (só o destino difere do
// Render; o comando do aplicador é o real — recusando antes de conectar, sem RENDER/DATABASE_URL — ou um substituto que só
// devolve um código). Inclui COLAGEM INTERATIVA (bash -i), como no Web Shell. Não toca banco nem /opt/render.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-107-108-production.cjs'), {ARQUIVOS, RECUPERACAO} = require('./migration-107-108-comum.cjs');
const ETAPAS = [...ARQUIVOS, ...RECUPERACAO];
const MODULOS = ['scripts/migration-107-108-production.cjs', 'scripts/migration-107-108-comum.cjs', 'scripts/migration-107-definicoes.cjs', 'scripts/migration-108-retrato.cjs',
  'scripts/migration-108-inventario.cjs'];
const root = path.resolve(__dirname, '..');
const lf = a => fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const PROD = 'srv-dak77m2d0e5s73b8rkkg', STG = 'srv-daif418ae00c73e8k2gg';
const ROTULO = '3ff1016';
const PITR = 'PITR 2026-11-12T03:00Z production';
const DRENAGEM = 'web manutencao 03:05Z cron suspenso';
const AMBOS = {KIDMAIS_REGISTRO_BACKUP: PITR, KIDMAIS_REGISTRO_DRENAGEM: DRENAGEM};

/** Destino com os arquivos implantados (LF) e, opcionalmente, node_modules do repositório (junção) para o aplicador real. */
function destino({modulos = false} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bloco-107-108-prod-'));
  for (const a of b.arquivos()) { fs.mkdirSync(path.dirname(path.join(d, a)), {recursive: true}); fs.writeFileSync(path.join(d, a), lf(a)); }
  if (modulos) fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'), 'junction');
  return d;
}
function limpar(d) { try { fs.unlinkSync(path.join(d, 'node_modules')); } catch { /* sem junção */ } fs.rmSync(d, {recursive: true, force: true}); }
/** Executa um arquivo de sessão: `bash arquivo` ou, com interativo, `bash -i < arquivo` (colagem no terminal). */
function sessao(d, conteudo, opcoes = {}) {
  const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : PROD;
  const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
  const env = {...process.env};
  for (const k of ['RENDER', 'DATABASE_URL', 'KIDMAIS_DEPLOY_ENV', 'KIDMAIS_REGISTRO_BACKUP', 'KIDMAIS_REGISTRO_DRENAGEM', 'KIDMAIS_RETRATOS_108_TESTE']) delete env[k];
  if (servico === undefined) delete env.RENDER_SERVICE_ID; else env.RENDER_SERVICE_ID = servico;
  Object.assign(env, opcoes.env ?? {});
  const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env}) : spawnSync('bash', [f], {encoding: 'utf8', env});
  fs.rmSync(f, {force: true});
  return {status: r.status, saida: (r.stdout || '') + (r.stderr || '')};
}
const gerar = (d, modo, comando) => b.gerar({modo, rotulo: ROTULO, destino: posix(d), comando});
const codigo = s => Number((/^CODIGO_SAIDA_BLOCO=(\d+)$/m.exec(s) || [])[1]);
const linhas = (s, re) => s.split(/\r?\n/).filter(l => re.test(l)).length;

test('produção: arquivos conferidos (aplicador de produção, núcleos, definições, retrato, inventário, checks, esperados, migrations e downs; sem conexão nem aplicador de staging)', () => {
  assert.deepEqual(b.arquivos(), [...MODULOS, ...ARQUIVOS.map(e => e[1]), ...RECUPERACAO.map(e => e[1])]);
  assert.ok(b.arquivos().some(a => a.endsWith('_down.sql')) && b.arquivos().includes('database/checks/20261029_108_retratos_esperados.json'));
  // Cada módulo exigido pelo aplicador de produção está na lista (nenhum require local fora dela).
  for (const m of MODULOS) {
    for (const [, dep] of lf(m).matchAll(/require\('\.\/([^']+)'\)/g)) assert.ok(MODULOS.includes('scripts/' + dep), `${m} → ${dep}`);
  }
  assert.ok(!b.arquivos().some(a => /staging/.test(a)));
  for (const [, a, h] of ETAPAS) assert.equal(sha(lf(a)), h, a);
  assert.equal(b.DESTINO, '/opt/render/project/src'); assert.equal(b.SERVICO, PROD); assert.equal(b.REGISTRO, 'data/saloes-107-108-producao');
  assert.throws(() => b.gerar({modo: 'LIMPEZA', rotulo: ROTULO}), /MODO_DESCONHECIDO/);
  assert.throws(() => b.gerar({modo: 'CONFERIR', rotulo: 'abc; rm -rf /'}), /ROTULO_INVALIDO/);
  assert.throws(() => b.gerar({modo: 'CONFERIR', rotulo: ROTULO, destino: '/x; rm'}), /DESTINO_INVALIDO/);
});

test('blocos oficiais de produção: ASCII, ≤ 32 KB, bind e guarda antes de tudo, corpo em subshell, código impresso, comando por modo, aviso e PITR', () => {
  for (const [modo, flag] of [['CONFERIR', '--conferir-107-108'], ['APLICAR', '--aplicar-107-108-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP" --drenagem "$KIDMAIS_REGISTRO_DRENAGEM"']]) {
    const x = b.gerar({modo, rotulo: ROTULO}), L = x.split('\n');
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/); assert.ok(Buffer.byteLength(x, 'utf8') <= 32 * 1024, `${modo} ${Buffer.byteLength(x)}`);
    const iGuarda = L.findIndex(l => l.startsWith(`if [ "$RENDER_SERVICE_ID" != "${PROD}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCTION`));
    assert.ok(iGuarda > 0 && L.slice(0, iGuarda).every(l => l.startsWith('#') || l.startsWith('bind ')), modo + ': nada antes da guarda');
    assert.equal(L[iGuarda - 1], "bind 'set enable-bracketed-paste off' 2>/dev/null", 'bind antes da guarda');
    assert.equal(L[iGuarda + 1], '('); assert.ok(L.includes(')') && L.includes('echo "CODIGO_SAIDA_BLOCO=$?"') && L.at(-2) === 'fi');
    assert.match(x, /^cd '\/opt\/render\/project\/src' \|\| \{ echo "DESTINO_INACESSIVEL"; exit 4; \}$/m);
    assert.ok(L.includes(`NODE_PATH="$PWD/node_modules" node scripts/migration-107-108-production.cjs ${flag} || codigo=$?`), modo);
    assert.match(x, new RegExp('^# BLOCO-SHELL-107-108-PRODUCTION-' + modo + ' ', 'm')); assert.match(x, /^# Runbook: rodar com o web drenado /m); assert.ok(L.includes('set -euo pipefail') && L.includes('umask 077'));
    assert.ok(L.includes('ls -1 data/saloes-107-108-producao 2>/dev/null || echo SEM_REGISTRO'), modo);
    assert.doesNotMatch(x, /DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\/|B64|base64|staging|srv-daif418ae00c73e8k2gg|--conferir-100\b|--aplicar-100-|KIDMAIS_RETRATOS_108_TESTE/);
    assert.doesNotMatch(x.split('\n').filter(l => !l.startsWith('arq ')).join('\n'), /_down\.sql|psql/, 'os downs só entram na conferência de hash');
    for (const a of b.arquivos()) assert.ok(L.includes(`arq ${a} ${sha(lf(a))}`), a);
  }
  assert.doesNotMatch(b.gerar({modo: 'CONFERIR', rotulo: ROTULO}), /KIDMAIS_REGISTRO_BACKUP|KIDMAIS_REGISTRO_DRENAGEM/);
  assert.match(b.gerar({modo: 'CONFERIR', rotulo: ROTULO}), /RETRATO_F<n>_DIVERGENTE \(3\) = o retrato de/);
  const aplicar = b.gerar({modo: 'APLICAR', rotulo: ROTULO});
  assert.match(aplicar, /ponto PITR de production comprovado/); assert.match(aplicar, /export logico NAO/); assert.doesNotMatch(aplicar, /export\/PITR/);
  assert.ok(aplicar.includes('echo "BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP (ponto PITR de production) numa linha antes de colar"'));
  assert.ok(aplicar.includes('echo "DRENAGEM_NAO_INFORMADA defina KIDMAIS_REGISTRO_DRENAGEM numa linha antes de colar (web drenado e cron suspenso)"'));
  assert.match(aplicar, /down da 108 ANTES do da 107/);
});

test('shell de staging, de outro serviço ou sem RENDER_SERVICE_ID: nada do corpo executado, nenhum código impresso', () => {
  for (const servico of [STG, 'srv-outro', undefined]) {
    const d = destino();
    try { const r = sessao(d, gerar(d, 'APLICAR', 'echo APLICADOR_RODOU'), {servico, env: AMBOS});
      assert.equal(r.status, 0); assert.match(r.saida, /^SHELL_ERRADO_NAO_E_PRODUCTION/m);
      assert.doesNotMatch(r.saida, /CODIGO_SAIDA_BLOCO|APLICADOR_RODOU|ARQUIVOS_CONFERIDOS/);
    } finally { limpar(d); }
  }
});

test('arquivo implantado divergente ou ausente: código 4 antes de rodar o aplicador', () => {
  for (const alterar of ['scripts/migration-107-108-production.cjs', 'scripts/migration-107-108-comum.cjs', 'scripts/migration-108-retrato.cjs', ARQUIVOS[1][1], ARQUIVOS[5][1], ARQUIVOS[8][1], RECUPERACAO[0][1]]) {
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

test('aplicador REAL de produção pelo bloco: sem RENDER/DATABASE_URL recusa antes de conectar (código 1), em CONFERIR e APLICAR; nada gravado', () => {
  const d = destino({modulos: true});
  try {
    const r = sessao(d, gerar(d, 'CONFERIR'));
    assert.equal(codigo(r.saida), 1, r.saida.slice(-400)); assert.match(r.saida, /RECUSADO FORA_DO_RENDER/);
    const a = sessao(d, gerar(d, 'APLICAR'), {env: AMBOS});
    assert.equal(codigo(a.saida), 1, a.saida.slice(-400)); assert.match(a.saida, /RECUSADO FORA_DO_RENDER/);
    // No Render, mas com as variáveis do serviço de staging: o adaptador de produção recusa pelo ambiente.
    const s = sessao(d, gerar(d, 'CONFERIR'), {env: {RENDER: 'true', KIDMAIS_DEPLOY_ENV: 'staging'}});
    assert.equal(codigo(s.saida), 1, s.saida.slice(-400)); assert.match(s.saida, /RECUSADO AMBIENTE_RECUSADO/);
    assert.equal(fs.existsSync(path.join(d, 'data')), false, 'nada gravado');
  } finally { limpar(d); }
});

test('APLICAR sem KIDMAIS_REGISTRO_BACKUP ou sem KIDMAIS_REGISTRO_DRENAGEM (vazio, inseguro, curto ou em duas linhas): código 4 sem rodar o aplicador', () => {
  for (const [env, recusa] of [[{}, /^BACKUP_NAO_INFORMADO /m], [{KIDMAIS_REGISTRO_BACKUP: '', KIDMAIS_REGISTRO_DRENAGEM: DRENAGEM}, /^BACKUP_NAO_INFORMADO /m],
    [{KIDMAIS_REGISTRO_BACKUP: 'x;rm -rf /', KIDMAIS_REGISTRO_DRENAGEM: DRENAGEM}, /^BACKUP_NAO_INFORMADO /m], [{KIDMAIS_REGISTRO_BACKUP: 'curto', KIDMAIS_REGISTRO_DRENAGEM: DRENAGEM}, /^BACKUP_NAO_INFORMADO /m],
    [{KIDMAIS_REGISTRO_BACKUP: PITR + '\nsegunda linha valida', KIDMAIS_REGISTRO_DRENAGEM: DRENAGEM}, /^BACKUP_NAO_INFORMADO /m],
    [{KIDMAIS_REGISTRO_BACKUP: PITR}, /^DRENAGEM_NAO_INFORMADA /m], [{KIDMAIS_REGISTRO_BACKUP: PITR, KIDMAIS_REGISTRO_DRENAGEM: 'x;rm -rf /'}, /^DRENAGEM_NAO_INFORMADA /m],
    [{KIDMAIS_REGISTRO_BACKUP: PITR, KIDMAIS_REGISTRO_DRENAGEM: DRENAGEM + '\nsegunda linha valida'}, /^DRENAGEM_NAO_INFORMADA /m]]) {
    const d = destino();
    try { const r = sessao(d, gerar(d, 'APLICAR', 'echo APLICADOR_RODOU'), {env});
      assert.equal(codigo(r.saida), 4, JSON.stringify(env) + r.saida.slice(-300)); assert.match(r.saida, recusa); assert.doesNotMatch(r.saida, /APLICADOR_RODOU/);
    } finally { limpar(d); }
  }
  const d = destino();
  try { const r = sessao(d, gerar(d, 'APLICAR', 'echo "APLICADOR_RODOU backup=$KIDMAIS_REGISTRO_BACKUP drenagem=$KIDMAIS_REGISTRO_DRENAGEM"'), {env: AMBOS});
    assert.equal(codigo(r.saida), 0); assert.match(r.saida, /^APLICADOR_RODOU backup=PITR 2026-11-12T03:00Z production drenagem=web manutencao 03:05Z cron suspenso$/m);
  } finally { limpar(d); }
});

test('destino inacessível: código 4 com DESTINO_INACESSIVEL (nunca 1, que é do aplicador)', () => {
  const d = destino();
  try { const r = sessao(d, b.gerar({modo: 'CONFERIR', rotulo: ROTULO, destino: posix(path.join(d, 'nao-existe')), comando: 'echo X'}));
    assert.equal(codigo(r.saida), 4, r.saida); assert.match(r.saida, /^DESTINO_INACESSIVEL$/m);
  } finally { limpar(d); }
});

test('colagem interativa (bash -i): o shell do operador sobrevive, sem errexit/umask/cd/variáveis herdados; código legível 0/1/2/3/4', () => {
  const POS = ['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"', 'echo "VAR_HERDADA=${codigo-ausente}/${B-ausente}/${D-ausente}"', 'cat arquivo-que-nao-existe-no-teste', 'echo SHELL_DO_OPERADOR_VIVO'].join('\n') + '\n';
  for (const [rotulo, modo, comando, prep, env, esperado] of [
    ['sucesso', 'CONFERIR', 'node -e "process.exitCode=0"', null, {}, 0], ['recusa do aplicador', 'CONFERIR', 'node -e "process.exitCode=1"', null, {}, 1],
    ['falha', 'APLICAR', 'node -e "process.exitCode=2"', null, AMBOS, 2], ['sem drenagem', 'APLICAR', 'echo X', null, {KIDMAIS_REGISTRO_BACKUP: PITR}, 4],
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
      assert.match(r.saida, /^VAR_HERDADA=ausente\/ausente\/ausente$/m, rotulo + ': variáveis do corpo não vazam');
    } finally { limpar(d); }
  }
});

test('colagem interativa: CONFERIR e depois APLICAR na mesma sessão — dois códigos legíveis, shell vivo', () => {
  const d = destino();
  try { const r = sessao(d, gerar(d, 'CONFERIR', 'node -e "process.exitCode=0"') + `export KIDMAIS_REGISTRO_BACKUP="${PITR}"\nexport KIDMAIS_REGISTRO_DRENAGEM="${DRENAGEM}"\n`
      + gerar(d, 'APLICAR', 'node -e "process.exitCode=0"') + 'echo DUAS_COLAGENS_OK\n', {interativo: true});
    assert.equal(linhas(r.saida, /^CODIGO_SAIDA_BLOCO=0$/), 2, r.saida.slice(-400)); assert.match(r.saida, /^DUAS_COLAGENS_OK$/m);
  } finally { limpar(d); }
});
