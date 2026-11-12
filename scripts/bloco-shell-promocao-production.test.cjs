/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell de PRODUÇÃO da promoção (112, 114, 116, 117 e, pelo aplicador genérico, 120, 121, 110, 111 e 115)
// executados DE VERDADE com bash num destino temporário (só o destino difere do Render; o comando do aplicador é o real —
// recusando antes de conectar, sem RENDER/DATABASE_URL — ou um substituto que só devolve um código). Inclui COLAGEM
// INTERATIVA (bash -i), como no Web Shell. Não toca banco nem /opt/render. Mesmo roteiro de scripts/bloco-shell-112.test.cjs.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-promocao-production.cjs'), generico = require('./migration-generico-production.cjs');
const root = path.resolve(__dirname, '..');
const lf = a => fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const PROPRIOS = ['114', '112', '116', '117'], GENERICOS = ['120', '121', '110', '111', '115'];
const BACKUP = 'dump 2026-11-12T03:00Z sha 1234abcd PITR';

/** Destino com os arquivos implantados (LF) e, opcionalmente, node_modules do repositório (junção) para o aplicador real. */
function destino(id, {modulos = false} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bloco-prod-${id}-`));
  for (const a of b.arquivos(id)) { fs.mkdirSync(path.dirname(path.join(d, a)), {recursive: true}); fs.writeFileSync(path.join(d, a), lf(a)); }
  if (modulos) fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'), 'junction');
  return d;
}
function limpar(d) { try { fs.unlinkSync(path.join(d, 'node_modules')); } catch { /* sem junção */ } fs.rmSync(d, {recursive: true, force: true}); }
/** Executa um arquivo de sessão: `bash arquivo` ou, com interativo, `bash -i < arquivo` (colagem no terminal). */
function sessao(d, conteudo, opcoes = {}) {
  const interativo = opcoes.interativo === true, servico = Object.hasOwn(opcoes, 'servico') ? opcoes.servico : SERVICO;
  const f = d + '-sessao.sh'; fs.writeFileSync(f, conteudo);
  const env = {...process.env};
  for (const k of ['RENDER', 'DATABASE_URL', 'KIDMAIS_DEPLOY_ENV', 'KIDMAIS_REGISTRO_BACKUP', 'WHATSAPP_ATENDIMENTO_MULTIEMPRESA']) delete env[k];
  if (servico === undefined) delete env.RENDER_SERVICE_ID; else env.RENDER_SERVICE_ID = servico;
  Object.assign(env, opcoes.env ?? {});
  const r = interativo ? spawnSync('bash', ['--norc', '--noprofile', '-i'], {input: fs.readFileSync(f), encoding: 'utf8', env}) : spawnSync('bash', [f], {encoding: 'utf8', env});
  fs.rmSync(f, {force: true});
  return {status: r.status, saida: (r.stdout || '') + (r.stderr || '')};
}
const gerar = (id, d, modo, comando) => b.gerar({id, modo, rotulo: '0123abcd', destino: posix(d), comando});
const codigo = s => Number((/^CODIGO_SAIDA_BLOCO=(\d+)$/m.exec(s) || [])[1]);
const linhas = (s, re) => s.split(/\r?\n/).filter(l => re.test(l)).length;

test('passos cobertos e arquivos conferidos: adaptador de produção + núcleo + conexão de produção + SQL revisados; o genérico com os 3 SQL do id', () => {
  assert.deepEqual([...b.IDS], [...PROPRIOS, ...GENERICOS]); assert.deepEqual(Object.keys(b.PASSOS).sort(), [...b.IDS].sort());
  assert.equal(b.DESTINO, '/opt/render/project/src'); assert.equal(b.SERVICO, SERVICO);
  for (const id of PROPRIOS) {
    const {ETAPAS} = require(`./migration-${id}-comum.cjs`);
    assert.deepEqual(b.arquivos(id), [`scripts/migration-${id}-production.cjs`, `scripts/migration-${id}-comum.cjs`, 'scripts/migration-092-094-comum.cjs', 'scripts/conexao-production.cjs',
      ...(id === '114' ? ['lib/agenda/trava-configuracao.ts'] : []), ...ETAPAS.map(e => e[1])]);
    for (const [, a, h] of ETAPAS) assert.equal(sha(lf(a)), h, a);
    // O registro listado pelo bloco é o diretório do marcador do adaptador (disco persistente do web de produção).
    assert.equal(path.posix.join(b.DESTINO, b.PASSOS[id].registro), require(`./migration-${id}-production.cjs`).DIR);
  }
  for (const id of GENERICOS) {
    assert.deepEqual(b.arquivos(id), ['scripts/migration-generico-production.cjs', 'scripts/migration-092-094-comum.cjs', 'scripts/migration-118-comum.cjs', 'scripts/conexao-production.cjs',
      ...generico.MIGRATIONS[id].arquivos.map(a => a[1])]);
    assert.equal(path.posix.join(b.DESTINO, b.PASSOS[id].registro), generico.DIR);
  }
  // Tudo o que o aplicador carrega com require está na lista conferida (nenhum arquivo implantado fica sem sha256).
  for (const id of b.IDS) {
    const lista = b.arquivos(id);
    for (const a of lista.filter(x => x.endsWith('.cjs')))
      for (const m of lf(a).matchAll(/^const .* = require\('\.\/([^']+)'\);$/gm)) assert.ok(lista.includes('scripts/' + m[1]), `${id}: ${a} carrega ${m[1]}, fora da lista`);
    assert.ok(!lista.some(a => /staging|rollback|_down/.test(a)), id);
  }
  assert.throws(() => b.gerar({id: '118', modo: 'CONFERIR', rotulo: '0123abcd'}), /PASSO_DESCONHECIDO/);
  assert.throws(() => b.gerar({id: '098', modo: 'CONFERIR', rotulo: '0123abcd'}), /PASSO_DESCONHECIDO/);
  assert.throws(() => b.gerar({id: '112', modo: 'LIMPEZA', rotulo: '0123abcd'}), /MODO_DESCONHECIDO/);
  assert.throws(() => b.gerar({id: '112', modo: 'CONFERIR', rotulo: 'abc; rm -rf /'}), /ROTULO_INVALIDO/);
});

test('blocos oficiais: ASCII, ≤ 32 KB, bind e guarda de PRODUÇÃO antes de tudo, corpo em subshell, código impresso, comando por modo', () => {
  for (const id of b.IDS) {
    const p = b.PASSOS[id];
    for (const modo of ['CONFERIR', 'APLICAR']) {
      const x = b.gerar({id, modo, rotulo: '0123abcd'});
      assert.match(x, /^[\x09\x0a\x20-\x7e]*$/); assert.ok(Buffer.byteLength(x, 'utf8') <= 32 * 1024, `${id} ${modo} ${Buffer.byteLength(x)}`);
      const L = x.split('\n'), iGuarda = L.findIndex(l => l.startsWith(`if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]`));
      assert.ok(iGuarda > 0 && L.slice(0, iGuarda).every(l => l.startsWith('#') || l.startsWith('bind ')), 'nada antes da guarda');
      assert.equal(L[iGuarda - 1], "bind 'set enable-bracketed-paste off' 2>/dev/null", 'bind antes da guarda');
      assert.equal(L[iGuarda + 1], '('); assert.ok(L.includes(')') && L.includes('echo "CODIGO_SAIDA_BLOCO=$?"') && L.at(-2) === 'fi');
      assert.match(x, /^cd '\/opt\/render\/project\/src' \|\| \{ echo "DESTINO_INACESSIVEL"; exit 4; \}$/m);
      assert.doesNotMatch(x, /DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\/|B64|base64|_down\.sql|srv-daif418ae00c73e8k2gg|-staging\.cjs/);
      for (const a of b.arquivos(id)) assert.ok(L.includes(`arq ${a} ${sha(lf(a))}`), a);
      assert.match(x, new RegExp(`^# BLOCO-SHELL-${id}-PRODUCTION-${modo} `, 'm'));
      assert.equal(linhas(x, /^NODE_PATH=/), 1, 'um único comando de aplicador');
      assert.match(x, new RegExp(`^ls -1 ${p.registro.replace(/[/-]/g, '\\$&')} 2>/dev/null \\|\\| echo SEM_REGISTRO$`, 'm'));
    }
    const conferir = b.gerar({id, modo: 'CONFERIR', rotulo: '0123abcd'}), aplicar = b.gerar({id, modo: 'APLICAR', rotulo: '0123abcd'});
    const cmd = l => l.split('\n').find(x => x.startsWith('NODE_PATH='));
    if (PROPRIOS.includes(id)) {
      assert.equal(cmd(conferir), `NODE_PATH="$PWD/node_modules" node scripts/migration-${id}-production.cjs --conferir-${id} || codigo=$?`);
      assert.equal(cmd(aplicar), `NODE_PATH="$PWD/node_modules" node scripts/migration-${id}-production.cjs --aplicar-${id}-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP" || codigo=$?`);
    } else {
      assert.equal(cmd(conferir), `NODE_PATH="$PWD/node_modules" node scripts/migration-generico-production.cjs --conferir ${id} || codigo=$?`);
      assert.equal(cmd(aplicar), `NODE_PATH="$PWD/node_modules" node scripts/migration-generico-production.cjs --aplicar-autorizado ${id} --backup "$KIDMAIS_REGISTRO_BACKUP" || codigo=$?`);
    }
    assert.doesNotMatch(conferir, /KIDMAIS_REGISTRO_BACKUP/); assert.match(conferir, /SOMENTE LEITURA/);
    assert.match(aplicar, /ESCRITA \(DDL\) EM PRODUCAO/); assert.match(aplicar, new RegExp(`autorizacao especifica de Felipe para a ${id} em producao`));
    assert.match(aplicar, /dump conferido e do PITR/); assert.match(aplicar, /NAO repetir nem seguir para o proximo passo/);
  }
  assert.match(b.gerar({id: '117', modo: 'APLICAR', rotulo: '0123abcd'}), /WHATSAPP_ATENDIMENTO_MULTIEMPRESA ligada ou invalida o aplicador RECUSA/);
  assert.match(b.gerar({id: '114', modo: 'CONFERIR', rotulo: '0123abcd'}), /nao tem checks externos/);
});

