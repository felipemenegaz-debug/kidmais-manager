/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell de produção (19/10/2026), divididos em partes ≤ 40 KB (P3-3 da revisão independente): executados DE
// VERDADE com bash num deploy temporário (só as pastas diferem das de produção; o comando do aplicador é omitido, trocado
// por um substituto que só devolve um código, ou roda o plano offline do próprio aplicador a partir da pasta própria).
// Inclui colagem interativa (bash -i) e colagem truncada. Não toca banco nem /opt.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const b = require('./bloco-shell-migracoes-producao-20261019.cjs');
const root = path.resolve(__dirname, '..');
const lf = a => fs.readFileSync(path.join(root, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const posix = p => p.replace(/\\/g, '/');
const ARQ = b.arquivos(root);
const {partes: PARTES, lista: LISTA} = b.distribuir(root);
const N = PARTES.length;
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
const todasAsPartes = d => Array.from({length: N}, (_, i) => gerar(d, `PARTE-${i + 1}`)).join('');
const rodar = (d, modo, comando, opcoes) => sessao(d, gerar(d, modo, comando), opcoes);
const codigos = s => [...s.matchAll(/^CODIGO_SAIDA_BLOCO=(\d+)$/gm)].map(x => Number(x[1]));
const codigo = s => codigos(s).at(-1);
const linhas = (s, re) => s.split(/\r?\n/).filter(l => re.test(l)).length;
const presentes = d => ARQ.filter(a => fs.existsSync(path.join(d, PASTA, a)));
const partesPresentes = d => { try { return fs.readdirSync(path.join(d, PASTA, '.partes')).length; } catch { return 0; } };
const registroOk = d => posix(path.join(d, 'data/lancamento-venda-20261011/backup-teste.json'));
const temporarios = d => fs.readdirSync(path.join(d, 'tmp')).length;
const intactoDoDeploy = d => fs.readFileSync(path.join(d, 'database/checks/20261018_084_postcheck.sql'), 'utf8') === '-- do deploy\r\n';

test('arquivos: 43 (aplicador, 2 manifestos, aplicador e trava do lançamento, 38 SQL); cada um em exatamente uma parte; todo bloco ≤ 40 KB', () => {
  assert.equal(ARQ.length, 43); assert.equal(new Set(ARQ).size, 43);
  assert.deepEqual(PARTES.flatMap(p => p.itens.map(x => x.arquivo)), ARQ);
  assert.deepEqual(b.modos(root), [...PARTES.map((_, i) => `PARTE-${i + 1}`), 'CONFERIR', 'APLICAR', 'RETOMAR', 'LIMPEZA']);
  assert.equal(b.totalPartes(root), N);
  for (const modo of b.modos(root)) { const x = b.gerar({modo, rotulo: 'abcdef1'}); assert.ok(Buffer.byteLength(x) <= 40000, modo + ' ' + Buffer.byteLength(x)); }
  assert.throws(() => b.gerar({modo: 'X', rotulo: 'abcdef1'}), /MODO_DESCONHECIDO/);
  assert.throws(() => b.gerar({modo: `PARTE-${N + 1}`, rotulo: 'abcdef1'}), /MODO_DESCONHECIDO/);
  assert.throws(() => b.gerar({modo: 'CONFERIR', rotulo: 'abc; rm -rf /'}), /ROTULO_INVALIDO/);
});

test('blocos oficiais: ASCII, guarda de produção antes de tudo, subshell, código impresso, instrução do prompt ">", comando só nos curtos', () => {
  for (const modo of b.modos(root)) {
    const x = b.gerar({modo, rotulo: 'abcdef1'});
    assert.match(x, /^[\x09\x0a\x20-\x7e]*$/); assert.equal(Buffer.byteLength(x, 'utf8'), x.length);
    const L = x.split('\n'), i = L.findIndex(l => l.startsWith('if [ "$RENDER_SERVICE_ID" != "srv-dak77m2d0e5s73b8rkkg" ]'));
    assert.ok(i > 0 && L.slice(0, i).every(l => l.startsWith('#') || l.startsWith('bind ')), modo);
    assert.equal(L[i + 1], '('); assert.ok(L.includes(')') && L.includes('echo "CODIGO_SAIDA_BLOCO=$?"') && L.at(-2) === 'fi');
    assert.doesNotMatch(x, /DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\//);
    assert.match(x, /Ctrl-C, nunca colar por cima/);
    if (modo.startsWith('PARTE')) assert.doesNotMatch(x, /^NODE_PATH|node scripts\//m);
  }
  assert.match(b.gerar({modo: 'CONFERIR', rotulo: 'abcdef1'}), /^NODE_PATH='\/opt\/render\/project\/src\/node_modules' node scripts\/migrations-producao-20261019\.cjs --conferir \|\| codigo=\$\?$/m);
  const ap = b.gerar({modo: 'APLICAR', rotulo: 'abcdef1'});
  assert.match(ap, /^NODE_PATH='\/opt\/render\/project\/src\/node_modules' node scripts\/migrations-producao-20261019\.cjs --aplicar-autorizado --backup "\$KIDMAIS_REGISTRO_BACKUP" \|\| codigo=\$\?$/m);
  assert.ok(ap.indexOf('KIDMAIS_REGISTRO_BACKUP:-') < ap.indexOf("cd '/opt/render/project/src'"), 'registro conferido antes de tocar arquivos');
  assert.doesNotMatch(b.gerar({modo: 'LIMPEZA', rotulo: 'abcdef1'}), /^NODE_PATH|^node |B64|KIDMAIS_REGISTRO_BACKUP/m);
});

test('shell de outro serviço (staging) ou sem RENDER_SERVICE_ID não executa nada, em nenhum bloco', () => {
  for (const servico of ['srv-daif418ae00c73e8k2gg', undefined]) {
    const d = deploy();
    try {
      for (const modo of ['PARTE-1', 'CONFERIR', 'APLICAR', 'LIMPEZA']) {
        const r = rodar(d, modo, null, {servico, registro: registroOk(d)}); assert.equal(r.status, 0); assert.match(r.saida, /^SHELL_ERRADO_NAO_E_PRODUCAO/m, modo);
        assert.doesNotMatch(r.saida, /CODIGO_SAIDA_BLOCO/);
      }
      assert.ok(!fs.existsSync(path.join(d, PASTA)));
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

test('APLICAR sem registro de backup, fora da pasta do P1, com metacaractere ou inexistente: código 4 antes de gravar', () => {
  for (const [registro, erro] of [[undefined, /^REGISTRO_BACKUP_AUSENTE/m], ['/tmp/backup-a.json', /^REGISTRO_BACKUP_INVALIDO$/m],
    [null, /^REGISTRO_BACKUP_INVALIDO$/m], ['naoexiste', /^REGISTRO_BACKUP_NAO_ENCONTRADO$/m]]) {
    const d = deploy();
    try {
      const reg = registro === null ? posix(path.join(d, 'data/lancamento-venda-20261011/backup-$(id).json')) : registro === 'naoexiste' ? posix(path.join(d, 'data/lancamento-venda-20261011/backup-outro.json')) : registro;
      const r = sessao(d, todasAsPartes(d) + gerar(d, 'APLICAR', 'node -e "process.exitCode=0"'), {registro: reg});
      assert.equal(codigo(r.saida), 4, r.saida.slice(-300)); assert.match(r.saida, erro); assert.deepEqual(presentes(d), []);
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

test('RETOMAR: id fora da lista (079, 084, vazio, metacaractere) = 4 antes de gravar; id válido roda --retomar-autorizado com o id e o registro', () => {
  const r0 = b.gerar({modo: 'RETOMAR', rotulo: 'abcdef1'});
  assert.match(r0, /--retomar-autorizado "\$KIDMAIS_RETOMAR_ID" --backup "\$KIDMAIS_REGISTRO_BACKUP" \|\| codigo=\$\?$/m);
  assert.ok(r0.indexOf('KIDMAIS_RETOMAR_ID:-') < r0.indexOf("cd '/opt/render/project/src'"));
  for (const id of [undefined, '079', '084', '076;id', '07']) {
    const d = deploy();
    try {
      const f = d + '-ret.sh'; fs.writeFileSync(f, (id === undefined ? '' : `KIDMAIS_RETOMAR_ID='${id}'\n`) + gerar(d, 'RETOMAR', 'node -e "process.exitCode=0"'));
      const env = {...process.env, RENDER_SERVICE_ID: b.SERVICO, KIDMAIS_REGISTRO_BACKUP: registroOk(d), TMPDIR: posix(path.join(d, 'tmp'))}; delete env.KIDMAIS_RETOMAR_ID;
      const r = spawnSync('bash', [f], {encoding: 'utf8', env}); fs.rmSync(f, {force: true});
      assert.equal(codigo(r.stdout), 4, String(id)); assert.match(r.stdout, /^RETOMAR_ID_INVALIDO/m); assert.ok(!fs.existsSync(path.join(d, PASTA)));
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const f = d + '-ret.sh'; fs.writeFileSync(f, "KIDMAIS_RETOMAR_ID='076'\n" + gerar(d, 'RETOMAR', 'node -e "console.log(\'ARGS\', process.argv.slice(1).join(\' \'))" -- "$KIDMAIS_RETOMAR_ID" "$KIDMAIS_REGISTRO_BACKUP"'));
    const env = {...process.env, RENDER_SERVICE_ID: b.SERVICO, KIDMAIS_REGISTRO_BACKUP: registroOk(d), TMPDIR: posix(path.join(d, 'tmp'))};
    const r = spawnSync('bash', [f], {encoding: 'utf8', env}); fs.rmSync(f, {force: true});
    assert.equal(codigo(r.stdout), 0, r.stdout.slice(-300)); assert.match(r.stdout, new RegExp('^ARGS 076 ' + registroOk(d).replace(/[.]/g, '\\.') + '$', 'm'));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('sem o pg implantado: CONFERIR = 4 antes de montar (as partes não dependem do pg)', () => {
  const d = deploy({pg: false});
  try {
    const p = sessao(d, todasAsPartes(d)); assert.deepEqual(codigos(p.saida), Array(N).fill(0));
    const r = rodar(d, 'CONFERIR'); assert.equal(codigo(r.saida), 4); assert.match(r.saida, /DEPENDENCIA_AUSENTE node_modules\/pg/); assert.deepEqual(presentes(d), []);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('montagem só com TODAS as partes: sem partes ou faltando uma, CONFERIR diz qual colar e não monta nada', () => {
  const d = deploy();
  try {
    const r0 = rodar(d, 'CONFERIR', 'node -e "process.exitCode=0"'); assert.equal(codigo(r0.saida), 4); assert.match(r0.saida, /^MONTAGEM_RECUSADA/m);
    assert.equal(linhas(r0.saida, /^PARTE_AUSENTE_OU_DIVERGENTE /), 43); assert.deepEqual(presentes(d), []);
    const sem2 = Array.from({length: N}, (_, i) => i === 1 ? '' : gerar(d, `PARTE-${i + 1}`)).join('');
    sessao(d, sem2);
    const r1 = rodar(d, 'CONFERIR', 'node -e "process.exitCode=0"'); assert.equal(codigo(r1.saida), 4);
    assert.equal(linhas(r1.saida, /^PARTE_AUSENTE_OU_DIVERGENTE .* \(colar a PARTE-2\)$/), PARTES[1].itens.length);
    assert.equal(linhas(r1.saida, /^PARTE_AUSENTE_OU_DIVERGENTE /), PARTES[1].itens.length); assert.deepEqual(presentes(d), []);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('fluxo completo: partes (repetir = JA_PRESENTE) → CONFERIR monta 43 → APLICAR → LIMPEZA remove 43 + partes e a pasta; deploy e disco intactos', () => {
  const d = deploy();
  try {
    const p = sessao(d, todasAsPartes(d)); assert.deepEqual(codigos(p.saida), Array(N).fill(0), p.saida.slice(-300));
    assert.equal(linhas(p.saida, /^TRANSPORTADO /), 43); assert.equal(partesPresentes(d), new Set(LISTA.map(x => x.sha)).size);
    const p2 = rodar(d, 'PARTE-3'); assert.equal(codigo(p2.saida), 0); assert.equal(linhas(p2.saida, /^JA_PRESENTE /), PARTES[2].itens.length);
    const r = rodar(d, 'CONFERIR', 'node -e "process.exitCode=0"'); assert.equal(codigo(r.saida), 0, r.saida.slice(-400)); assert.match(r.saida, /ARQUIVOS_OK 43/);
    for (const a of ARQ) assert.equal(fs.readFileSync(path.join(d, PASTA, a), 'utf8'), lf(a), a);
    const r2 = rodar(d, 'APLICAR', 'node -e "process.exitCode=0"', {registro: registroOk(d)}); assert.equal(codigo(r2.saida), 0); assert.equal(linhas(r2.saida, /^JA_PRESENTE /), 43);
    assert.equal(temporarios(d), 0); assert.ok(intactoDoDeploy(d));
    const l = rodar(d, 'LIMPEZA'); assert.equal(codigo(l.saida), 0, l.saida.slice(-300)); assert.equal(linhas(l.saida, /^REMOVIDO /), 43 + 43);
    assert.match(l.saida, /^PASTA_REMOVIDA$/m); assert.ok(!fs.existsSync(path.join(d, PASTA))); assert.ok(intactoDoDeploy(d));
    assert.ok(fs.existsSync(path.join(d, 'data/lancamento-venda-20261011/backup-teste.json')), 'disco persistente intocado');
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('pacote montado é completo e executável da pasta própria: plano offline confere manifesto e 38 hashes; --conferir fora do Render = 1', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const r = rodar(d, 'CONFERIR', `NODE_PATH='${posix(d)}/node_modules' node scripts/migrations-producao-20261019.cjs --plano > plano.json && node -e "const p=require('./plano.json');if(p.resultado!=='PLANO'||p.sequencia.length!==15)process.exit(9)" && rm -f plano.json`);
    assert.equal(codigo(r.saida), 0, r.saida.slice(-500));
    const r2 = rodar(d, 'CONFERIR', `NODE_PATH='${posix(d)}/node_modules' node scripts/migrations-producao-20261019.cjs --conferir`);
    assert.equal(codigo(r2.saida), 1, r2.saida.slice(-300)); assert.match(r2.saida, /RECUSADO FORA_DO_RENDER/);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('arquivo presente e diferente na pasta própria: código 4 sem montar os demais; LIMPEZA preserva o divergente', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const alvo = path.join(d, PASTA, 'database/migrations/20261018_086_marketing_automacoes.sql'); fs.mkdirSync(path.dirname(alvo), {recursive: true}); fs.writeFileSync(alvo, '-- outro\n');
    const r = rodar(d, 'CONFERIR', 'node -e "process.exitCode=0"'); assert.equal(codigo(r.saida), 4);
    assert.match(r.saida, /JA_EXISTE_DIFERENTE database\/migrations\/20261018_086_marketing_automacoes\.sql/);
    assert.deepEqual(presentes(d), ['database/migrations/20261018_086_marketing_automacoes.sql']);
    const l = rodar(d, 'LIMPEZA'); assert.match(l.saida, /DIVERGENTE_PRESERVADO database\/migrations\/20261018_086/); assert.match(l.saida, /^PASTA_MANTIDA/m); assert.ok(fs.existsSync(alvo));
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('parte já presente e adulterada: colar a parte = 4 PARTE_EXISTE_DIFERENTE; CONFERIR acusa e não monta', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d));
    const x = PARTES[0].itens[0]; fs.writeFileSync(path.join(d, PASTA, '.partes', x.sha), 'adulterado');
    const p = rodar(d, 'PARTE-1'); assert.equal(codigo(p.saida), 4); assert.match(p.saida, new RegExp('^PARTE_EXISTE_DIFERENTE ' + x.sha + '$', 'm'));
    const r = rodar(d, 'CONFERIR', 'node -e "process.exitCode=0"'); assert.equal(codigo(r.saida), 4);
    assert.match(r.saida, new RegExp('^PARTE_AUSENTE_OU_DIVERGENTE ' + x.arquivo.replace(/[.]/g, '\\.') + ' \\(colar a PARTE-1\\)$', 'm')); assert.deepEqual(presentes(d), []);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('conteúdo corrompido numa parte (base64/gzip ou sha): 4 CONTEUDO_DIVERGENTE antes de gravar qualquer arquivo daquela parte', () => {
  for (const corromper of [l => l.replace(/^./, c => c === 'A' ? 'B' : 'A'), l => '!!!' + l.slice(3)]) {
    const d = deploy();
    try {
      const L = gerar(d, 'PARTE-2').split('\n'), i = L.findIndex(x => x.startsWith('prep ')) + 1; L[i] = corromper(L[i]);
      const r = sessao(d, L.join('\n')); assert.equal(codigo(r.saida), 4, r.saida.slice(-300));
      assert.match(r.saida, new RegExp('^CONTEUDO_DIVERGENTE ' + PARTES[1].itens[0].arquivo.replace(/[.]/g, '\\.') + '$', 'm')); assert.equal(partesPresentes(d), 0);
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

test('colagem truncada (25/50/90/99,9 %) de uma parte ou do APLICAR: nada gravado nem executado; linhas perdidas no meio: nada gravado', () => {
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d).replace(gerar(d, 'PARTE-2'), ''));
    for (const modo of ['PARTE-2', 'APLICAR']) {
      const x = gerar(d, modo, 'node -e "process.exitCode=0"');
      for (const fr of [0.25, 0.5, 0.9, 0.999]) {
        const r = sessao(d, x.slice(0, Math.floor(x.length * fr)), {registro: registroOk(d)});
        assert.equal(codigos(r.saida).length, 0, `${modo} ${fr}`); assert.deepEqual(presentes(d), []);
        assert.equal(partesPresentes(d), new Set(LISTA.filter(y => y.parte !== 2).map(y => y.sha)).size, `${modo} ${fr}: nenhuma parte nova`);
      }
    }
    const L = gerar(d, 'PARTE-2').split('\n'), meio = L.findIndex(l => l.startsWith('prep ')) - 2; L.splice(meio, 3);
    const r = sessao(d, L.join('\n')); assert.notEqual(codigo(r.saida), 0); assert.equal(partesPresentes(d), new Set(LISTA.filter(y => y.parte !== 2).map(y => y.sha)).size);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('colagem interativa (bash -i): shell do operador sobrevive, sem opções/umask/cwd/trap herdados; códigos 0/1/2/3/4 legíveis', () => {
  const POS = ['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"', 'trap -p EXIT', 'cat arquivo-que-nao-existe-no-teste', 'echo SHELL_DO_OPERADOR_VIVO'].join('\n') + '\n';
  for (const [rotulo, modo, comando, opcoes, esperado] of [['conferido', 'CONFERIR', 'node -e "process.exitCode=0"', {}, 0], ['recusa antes de conectar', 'CONFERIR', 'node -e "process.exitCode=1"', {}, 1],
    ['falha', 'APLICAR', 'node -e "process.exitCode=2"', {registro: true}, 2], ['recusaria', 'CONFERIR', 'node -e "process.exitCode=3"', {}, 3], ['sem registro', 'APLICAR', 'node -e "process.exitCode=0"', {}, 4]]) {
    const d = deploy();
    try {
      const op = {interativo: true, ...(opcoes.registro ? {registro: registroOk(d)} : {})};
      const inicio = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n', op).saida;
      const r = sessao(d, 'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n' + todasAsPartes(d) + gerar(d, modo, comando) + POS, op);
      assert.deepEqual(codigos(r.saida), [...Array(N).fill(0), esperado], rotulo + ': ' + r.saida.slice(-400)); assert.match(r.saida, /^SHELL_DO_OPERADOR_VIVO$/m, rotulo);
      const a = /^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(inicio), p = /^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
      assert.ok(a && p, rotulo); assert.equal(p[1], a[1]); assert.equal(p[2], a[2]); assert.equal(p[3].trim(), a[3].trim());
      assert.doesNotMatch(r.saida, /trap -- .*EXIT/); assert.equal(temporarios(d), 0, rotulo);
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
});

const RM_FALSO = 'rm() { echo "rm falso: $*" >&2; return 1; }\n';
test('trap: falha do rm vira aviso TEMPORARIO_NAO_REMOVIDO e não muda o código (parte e APLICAR com 0/1/2/3 e sinal); LIMPEZA com rm falso = 4', () => {
  const d0 = deploy();
  try {
    const r = sessao(d0, RM_FALSO + gerar(d0, 'PARTE-1')); assert.equal(codigo(r.saida), 0); assert.equal(linhas(r.saida, /^TEMPORARIO_NAO_REMOVIDO /), 1);
  } finally { fs.rmSync(d0, {recursive: true, force: true}); }
  for (const [comando, esperado] of [['node -e "process.exitCode=0"', 0], ['node -e "process.exitCode=1"', 1], ['node -e "process.exitCode=2"', 2],
    ['node -e "process.exitCode=3"', 3], ["bash -c 'kill -TERM $$'", 143]]) {
    const d = deploy();
    try {
      sessao(d, todasAsPartes(d));
      const r = sessao(d, RM_FALSO + gerar(d, 'APLICAR', comando), {registro: registroOk(d)});
      assert.equal(codigo(r.saida), esperado, comando + ': ' + r.saida.slice(-300)); assert.equal(linhas(r.saida, /^=== REGISTROS /), 1);
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
  const d = deploy();
  try {
    sessao(d, todasAsPartes(d)); assert.equal(codigo(rodar(d, 'CONFERIR', 'node -e "process.exitCode=0"').saida), 0);
    const l = sessao(d, RM_FALSO + gerar(d, 'LIMPEZA')); assert.equal(codigo(l.saida), 4); assert.match(l.saida, /^REMOCAO_FALHOU scripts\/migrations-producao-20261019\.cjs$/m);
    assert.equal(presentes(d).length, 43);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('hashes dos blocos = hashes revisados dos manifestos (scripts e SQL LF)', () => {
  const x = b.gerar({modo: 'LIMPEZA', rotulo: 'abcdef1'});
  for (const a of ARQ) { assert.ok(x.includes(`limpar ${a} ${sha(lf(a))}`), a); assert.ok(x.includes(`limpar .partes/${sha(lf(a))} ${sha(lf(a))}`), a); }
});