test('o gerador recusa árvore cujo SQL diverge do hash revisado (núcleo ou lista fechada do genérico)', () => {
  for (const id of ['114', '117', '120', '115']) {
    for (const a of b.PASSOS[id].revisados.map(r => r[0])) {
      const d = destino(id);
      try { fs.appendFileSync(path.join(d, a), '\n-- x'); assert.throws(() => b.gerar({id, modo: 'CONFERIR', rotulo: '0123abcd', raiz: d}), /ARQUIVO_DIVERGENTE_DO_REVISADO/); }
      finally { limpar(d); }
    }
  }
});

test('shell de outro serviço (staging ou sem RENDER_SERVICE_ID): nada do corpo executado, nenhum código impresso', () => {
  for (const id of ['117', '120']) for (const servico of ['srv-daif418ae00c73e8k2gg', undefined]) {
    const d = destino(id);
    try { const r = sessao(d, gerar(id, d, 'APLICAR', 'echo APLICADOR_RODOU'), {servico, env: {KIDMAIS_REGISTRO_BACKUP: BACKUP}});
      assert.equal(r.status, 0); assert.match(r.saida, /^SHELL_ERRADO_NAO_E_PRODUCAO/m);
      assert.doesNotMatch(r.saida, /CODIGO_SAIDA_BLOCO|APLICADOR_RODOU|ARQUIVOS_CONFERIDOS/);
    } finally { limpar(d); }
  }
});

test('arquivo implantado divergente ou ausente: código 4 antes de rodar o aplicador', () => {
  for (const id of ['117', '120']) for (const alterar of b.arquivos(id)) for (const modo of ['remover', 'alterar']) {
    const d = destino(id);
    try { if (modo === 'remover') fs.rmSync(path.join(d, alterar)); else fs.appendFileSync(path.join(d, alterar), '\n// alterado');
      const r = sessao(d, gerar(id, d, 'CONFERIR', 'echo APLICADOR_RODOU'));
      assert.equal(codigo(r.saida), 4, r.saida.slice(-300)); assert.match(r.saida, new RegExp('^ARQUIVO_DIVERGENTE_OU_AUSENTE ' + alterar.replace(/\./g, '\\.') + '$', 'm'));
      assert.doesNotMatch(r.saida, /APLICADOR_RODOU|=== REGISTRO/);
    } finally { limpar(d); }
  }
});

test('arquivos conferidos: o código do aplicador (0/1/2/3) vira CODIGO_SAIDA_BLOCO e o registro é listado', () => {
  for (const id of ['112', '115']) for (const esperado of [0, 1, 2, 3]) {
    const d = destino(id);
    try { const r = sessao(d, gerar(id, d, 'CONFERIR', `node -e "process.exitCode=${esperado}"`));
      assert.equal(codigo(r.saida), esperado, r.saida.slice(-300)); assert.match(r.saida, /^ARQUIVOS_CONFERIDOS$/m); assert.equal(linhas(r.saida, /^=== REGISTRO /), 1);
    } finally { limpar(d); }
  }
});

test('aplicador REAL de cada passo pelo bloco: sem RENDER/DATABASE_URL recusa antes de conectar (código 1), em CONFERIR e APLICAR; nada gravado', () => {
  for (const id of b.IDS) {
    const d = destino(id, {modulos: true});
    try {
      const r = sessao(d, gerar(id, d, 'CONFERIR'));
      assert.equal(codigo(r.saida), 1, id + r.saida.slice(-400)); assert.match(r.saida, /RECUSADO FORA_DO_RENDER/, id);
      const a = sessao(d, gerar(id, d, 'APLICAR'), {env: {KIDMAIS_REGISTRO_BACKUP: BACKUP}});
      assert.equal(codigo(a.saida), 1, id + a.saida.slice(-400)); assert.match(a.saida, /RECUSADO FORA_DO_RENDER/, id);
      assert.equal(fs.existsSync(path.join(d, 'data')), false, id + ': nada gravado');
    } finally { limpar(d); }
  }
});

test('APLICAR sem KIDMAIS_REGISTRO_BACKUP (ou com valor inseguro ou multilinha): código 4 sem rodar o aplicador', () => {
  for (const id of ['116', '121']) {
    for (const env of [{}, {KIDMAIS_REGISTRO_BACKUP: ''}, {KIDMAIS_REGISTRO_BACKUP: 'x;rm -rf /'}, {KIDMAIS_REGISTRO_BACKUP: 'curto'}, {KIDMAIS_REGISTRO_BACKUP: BACKUP + '\nx;rm'}]) {
      const d = destino(id);
      try { const r = sessao(d, gerar(id, d, 'APLICAR', 'echo APLICADOR_RODOU'), {env});
        assert.equal(codigo(r.saida), 4, JSON.stringify(env) + r.saida.slice(-300)); assert.match(r.saida, /^BACKUP_NAO_INFORMADO /m); assert.doesNotMatch(r.saida, /APLICADOR_RODOU/);
      } finally { limpar(d); }
    }
    const d = destino(id);
    try { const r = sessao(d, gerar(id, d, 'APLICAR', 'echo "APLICADOR_RODOU backup=$KIDMAIS_REGISTRO_BACKUP"'), {env: {KIDMAIS_REGISTRO_BACKUP: BACKUP}});
      assert.equal(codigo(r.saida), 0); assert.match(r.saida, new RegExp('^APLICADOR_RODOU backup=' + BACKUP + '$', 'm'));
    } finally { limpar(d); }
  }
});

test('destino inacessível: código 4 com DESTINO_INACESSIVEL (nunca 1, que é do aplicador)', () => {
  const d = destino('110');
  try { const r = sessao(d, b.gerar({id: '110', modo: 'CONFERIR', rotulo: '0123abcd', destino: posix(path.join(d, 'nao-existe')), comando: 'echo X'}));
    assert.equal(codigo(r.saida), 4, r.saida); assert.match(r.saida, /^DESTINO_INACESSIVEL$/m);
  } finally { limpar(d); }
});

test('colagem interativa (bash -i): o shell do operador sobrevive, sem errexit/umask/cd/variáveis herdados; código legível 0/1/2/3/4', () => {
  const POS = ['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"', 'echo "VAR_HERDADA=${codigo-ausente}/${B-ausente}"', 'cat arquivo-que-nao-existe-no-teste', 'echo SHELL_DO_OPERADOR_VIVO'].join('\n') + '\n';
  for (const id of ['114', '111']) for (const [rotulo, modo, comando, prep, env, esperado] of [
    ['sucesso', 'CONFERIR', 'node -e "process.exitCode=0"', null, {}, 0], ['recusa do aplicador', 'CONFERIR', 'node -e "process.exitCode=1"', null, {}, 1],
    ['falha', 'APLICAR', 'node -e "process.exitCode=2"', null, {KIDMAIS_REGISTRO_BACKUP: BACKUP}, 2],
    ['recusaria', 'CONFERIR', 'node -e "process.exitCode=3"', null, {}, 3], ['recusa do bloco', 'CONFERIR', 'echo X', d => fs.rmSync(path.join(d, b.PASSOS[id].revisados[0][0])), {}, 4],
    ['sem backup', 'APLICAR', 'echo X', null, {}, 4]]) {
    const d = destino(id);
    try { if (prep) prep(d);
      const inicio = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n', {interativo: true, env}).saida;
      const r = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n' + gerar(id, d, modo, comando) + POS, {interativo: true, env});
      assert.equal(codigo(r.saida), esperado, rotulo + ': ' + r.saida.slice(-400));
      assert.match(r.saida, /^SHELL_DO_OPERADOR_VIVO$/m, rotulo + ': o shell não pode cair no erro seguinte');
      const antes = /^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(inicio), pos = /^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
      assert.ok(antes && pos, rotulo); assert.equal(pos[1], antes[1], rotulo + ': opções'); assert.equal(pos[2], antes[2], rotulo + ': umask'); assert.equal(pos[3].trim(), antes[3].trim(), rotulo + ': diretório');
      assert.match(r.saida, /^VAR_HERDADA=ausente\/ausente$/m, rotulo + ': variáveis do corpo não vazam');
    } finally { limpar(d); }
  }
});

test('colagem interativa: CONFERIR e depois APLICAR na mesma sessão — dois códigos legíveis, shell vivo', () => {
  const d = destino('120');
  try { const r = sessao(d, gerar('120', d, 'CONFERIR', 'node -e "process.exitCode=0"') + `export KIDMAIS_REGISTRO_BACKUP="${BACKUP}"\n`
      + gerar('120', d, 'APLICAR', 'node -e "process.exitCode=0"') + 'echo DUAS_COLAGENS_OK\n', {interativo: true});
    assert.equal(linhas(r.saida, /^CODIGO_SAIDA_BLOCO=0$/), 2, r.saida.slice(-400)); assert.match(r.saida, /^DUAS_COLAGENS_OK$/m);
  } finally { limpar(d); }
});
